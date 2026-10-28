import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { listEntries, readEntryJson } from '../src/archive';
import { packFrom, parseEnderPack } from '../src/instance/enderPack';
import { detectPack, readPack, unpackInto } from '../src/instance/pack';

let directory;

const zip = async (name, build) => {
	const staging = join(directory, name);

	await mkdir(staging, { recursive: true });
	await build(staging);

	const archive = join(directory, `${name}.zip`);
	const process_ = Bun.spawn(['zip', '-qr', archive, '.'], { cwd: staging, stdout: 'ignore', stderr: 'ignore' });

	await process_.exited;

	return archive;
};

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), 'ender-pack-'));
});

afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe('pack detection reads the contents, not the extension', () => {
	test('a modrinth index makes it an mrpack', async () => {
		const path = await zip('mr', async staging => {
			await writeFile(join(staging, 'modrinth.index.json'), '{"dependencies":{"minecraft":"1.0"}}');
		});

		expect(await detectPack(path)).toBe('mrpack');
	});

	test('a curseforge manifest makes it a curseforge pack', async () => {
		const path = await zip('cf', async staging => {
			await writeFile(join(staging, 'manifest.json'), '{"minecraft":{"version":"1.0"}}');
		});

		expect(await detectPack(path)).toBe('curseforge');
	});

	test('bare jars make it a mods archive', async () => {
		const path = await zip('bare', async staging => {
			await writeFile(join(staging, 'a.jar'), 'x');
		});

		expect(await detectPack(path)).toBe('mods');
	});

	test('an archive with neither is refused', async () => {
		const path = await zip('nothing', async staging => {
			await writeFile(join(staging, 'readme.txt'), 'x');
		});

		await expect(detectPack(path)).rejects.toThrow('Not a modpack');
	});
});

describe('modrinth packs', () => {
	test('game version, loader and referenced files all come across', async () => {
		const path = await zip('full-mr', async staging => {
			await writeFile(
				join(staging, 'modrinth.index.json'),
				JSON.stringify({
					name: 'demo',
					dependencies: { minecraft: '26.3', 'fabric-loader': '0.19.5' },
					files: [
						{
							path: 'mods/thing.jar',
							hashes: { sha1: 'abc123' },
							downloads: ['https://example.com/thing.jar'],
						},
					],
				}),
			);
		});

		const pack = await readPack(path, {});

		expect(pack.manifest.minecraft).toBe('26.3');
		expect(pack.manifest.loader).toEqual({ type: 'fabric', version: '0.19.5' });
		expect(pack.manifest.mods).toEqual([
			{ source: 'url', url: 'https://example.com/thing.jar', file: 'thing.jar', checksum: 'sha1:abc123' },
		]);
	});

	test('a file unsupported on this side is left out', async () => {
		const path = await zip('env-mr', async staging => {
			await writeFile(
				join(staging, 'modrinth.index.json'),
				JSON.stringify({
					dependencies: { minecraft: '26.3' },
					files: [
						{ path: 'mods/c.jar', downloads: ['https://e/c.jar'], env: { client: 'required', server: 'unsupported' } },
						{ path: 'mods/s.jar', downloads: ['https://e/s.jar'], env: { client: 'unsupported', server: 'required' } },
					],
				}),
			);
		});

		expect((await readPack(path, { side: 'client' })).manifest.mods).toHaveLength(1);
		expect((await readPack(path, { side: 'server' })).manifest.mods[0].file).toBe('s.jar');
	});
});

describe('curseforge packs', () => {
	// CurseForge writes `<loader>-<version>`; Modrinth writes `fabric-loader`. Two key spaces.
	test('the loader id splits at the first dash, and the version may contain more', async () => {
		const path = await zip('cf-loader', async staging => {
			await writeFile(
				join(staging, 'manifest.json'),
				JSON.stringify({
					minecraft: { version: '1.21.1', modLoaders: [{ id: 'neoforge-21.1.5-beta', primary: true }] },
					files: [{ projectID: 238222, fileID: 555, required: true }],
				}),
			);
		});

		const pack = await readPack(path, {});

		expect(pack.manifest.loader).toEqual({ type: 'neoforge', version: '21.1.5-beta' });
		expect(pack.manifest.mods).toEqual([{ source: 'curseforge', id: '238222', version: '555' }]);
	});
});

describe('a bare mods archive cannot invent a version', () => {
	test('it says so rather than guessing', async () => {
		const path = await zip('bare2', async staging => {
			await writeFile(join(staging, 'a.jar'), 'x');
		});

		await expect(readPack(path, {})).rejects.toThrow('names no version');
	});

	test('and is happy once told', async () => {
		const path = await zip('bare3', async staging => {
			await writeFile(join(staging, 'a.jar'), 'x');
		});

		expect((await readPack(path, { minecraft: '26.3' })).manifest.minecraft).toBe('26.3');
	});
});

describe('archive reading', () => {
	test('lists entries and reads one back as json', async () => {
		const path = await zip('read', async staging => {
			await mkdir(join(staging, 'nested'), { recursive: true });
			await writeFile(join(staging, 'nested', 'data.json'), '{"ok":true}');
		});

		expect(await listEntries(path)).toContain('nested/data.json');
		expect(await readEntryJson(path, 'nested/data.json')).toEqual({ ok: true });
		expect(await readEntryJson(path, 'missing.json')).toBeUndefined();
	});
});

describe('an ender pack', () => {
	const pack = {
		name: 'Ship Life',
		minecraft: '26.3',
		loader: 'fabric',
		mods: ['gh:fatlard1993/big-boats', { spec: 'gh:fatlard1993/fence-posts', version: '3.0.1' }],
	};

	test('lists the mods it chose by spec, a version only where one is pinned, and says all that is wrong with it', () => {
		expect(parseEnderPack(JSON.stringify(pack)).mods).toEqual([
			{ spec: 'gh:fatlard1993/big-boats' },
			{ spec: 'gh:fatlard1993/fence-posts', version: '3.0.1' },
		]);
		expect(() => parseEnderPack({ loader: 'bukkit', mods: [{}] }, { file: 'x.json' })).toThrow(
			'x.json names no "minecraft" version; names no "loader" of fabric, quilt, forge, neoforge, vanilla; mods[0] is neither a spec nor { "spec": ... }',
		);
	});

	test("is an instance's chosen mods, and leaves out what only this machine can reach", () => {
		const { pack: written, left } = packFrom({
			name: 'Ship Life',
			minecraft: '26.3',
			loader: { type: 'fabric', version: '0.19.5' },
			mods: [
				{ source: 'github', id: 'fatlard1993/big-boats' },
				{ source: 'github', id: 'fatlard1993/fence-posts', version: '3.0.1' },
				{ source: 'modrinth', id: 'sodium' },
				{ source: 'local', path: '/home/me/mine.jar' },
			],
		});

		expect(written).toEqual({
			name: 'Ship Life',
			minecraft: '26.3',
			loader: 'fabric',
			mods: ['gh:fatlard1993/big-boats', { spec: 'gh:fatlard1993/fence-posts', version: '3.0.1' }, 'mr:sodium'],
		});
		expect(left).toEqual([{ source: 'local', path: '/home/me/mine.jar' }]);
	});

	test('is read from its file alone, its mods left as specs for the index to place', async () => {
		const path = join(directory, 'ender.pack.json');

		await writeFile(path, JSON.stringify(pack));

		expect(await detectPack(path)).toBe('ender');

		const read = await readPack(path, {});

		expect(read.manifest).toEqual({ name: 'Ship Life', minecraft: '26.3', loader: { type: 'fabric' }, mods: [] });
		expect(read.specs).toHaveLength(2);
	});

	test("in a repository's zip, carries the game's own files beside it, and not the repository's", async () => {
		const path = await zip('repo', async staging => {
			await mkdir(join(staging, 'ship-life-HEAD', 'config'), { recursive: true });
			await writeFile(join(staging, 'ship-life-HEAD', 'ender.pack.json'), JSON.stringify(pack));
			await writeFile(join(staging, 'ship-life-HEAD', 'config', 'boats.json'), '{}');
			await writeFile(join(staging, 'ship-life-HEAD', 'options.txt'), 'fov:0.5');
			await writeFile(join(staging, 'ship-life-HEAD', 'README.md'), '# Ship Life');
		});

		expect(await detectPack(path)).toBe('ender');

		const read = await readPack(path, {});
		const gameDir = join(directory, 'ship-life-game');

		expect((await unpackInto(path, read, gameDir)).sort()).toEqual(['config/boats.json', 'options.txt']);
	});
});

describe('a packwiz pack', () => {
	const toml = lines => lines.join('\n');

	test('becomes its mods, Modrinth and CurseForge ones kept updatable, and the game files beside it', async () => {
		const path = await zip('packwiz', async staging => {
			const root = join(staging, 'my-pack-HEAD');

			await mkdir(join(root, 'mods'), { recursive: true });
			await mkdir(join(root, 'config'), { recursive: true });
			await writeFile(
				join(root, 'pack.toml'),
				toml([
					'name = "My Pack"',
					'pack-format = "packwiz:1.1.0"',
					'[index]',
					'file = "index.toml"',
					'[versions]',
					'minecraft = "1.21.1"',
					'fabric = "0.16.5"',
				]),
			);
			await writeFile(
				join(root, 'index.toml'),
				toml([
					'hash-format = "sha256"',
					...['sodium', 'jei', 'lonely', 'server-only'].flatMap(mod => [
						'[[files]]',
						`file = "mods/${mod}.pw.toml"`,
						'metafile = true',
					]),
					'[[files]]',
					'file = "config/sodium.json"',
				]),
			);
			await writeFile(
				join(root, 'mods', 'sodium.pw.toml'),
				toml(['name = "Sodium"', 'side = "client"', '[update.modrinth]', 'mod-id = "AANobbMI"', 'version = "abc123"']),
			);
			await writeFile(
				join(root, 'mods', 'jei.pw.toml'),
				toml([
					'name = "JEI"',
					'[download]',
					'mode = "metadata:curseforge"',
					'[update.curseforge]',
					'project-id = 238222',
					'file-id = 5101365',
				]),
			);
			await writeFile(
				join(root, 'mods', 'lonely.pw.toml'),
				toml([
					'name = "Lonely"',
					'filename = "lonely-1.0.jar"',
					'[download]',
					'url = "https://example.invalid/lonely-1.0.jar"',
					'hash-format = "sha1"',
					'hash = "ABC"',
				]),
			);
			await writeFile(
				join(root, 'mods', 'server-only.pw.toml'),
				toml(['name = "Server"', 'side = "server"', '[update.modrinth]', 'mod-id = "srv"', 'version = "1"']),
			);
			await writeFile(join(root, 'config', 'sodium.json'), '{}');
			await writeFile(join(root, 'README.md'), '# My Pack');
		});

		expect(await detectPack(path)).toBe('packwiz');

		const read = await readPack(path, {});

		expect(read.manifest).toEqual({
			name: 'My Pack',
			minecraft: '1.21.1',
			loader: { type: 'fabric', version: '0.16.5' },
			mods: [
				{ source: 'modrinth', id: 'AANobbMI', version: 'abc123' },
				{ source: 'curseforge', id: '238222', version: '5101365' },
				{ source: 'url', url: 'https://example.invalid/lonely-1.0.jar', file: 'lonely-1.0.jar', checksum: 'sha1:ABC' },
			],
		});
		expect(await unpackInto(path, read, join(directory, 'packwiz-game'))).toEqual(['config/sodium.json']);
	});

	test('takes a CurseForge mod from Modrinth where Modrinth has the very same file, and says how many', async () => {
		const { preferModrinth } = await import('../src/instance/pack');
		const mods = [
			{ source: 'curseforge', id: '238222', version: '5101365', checksum: 'sha1:aaa' },
			{ source: 'curseforge', id: '1', version: '2', checksum: 'sha1:bbb' },
			{ source: 'curseforge', id: '3', version: '4' },
			{ source: 'modrinth', id: 'AANobbMI', version: 'abc123' },
		];
		const asked = [];
		const moved = await preferModrinth(mods, {
			byHash: async hashes => {
				asked.push(...hashes);

				return new Map([['aaa', { project: 'u6dRKJwZ', version: 'v1' }]]);
			},
		});

		expect(asked).toEqual(['aaa', 'bbb']);
		expect(moved).toBe(1);
		expect(mods.map(mod => `${mod.source}:${mod.id}`)).toEqual([
			'modrinth:u6dRKJwZ',
			'curseforge:1',
			'curseforge:3',
			'modrinth:AANobbMI',
		]);
		expect(
			await preferModrinth(mods, {
				byHash: async () => {
					throw new Error('offline');
				},
			}),
		).toBe(0);
	});

	test('whose index lists no mods, as packwiz leaves it until refreshed, has the mod files beside it read', async () => {
		const path = await zip('packwiz-stale', async staging => {
			await mkdir(join(staging, 'mods'), { recursive: true });
			await writeFile(
				join(staging, 'pack.toml'),
				toml(['name = "Stale"', '[versions]', 'minecraft = "1.18.2"', 'fabric = "0.18.4"']),
			);
			await writeFile(join(staging, 'index.toml'), 'hash-format = "sha256"\n');
			await writeFile(
				join(staging, 'mods', 'create.pw.toml'),
				toml(['name = "Create"', '[update.curseforge]', 'project-id = 328085', 'file-id = 1']),
			);
		});

		expect((await readPack(path, {})).manifest.mods).toEqual([{ source: 'curseforge', id: '328085', version: '1' }]);
	});
});

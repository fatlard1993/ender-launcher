import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { listEntries, readEntryJson } from '../src/archive';
import { detectPack, readPack } from '../src/instance/pack';

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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { zipped } from './jars';

let home;
let previousHome;

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), 'ender-pack-source-'));
	previousHome = process.env.ENDER_HOME;
	process.env.ENDER_HOME = home;
});

afterAll(async () => {
	if (previousHome === undefined) delete process.env.ENDER_HOME;
	else process.env.ENDER_HOME = previousHome;
	await rm(home, { recursive: true, force: true });
});

describe('where a pack is read from again', () => {
	test('names a gist by its id, whichever of its links was given, so an update reads its newest revision', async () => {
		const { gistOf, sourceOf } = await import('../src/commands/packSource');
		const id = 'aa5e1f0c9b2d4e6f8a1b3c5d7e9f0a2b';

		for (const given of [
			`gist:${id}`,
			`gist:fatlard1993/${id}`,
			`https://gist.github.com/fatlard1993/${id}`,
			`https://gist.githubusercontent.com/fatlard1993/${id}/raw/0123abcd/ender.pack.json`,
		]) {
			expect(sourceOf(given)).toBe(`gist:${id}`);
		}

		expect(gistOf('https://example.invalid/pack.json')).toBeUndefined();
		expect(sourceOf('gh:me/pack')).toBe('gh:me/pack');
		expect(sourceOf('pack.json')).toBe(join(process.cwd(), 'pack.json'));
	});
});

describe('updating from a pack', () => {
	const write = async (path, pack) => Bun.write(path, JSON.stringify(pack));

	test('takes what the pack names now as it pins it, drops what it dropped, and keeps what was added beside it', async () => {
		const { refreshFromPack } = await import('../src/commands/packSource');
		const file = join(home, 'ender.pack.json');
		const manifest = {
			name: 'family',
			type: 'client',
			minecraft: '1.21.1',
			loader: { type: 'vanilla' },
			gameDir: join(home, 'game'),
			mods: [
				{ source: 'github', id: 'a/one' },
				{ source: 'github', id: 'a/two', version: '1.0' },
				{ source: 'github', id: 'me/mine' },
				{ source: 'github', id: 'me/extra' },
			],
			pack: { source: file, mods: ['github:a/one', 'github:a/two'] },
		};

		await write(file, {
			minecraft: '1.21.1',
			loader: 'vanilla',
			mods: [{ spec: 'gh:a/two', version: '2.0' }, 'gh:a/three', 'gh:me/mine'],
		});

		expect(await refreshFromPack(manifest, {})).toEqual({
			added: ['github:a/three', 'github:me/mine'],
			dropped: ['github:a/one'],
		});
		expect(manifest.mods).toEqual([
			{ source: 'github', id: 'a/two', version: '2.0' },
			{ source: 'github', id: 'a/three' },
			{ source: 'github', id: 'me/mine' },
			{ source: 'github', id: 'me/extra' },
		]);
		expect(manifest.pack.mods).toEqual(['github:a/two', 'github:a/three', 'github:me/mine']);

		await write(file, { minecraft: '1.21.4', loader: 'vanilla', mods: ['gh:a/two'] });

		const moved = await refreshFromPack(manifest, {});

		expect(moved.moved).toBe('Minecraft 1.21.4, vanilla');
		expect(manifest.minecraft).toBe('1.21.4');
	});

	test("moves to a loader the pack pins, follows its memory until a player sets their own, and keeps a player's choices", async () => {
		const { refreshFromPack } = await import('../src/commands/packSource');
		const file = join(home, 'pinned.pack.json');
		const manifest = {
			name: 'pinned',
			type: 'client',
			minecraft: '1.21.1',
			loader: { type: 'fabric', version: '0.16.0' },
			mods: [{ source: 'modrinth', id: 'zoom', optional: true }],
			chosen: [],
			pack: { source: file, mods: ['modrinth:zoom'], memory: 4096 },
			memory: { min: 512, max: 4096 },
		};

		await write(file, {
			minecraft: '1.21.1',
			loader: 'fabric',
			loaderVersion: '0.16.9',
			memory: 6144,
			version: '2.0',
			author: 'Ada',
			mods: [
				{ spec: 'mr:zoom', optional: true, default: true },
				{ spec: 'mr:minimap', optional: true, default: true },
			],
			resourcepacks: ['mr:faithful-32x'],
		});

		const changes = await refreshFromPack(manifest, {});

		expect(changes.moved).toBe('fabric 0.16.9');
		expect(manifest.loader).toEqual({ type: 'fabric', version: '0.16.9' });
		expect(manifest.memory).toEqual({ min: 512, max: 6144 });
		// zoom was offered before and left off by the player; minimap is new, and on by the pack's default
		expect(manifest.chosen).toEqual(['modrinth:minimap']);
		expect(manifest.resourcepacks).toEqual([{ source: 'modrinth', id: 'faithful-32x' }]);
		expect(manifest.pack).toMatchObject({ version: '2.0', author: 'Ada', memory: 6144 });

		manifest.memory = { min: 512, max: 8192 };
		await write(file, { minecraft: '1.21.1', loader: 'fabric', loaderVersion: '0.16.9', memory: 3072, mods: [] });
		await refreshFromPack(manifest, {});

		expect(manifest.memory).toEqual({ min: 512, max: 8192 });
		expect(manifest.pack).not.toHaveProperty('version');
	});

	test('follows a packwiz pack as it follows an ender pack: its mods, its loader version and its files', async () => {
		const { refreshFromPack } = await import('../src/commands/packSource');
		const packwiz = async (name, { fabric, mods, options }) => {
			const staging = join(home, name);

			await mkdir(join(staging, 'mods'), { recursive: true });
			await mkdir(join(staging, 'config'), { recursive: true });
			await writeFile(
				join(staging, 'pack.toml'),
				`name = "Wiz"\nversion = "${fabric}"\n[index]\nfile = "index.toml"\n[versions]\nminecraft = "1.21.1"\nfabric = "${fabric}"\n`,
			);
			await writeFile(
				join(staging, 'index.toml'),
				mods.map(mod => `[[files]]\nfile = "mods/${mod}.pw.toml"\nmetafile = true\n`).join(''),
			);

			for (const mod of mods) {
				await writeFile(
					join(staging, 'mods', `${mod}.pw.toml`),
					`name = "${mod}"\n[update.modrinth]\nmod-id = "${mod}"\nversion = "1"\n`,
				);
			}

			await writeFile(join(staging, 'config', 'options.json'), options);

			const archive = join(home, `${name}.zip`);

			await zipped(staging, archive);

			return archive;
		};
		const file = join(home, 'wiz.zip');
		const manifest = {
			name: 'wiz',
			type: 'client',
			minecraft: '1.21.1',
			loader: { type: 'fabric', version: '0.16.0' },
			gameDir: join(home, 'wiz-game'),
			mods: [{ source: 'modrinth', id: 'sodium', version: '1' }],
			pack: { source: file, mods: ['modrinth:sodium'] },
		};

		await Bun.write(
			file,
			Bun.file(await packwiz('wiz-1', { fabric: '0.16.9', mods: ['sodium', 'lithium'], options: 'two' })),
		);

		const changes = await refreshFromPack(manifest, {});

		expect(changes.added).toEqual(['modrinth:lithium']);
		expect(changes.moved).toBe('fabric 0.16.9');
		expect(changes.files.written).toEqual(['config/options.json']);
		expect(manifest.pack).toMatchObject({
			source: file,
			mods: ['modrinth:sodium', 'modrinth:lithium'],
			version: '0.16.9',
		});
	});

	test("following a pack gives an instance's own choices way to the pack's, unless kept, and following it again changes nothing", async () => {
		const { startFollowing } = await import('../src/commands/mods');
		const own = () => ({
			mods: [
				{ source: 'gradle', path: '/src/pandorical' },
				{ source: 'modrinth', id: 'sodium' },
			],
		});
		const manifest = own();

		expect(startFollowing(manifest, 'gist:abc')).toEqual(['gradle:/src/pandorical', 'modrinth:sodium']);
		expect(manifest).toEqual({ mods: [], pack: { source: 'gist:abc', mods: [] } });

		manifest.mods = [{ source: 'github', id: 'fatlard1993/pandorical' }];
		manifest.pack.mods = ['github:fatlard1993/pandorical'];

		expect(startFollowing(manifest, 'gist:abc')).toEqual([]);
		expect(manifest.mods).toHaveLength(1);

		const kept = own();

		expect(startFollowing(kept, 'gist:abc', { keep: true })).toEqual([]);
		expect(kept.mods).toHaveLength(2);
	});

	test("releases the pins set beside a pack on update, never the pack's own", async () => {
		const { releasePins } = await import('../src/commands/mods');
		const { mods, unpinned } = releasePins({
			mods: [
				{ source: 'github', id: 'a/two', version: '2.0' },
				{ source: 'github', id: 'me/extra', version: '0.3' },
			],
			pack: { mods: ['github:a/two'] },
		});

		expect(unpinned).toBe(1);
		expect(mods).toEqual([
			{ source: 'github', id: 'a/two', version: '2.0' },
			{ source: 'github', id: 'me/extra' },
		]);
	});

	test("says an update that only took the pack's new list did something", async () => {
		const { updatedLine } = await import('../src/commands/mods');

		expect(updatedLine({ changed: [], current: true })).toBe('Everything was already current');
		expect(updatedLine({ changed: [], current: false })).toBe("Updated to the pack's newest list");
		expect(updatedLine({ changed: [{}, {}], current: false })).toBe('2 mods updated');
	});
});

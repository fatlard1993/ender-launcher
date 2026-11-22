import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { enableResourcePacks, syncAssets } from '../src/mods/assets';
import { isWanted, takeChosen } from '../src/mods';

let gameDir;

beforeEach(async () => {
	gameDir = await mkdtemp(join(tmpdir(), 'ender-assets-'));
});

afterEach(async () => {
	await rm(gameDir, { recursive: true, force: true });
});

/** A resolver that names each entry's file after it, and a fetch that writes it, recording what was asked. */
const fakes = (unreachable = new Set()) => {
	const resolved = [];

	return {
		resolved,
		resolve: async (entry, context) => {
			resolved.push([entry.id, context.loader]);

			if (unreachable.has(entry.id)) throw new Error('offline');

			return { version: '1', file: { filename: `${entry.id}.zip`, url: `https://x/${entry.id}.zip` } };
		},
		fetchFile: async ({ path }) => {
			await mkdir(join(path, '..'), { recursive: true });
			await writeFile(path, 'zip');
		},
	};
};

describe("an instance's resource and shader packs", () => {
	test('are installed to their own folders for the game version alone, and the new ones turned on', async () => {
		const { resolve, fetchFile, resolved } = fakes();
		const manifest = {
			gameDir,
			resourcepacks: [{ source: 'modrinth', id: 'faithful' }],
			shaderpacks: [{ source: 'modrinth', id: 'complementary' }],
		};
		const result = await syncAssets({ manifest, lock: {}, context: { loader: 'fabric' }, resolve, fetchFile });

		expect(resolved).toEqual([
			['faithful', undefined],
			['complementary', undefined],
		]);
		expect(await readdir(join(gameDir, 'resourcepacks'))).toEqual(['faithful.zip']);
		expect(await readdir(join(gameDir, 'shaderpacks'))).toEqual(['complementary.zip']);
		expect(await Bun.file(join(gameDir, 'options.txt')).text()).toBe('resourcePacks:["vanilla","file/faithful.zip"]\n');
		expect(await Bun.file(join(gameDir, 'config', 'iris.properties')).text()).toContain('shaderPack=complementary.zip');
		expect(result.assets.resourcepacks).toEqual([
			{ key: 'modrinth:faithful', filename: 'faithful.zip', version: '1', url: 'https://x/faithful.zip' },
		]);
	});

	test("remove only what ender put there, leave a player's own, and keep one it cannot reach now", async () => {
		const { resolve, fetchFile } = fakes(new Set(['offline']));

		await mkdir(join(gameDir, 'resourcepacks'), { recursive: true });

		for (const name of ['mine.zip', 'old.zip', 'offline.zip'])
			await writeFile(join(gameDir, 'resourcepacks', name), 'x');

		const lock = {
			assets: {
				resourcepacks: [
					{ key: 'modrinth:old', filename: 'old.zip' },
					{ key: 'modrinth:offline', filename: 'offline.zip' },
				],
			},
		};
		const manifest = { gameDir, resourcepacks: [{ source: 'modrinth', id: 'offline' }] };
		const result = await syncAssets({ manifest, lock, context: {}, resolve, fetchFile });

		expect((await readdir(join(gameDir, 'resourcepacks'))).toSorted()).toEqual(['mine.zip', 'offline.zip']);
		expect(result.removed).toEqual([{ kind: 'resourcepacks', filename: 'old.zip' }]);
		expect(result.failures).toHaveLength(1);
		expect(result.assets.resourcepacks).toEqual([{ key: 'modrinth:offline', filename: 'offline.zip' }]);
	});

	test('are turned on after those a player has on, and one they turned off is not turned back on', async () => {
		await writeFile(join(gameDir, 'options.txt'), 'fov:0.5\nresourcePacks:["vanilla","file/theirs.zip"]\nlang:en_us\n');
		await enableResourcePacks(gameDir, ['new.zip', 'theirs.zip']);

		expect(await Bun.file(join(gameDir, 'options.txt')).text()).toBe(
			'fov:0.5\nresourcePacks:["vanilla","file/theirs.zip","file/new.zip"]\nlang:en_us\n',
		);
	});

	test("leave Iris's settings alone once it has some", async () => {
		const { resolve, fetchFile } = fakes();

		await mkdir(join(gameDir, 'config'), { recursive: true });
		await writeFile(join(gameDir, 'config', 'iris.properties'), 'enableShaders=false\n');
		await syncAssets({
			manifest: { gameDir, shaderpacks: [{ source: 'modrinth', id: 'bsl' }] },
			lock: {},
			context: {},
			resolve,
			fetchFile,
		});

		expect(await Bun.file(join(gameDir, 'config', 'iris.properties')).text()).toBe('enableShaders=false\n');
	});
});

describe('an optional entry', () => {
	test('is installed only once chosen, and a pack that turns it on by default chooses it', () => {
		const manifest = takeChosen({
			mods: [
				{ source: 'modrinth', id: 'sodium' },
				{ source: 'modrinth', id: 'zoom', optional: true, chosen: true },
				{ source: 'modrinth', id: 'map', optional: true },
			],
			resourcepacks: [{ source: 'modrinth', id: 'faithful', optional: true }],
		});

		expect(manifest.chosen).toEqual(['modrinth:zoom']);
		expect(manifest.mods[1]).not.toHaveProperty('chosen');
		expect(manifest.mods.filter(isWanted(manifest)).map(mod => mod.id)).toEqual(['sodium', 'zoom']);
		expect(manifest.resourcepacks.filter(isWanted(manifest))).toEqual([]);
	});
});

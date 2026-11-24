import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { syncMods, unplacedOf } from '../src/mods';
import * as github from '../src/mods/github';
import { jar as jarIn } from './jars';

let root;
let modsDir;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'ender-test-'));
	modsDir = join(root, 'mods');

	await mkdir(modsDir, { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const fabricJar = async (name, id) => {
	const built = await jarIn(root, { 'fabric.mod.json': JSON.stringify({ id, version: '1' }) });
	const path = join(root, name);

	await writeFile(path, await Bun.file(built).bytes());

	return path;
};

/** pandorical-geyser as the index has it: it requires geyser-fabric, which no repository the index knows claims. */
const geyserBridge = async () => {
	const path = await fabricJar('pandorical-geyser.jar', 'pandorical-geyser');

	return spyOn(github, 'resolve').mockImplementation(async entry => ({
		source: 'github',
		id: entry.id,
		name: entry.id,
		version: 'v0.1.3',
		file: { filename: 'pandorical-geyser.jar', localPath: path },
		dependencies: [],
		unplaced: [{ modId: 'geyser-fabric', claimants: [] }],
	}));
};

const unplacedWarnings = warned =>
	warned.mock.calls.map(([line]) => String(line)).filter(line => line.includes('requires "geyser-fabric"'));

describe('a requirement the index cannot place', () => {
	test('is answered by an installed jar declaring the id, whatever its entry is called', () => {
		const bridge = { source: 'github', id: 'fatlard1993/pandorical-geyser', unplaced: [{ modId: 'geyser-fabric', claimants: [] }] };
		const declared = [{ source: 'modrinth', id: 'geyser' }];

		expect(unplacedOf([bridge], declared).map(({ modId }) => modId)).toEqual(['geyser-fabric']);
		expect(unplacedOf([bridge], declared, ['geyser-fabric'])).toEqual([]);
	});

	test('says nothing in a sync whose jars include one declaring it, as mr:geyser does geyser-fabric', async () => {
		const resolve = await geyserBridge();
		const warned = spyOn(console, 'warn').mockImplementation(() => {});

		try {
			await syncMods({
				entries: [
					{ source: 'github', id: 'fatlard1993/pandorical-geyser' },
					{ source: 'local', path: await fabricJar('geyser.jar', 'geyser-fabric') },
				],
				modsDir,
				lock: { mods: [] },
				context: {},
				withDependencies: true,
			});

			expect(unplacedWarnings(warned)).toEqual([]);
		} finally {
			warned.mockRestore();
			resolve.mockRestore();
		}
	});

	test('is still said in a sync where nothing installed declares it', async () => {
		const resolve = await geyserBridge();
		const warned = spyOn(console, 'warn').mockImplementation(() => {});

		try {
			await syncMods({
				entries: [{ source: 'github', id: 'fatlard1993/pandorical-geyser' }],
				modsDir,
				lock: { mods: [] },
				context: {},
				withDependencies: true,
			});

			expect(unplacedWarnings(warned)).toHaveLength(1);
		} finally {
			warned.mockRestore();
			resolve.mockRestore();
		}
	});
});

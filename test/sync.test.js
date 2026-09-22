import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { syncMods } from '../src/mods';

let root;
let modsDir;

const jar = async name => {
	const path = join(root, name);

	await writeFile(path, name);

	return { source: 'local', path };
};

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'mcm-test-'));
	modsDir = join(root, 'mods');

	await mkdir(modsDir, { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const sync = (entries, lock) => syncMods({ entries, modsDir, lock, context: {}, withDependencies: false });

describe('syncMods', () => {
	test('installs what the manifest declares', async () => {
		const result = await sync([await jar('alpha.jar')], { mods: [] });

		expect(await readdir(modsDir)).toEqual(['alpha.jar']);
		expect(result.lock.mods).toHaveLength(1);
	});

	test('removes a mod it installed once the manifest drops it', async () => {
		const first = await sync([await jar('alpha.jar'), await jar('beta.jar')], { mods: [] });

		expect((await readdir(modsDir)).sort()).toEqual(['alpha.jar', 'beta.jar']);

		const second = await sync([{ source: 'local', path: join(root, 'alpha.jar') }], first.lock);

		expect(await readdir(modsDir)).toEqual(['alpha.jar']);
		expect(second.removed).toEqual(['beta.jar']);
	});

	test('leaves a jar it never installed alone, and says so', async () => {
		await writeFile(join(modsDir, 'hand-built.jar'), 'mine');

		const result = await sync([await jar('alpha.jar')], { mods: [] });

		expect((await readdir(modsDir)).sort()).toEqual(['alpha.jar', 'hand-built.jar']);
		expect(result.unmanaged).toEqual(['hand-built.jar']);
		expect(result.removed).toEqual([]);
	});

	test('survives a locked file that someone already deleted', async () => {
		const first = await sync([await jar('alpha.jar')], { mods: [] });

		await rm(join(modsDir, 'alpha.jar'));

		const second = await sync([], first.lock);

		expect(second.removed).toEqual([]);
		expect(second.lock.mods).toEqual([]);
	});
});

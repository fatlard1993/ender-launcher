import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { duplicateMods, reportSync, syncMods } from '../src/mods';
import { classFile, jar as jarIn } from './jars';

let root;
let modsDir;

const jar = async name => {
	const path = join(root, name);

	await writeFile(path, name);

	return { source: 'local', path };
};

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'ender-test-'));
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

describe('replacing a download', () => {
	let server;
	let served;

	const sha1 = bytes => new Bun.CryptoHasher('sha1').update(bytes).digest('hex');
	const url = () => `http://localhost:${server.port}/mod.jar`;
	const modJar = async options =>
		Bun.file(await jarIn(root, { 'a/A.class': classFile({ name: 'a/A', ...options }) })).bytes();

	/** Install `next` over `previous`, the way a sync replaces a jar whose source published new bytes under one name. */
	const replace = async (previous, next) => {
		served = next;

		if (previous !== undefined) await writeFile(join(modsDir, 'mod.jar'), previous);

		const lock = {
			mods: [
				{
					key: `url:${url()}`,
					source: 'url',
					id: url(),
					version: 'url',
					filename: 'mod.jar',
					checksum: `sha1:${sha1(previous ?? 'gone')}`,
				},
			],
		};

		return sync([{ source: 'url', url: url(), sha1: sha1(next) }], lock);
	};

	beforeAll(() => {
		server = Bun.serve({ port: 0, fetch: () => new Response(served) });
	});

	afterAll(() => {
		server.stop();
	});

	test('says what the new jar can reach that the old one could not, under the same file name', async () => {
		const result = await replace(await modJar(), await modJar({ members: ['java/lang/Runtime.exec'] }));

		expect(result.gained).toHaveLength(1);
		expect(result.gained[0].gained.capabilities).toEqual({ exec: { 'a/A.class': ['java/lang/Runtime.exec'] } });
		expect(result.notCompared).toEqual([]);
	});

	test('a replacement that reaches nothing new is quiet', async () => {
		const reach = { members: ['java/net/http/HttpClient.send'] };
		const result = await replace(await modJar(reach), await modJar({ ...reach, strings: ['changed'] }));

		expect(result.gained).toEqual([]);
		expect(result.notCompared).toEqual([]);
	});

	// Not a jar at all, so a scan of it would have been reported.
	test('a download that did not change is not scanned', async () => {
		const result = await replace('not a jar', 'not a jar');

		expect(result.gained).toEqual([]);
		expect(result.notCompared).toEqual([]);
	});

	test('a baseline that is gone is reported, not skipped', async () => {
		const result = await replace(undefined, await modJar());

		expect(result.notCompared).toHaveLength(1);
		expect(result.notCompared[0].error.message).toContain('mod.jar is gone');
	});

	test('a gain prints as one line naming the mod, the capability and the evidence', async () => {
		const result = await replace(await modJar(), await modJar({ members: ['java/lang/Runtime.exec'] }));
		const warned = spyOn(console, 'warn').mockImplementation(() => {});
		const logged = spyOn(console, 'log').mockImplementation(() => {});

		try {
			reportSync(result);

			expect(warned.mock.calls.map(([line]) => line)).toContain(
				`!! url:${url()} url gained exec since url: a/A.class (java/lang/Runtime.exec)`,
			);
		} finally {
			warned.mockRestore();
			logged.mockRestore();
		}
	});
});

describe('one mod from two sources', () => {
	const resolution = (key, modIds, requested = true) => ({ key, modIds, requested });

	test('a declared mod is kept over a dependency that is the same mod, whichever came first', () => {
		const dependency = resolution('github:FabricMC/fabric-api', ['fabric-api'], false);
		const declared = resolution('modrinth:fabric-api', ['fabric-api']);
		const { kept, dropped } = duplicateMods([dependency, declared]);

		expect(kept).toEqual([declared]);
		expect(dropped).toEqual([{ resolution: dependency, id: 'fabric-api', keptAs: declared }]);
	});

	test('between equals, the first is kept', () => {
		const first = resolution('modrinth:sodium', ['sodium']);
		const second = resolution('github:CaffeineMC/sodium', ['sodium']);

		expect(duplicateMods([first, second]).kept).toEqual([first]);
	});

	test('jars with no readable ids, or different ones, never clash', () => {
		const all = [resolution('a', []), resolution('b', []), resolution('c', ['x']), resolution('d', ['y'])];

		expect(duplicateMods(all)).toEqual({ kept: all, dropped: [] });
	});

	test('a sync installs the mod once, leaves the other out of the lock, and says why', async () => {
		const fabricJar = async (name, id) => {
			const built = await jarIn(root, { 'fabric.mod.json': JSON.stringify({ id, version: '1' }) });
			const path = join(root, name);

			await writeFile(path, await Bun.file(built).bytes());

			return { source: 'local', path };
		};
		const result = await sync([await fabricJar('sodium-a.jar', 'sodium'), await fabricJar('sodium-b.jar', 'sodium')], {
			mods: [],
		});
		const warned = spyOn(console, 'warn').mockImplementation(() => {});
		const logged = spyOn(console, 'log').mockImplementation(() => {});

		try {
			reportSync(result);

			expect(warned.mock.calls.map(([line]) => line)).toContain(
				`!! local:${join(root, 'sodium-b.jar')} is mod "sodium", already here from local:${join(root, 'sodium-a.jar')}; not installed. It is declared twice; drop one.`,
			);
		} finally {
			warned.mockRestore();
			logged.mockRestore();
		}

		expect(await readdir(modsDir)).toEqual(['sodium-a.jar']);
		expect(result.lock.mods.map(mod => mod.filename)).toEqual(['sodium-a.jar']);
	});
});

describe('mod ids known by checksum', () => {
	let server;
	const hits = new Map();
	const bodies = new Map();

	const sha1 = bytes => new Bun.CryptoHasher('sha1').update(bytes).digest('hex');
	const served = async (name, id) => {
		bodies.set(
			`/${name}`,
			await Bun.file(await jarIn(root, { 'fabric.mod.json': JSON.stringify({ id, version: name }) })).bytes(),
		);

		return { source: 'url', url: `http://localhost:${server.port}/${name}`, sha1: sha1(bodies.get(`/${name}`)) };
	};

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			fetch: request => {
				const { pathname } = new URL(request.url);

				hits.set(pathname, (hits.get(pathname) ?? 0) + 1);

				return new Response(bodies.get(pathname));
			},
		});
	});

	afterAll(() => {
		server.stop();
	});

	test('a jar that repeats a known mod id is not downloaded again', async () => {
		const modIdCache = join(root, 'mod-ids.json');
		const entries = [await served('fabric-api-a.jar', 'fabric-api'), await served('fabric-api-b.jar', 'fabric-api')];
		const first = await syncMods({
			entries,
			modsDir,
			lock: { mods: [] },
			context: {},
			withDependencies: false,
			modIdCache,
		});
		const second = await syncMods({
			entries,
			modsDir,
			lock: first.lock,
			context: {},
			withDependencies: false,
			modIdCache,
		});

		expect(first.duplicates.map(({ resolution }) => resolution.file.filename)).toEqual(['fabric-api-b.jar']);
		expect(second.duplicates.map(({ resolution }) => resolution.file.filename)).toEqual(['fabric-api-b.jar']);
		expect(hits.get('/fabric-api-b.jar')).toBe(1);
		expect(await readdir(modsDir)).toEqual(['fabric-api-a.jar']);
		expect(Object.values(await Bun.file(modIdCache).json())).toEqual([['fabric-api'], ['fabric-api']]);
	});
});

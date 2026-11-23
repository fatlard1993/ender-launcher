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

	test('leaves out of a server a jar whose every mod runs on the client alone, and keeps it on a client', async () => {
		const fabricJar = async (name, id, environment) => {
			const built = await jarIn(root, { 'fabric.mod.json': JSON.stringify({ id, version: '1', environment }) });
			const path = join(root, name);

			await writeFile(path, await Bun.file(built).bytes());

			return { source: 'local', path };
		};
		const entries = [
			await fabricJar('zoom.jar', 'zoom', 'client'),
			await fabricJar('lib.jar', 'lib', '*'),
			await fabricJar('Hud.jar', 'hud', 'CLIENT'),
		];
		const serving = await syncMods({
			entries,
			modsDir,
			lock: { mods: [] },
			context: { side: 'server' },
			withDependencies: false,
		});

		expect(await readdir(modsDir)).toEqual(['lib.jar']);
		expect(serving.leftForClients.map(resolution => resolution.file.filename).toSorted()).toEqual([
			'Hud.jar',
			'zoom.jar',
		]);
		expect(serving.lock.mods.map(mod => mod.filename)).toEqual(['lib.jar']);

		const playing = await syncMods({
			entries,
			modsDir,
			lock: serving.lock,
			context: { side: 'client' },
			withDependencies: false,
		});

		expect((await readdir(modsDir)).toSorted()).toEqual(['Hud.jar', 'lib.jar', 'zoom.jar']);
		expect(playing.leftForClients).toEqual([]);
	});

	test('refuses a jar the index lists as known bad, from any source, newly installed or already there, with no trust to let it in', async () => {
		const bad = await jar('bad.jar');
		const fine = await jar('fine.jar');
		const hashOf = async path =>
			new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex');
		const listed = new Map([[await hashOf(bad.path), 'steals session tokens']]);
		const context = { trustSecrets: true, knownBad: async () => listed };
		const first = await syncMods({
			entries: [bad, fine],
			modsDir,
			lock: { mods: [] },
			context,
			withDependencies: false,
		});

		expect(await readdir(modsDir)).toEqual(['fine.jar']);
		expect(first.failures.map(({ error }) => error.message)).toEqual([
			"bad.jar is on the index's known-bad list: steals session tokens",
		]);

		// Listed after it was installed: the next sync takes it out
		const later = new Map([[await hashOf(fine.path), 'confirmed later']]);
		const second = await syncMods({
			entries: [fine],
			modsDir,
			lock: first.lock,
			context: { knownBad: async () => later },
			withDependencies: false,
		});

		expect(await readdir(modsDir)).toEqual([]);
		expect(second.failures).toHaveLength(1);
	});

	test('moves aside a jar it never installed that is another copy of a mod it installs, which would stop the game', async () => {
		const fabricJar = async (path, id) => {
			const built = await jarIn(root, { 'fabric.mod.json': JSON.stringify({ id, version: '1' }) });

			await writeFile(path, await Bun.file(built).bytes());

			return { source: 'local', path };
		};

		await fabricJar(join(modsDir, 'pandorical-copied.jar'), 'pandorical');
		await fabricJar(join(modsDir, 'mine.jar'), 'mine');

		const result = await sync([await fabricJar(join(root, 'pandorical-released.jar'), 'pandorical')], { mods: [] });

		expect((await readdir(modsDir)).sort()).toEqual(['mine.jar', 'pandorical-released.jar']);
		expect(await readdir(join(root, 'mods-displaced'))).toEqual(['pandorical-copied.jar']);
		expect(result.displaced).toEqual([{ file: 'pandorical-copied.jar', id: 'pandorical' }]);
		expect(result.unmanaged).toEqual(['mine.jar']);
	});

	test('a jar declared from inside mods/ itself stays as it is, not written onto itself', async () => {
		const path = join(modsDir, 'mine.jar');

		await writeFile(path, 'the whole jar');

		const result = await sync([{ source: 'local', path }], { mods: [] });

		expect(await Bun.file(path).text()).toBe('the whole jar');
		expect(result.lock.mods.map(mod => mod.filename)).toEqual(['mine.jar']);
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
		server = Bun.serve({ port: 0, fetch: () => (typeof served === 'function' ? served() : new Response(served)) });
	});

	afterAll(() => {
		server.stop();
	});

	test('a new build that does not arrive leaves the old one installed and in the lock, and says so', async () => {
		await writeFile(join(modsDir, 'mod-1.jar'), 'the old build');

		const lock = {
			mods: [
				{ key: `url:${url()}`, source: 'url', id: url(), version: '1', filename: 'mod-1.jar', checksum: 'sha1:aa' },
			],
		};

		served = () => new Response('gone', { status: 404 });

		const result = await sync([{ source: 'url', url: url(), file: 'mod-2.jar', sha1: 'bb' }], lock);

		expect(result.failures).toHaveLength(1);
		expect(result.removed).toEqual([]);
		expect(await readdir(modsDir)).toEqual(['mod-1.jar']);
		expect(result.lock.mods).toEqual(lock.mods);

		const failed = spyOn(console, 'error').mockImplementation(() => {});
		const logged = spyOn(console, 'log').mockImplementation(() => {});

		try {
			reportSync(result);

			expect(failed.mock.calls[0][0]).toEndWith('; 1 stays installed');
		} finally {
			failed.mockRestore();
			logged.mockRestore();
		}
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

	test('the jar a replacement was compared with is not read again as the next baseline, unless it changed', async () => {
		const scanCache = join(root, 'scans');
		const replaceKept = async (previous, next) => {
			served = next;

			await writeFile(join(modsDir, 'mod.jar'), previous);

			const lock = {
				mods: [
					{
						key: `url:${url()}`,
						source: 'url',
						id: url(),
						version: 'url',
						filename: 'mod.jar',
						checksum: `sha1:${sha1(previous)}`,
					},
				],
			};

			return syncMods({
				entries: [{ source: 'url', url: url(), sha1: sha1(next) }],
				modsDir,
				lock,
				context: {},
				withDependencies: false,
				scanCache,
			});
		};
		const plain = await modJar();
		const reaching = await modJar({ members: ['java/lang/Runtime.exec'] });
		const reachingMore = await modJar({ members: ['java/lang/Runtime.exec'], strings: ['more'] });

		expect((await replaceKept(plain, reaching)).gained).toHaveLength(1);

		const [kept] = await readdir(scanCache);
		const record = await Bun.file(join(scanCache, kept)).json();
		const keepAsReachingNothing = () =>
			Bun.write(join(scanCache, kept), JSON.stringify({ ...record, scan: { ...record.scan, capabilities: {} } }));

		await keepAsReachingNothing();

		expect((await replaceKept(reaching, reachingMore)).gained).toHaveLength(1);

		await Bun.write(join(scanCache, kept), JSON.stringify(record));

		expect((await replaceKept(plain, reachingMore)).gained).toHaveLength(1);
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

	test('an installed jar known by its checksum takes the ids read from that checksum before', async () => {
		const modIdCache = join(root, 'mod-ids.json');
		const known = await served('known.jar', 'known');
		const fresh = await served('fresh.jar', 'shared');

		await Bun.write(modIdCache, JSON.stringify({ [`sha1:${known.sha1}`]: ['shared'] }));

		const result = await syncMods({
			entries: [known, fresh],
			modsDir,
			lock: { mods: [] },
			context: {},
			withDependencies: false,
			modIdCache,
		});

		expect(result.duplicates.map(({ resolution, id }) => [resolution.file.filename, id])).toEqual([
			['fresh.jar', 'shared'],
		]);
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

describe('a jar whose code names where other programs keep logins', () => {
	let home;
	let previousHome;

	beforeEach(async () => {
		previousHome = process.env.ENDER_HOME;
		home = await mkdtemp(join(tmpdir(), 'ender-home-'));
		process.env.ENDER_HOME = home;
	});

	afterEach(async () => {
		if (previousHome === undefined) delete process.env.ENDER_HOME;
		else process.env.ENDER_HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	});

	const stealer = async () => {
		const path = await jarIn(root, {
			'a/A.class': classFile({ name: 'a/A', strings: ['\\discord\\Local Storage\\leveldb'] }),
		});

		return { source: 'local', path };
	};

	test('is not installed, says why, and names --trust', async () => {
		const result = await sync([await stealer()], { mods: [] });

		expect(await readdir(modsDir)).toEqual([]);
		expect(result.lock.mods).toEqual([]);
		expect(result.failures[0].error.message).toContain("Discord's login token");
		expect(result.failures[0].error.message).toContain('--trust');
		expect(result.failures[0].error.message).toMatch(/\[sha256:[0-9a-f]{64}\]$/);
	});

	test('is installed once the player trusts it, and stays trusted by its hash', async () => {
		const entry = await stealer();
		const trusted = await syncMods({
			entries: [entry],
			modsDir,
			lock: { mods: [] },
			context: { trustSecrets: true },
			withDependencies: false,
		});

		expect(trusted.failures).toEqual([]);
		expect(await readdir(modsDir)).toHaveLength(1);

		await rm(join(modsDir, (await readdir(modsDir))[0]));

		const again = await sync([entry], { mods: [] });

		expect(again.failures).toEqual([]);
	});
});

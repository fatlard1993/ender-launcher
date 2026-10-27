import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';

import { parseModSpec, refineModSpec } from '../src/commands/context';
import { ESTABLISHED, fit, forgetLoaded, providerOf, requiredIds } from '../src/mods/catalog';
import { standing } from '../src/mods/rank';
import { hosted, resolveFromRecord, search } from '../src/mods/indexed';
import { rank } from '../src/mods/rank';
import { authorsOf } from '../src/commands/mods';

const mod = (id, extra) => ({
	loader: 'fabric',
	id,
	name: id,
	minecraft: '~26.3',
	depends: [],
	provides: [],
	...extra,
});

const entry = (repo, mods, extra) => ({
	repo,
	stars: 1,
	description: '',
	targets: mods.map(({ loader, minecraft }) => ({ loader, minecraft })),
	latest: { tag: '1', mods, provides: mods.flatMap(item => item.provides), capabilities: [] },
	...extra,
});

const asset = (name, mods, extra) => ({
	id: 1,
	name,
	url: `https://example.invalid/${name}`,
	size: 1,
	sha256: 'ab',
	mods,
	...extra,
});

const release = (tag, assets, extra) => ({
	tag,
	published: '2026-10-01T00:00:00Z',
	prerelease: false,
	assets,
	...extra,
});

let index;
let disguised;

const listing = [
	entry(
		'FabricMC/fabric-api',
		[mod('fabric-api', { provides: ['fabric-api-base', 'fabric-screen-api-v1', 'fabric-key-mapping-api-v1'] })],
		{ stars: 3000 },
	),
	entry('TerraformersMC/ModMenu', [mod('modmenu', { name: 'Mod Menu', provides: ['fabric-api-base'] })], {
		stars: 600,
		description: 'A menu for mods',
	}),
	entry('a/backpacks', [mod('backpacks', { name: 'Backpacks', minecraft: '~26.1' })], {
		stars: 50,
		description: 'Carry more',
	}),
	entry('b/old', [mod('old-backpacks')], { archived: true }),
	entry('lib/core', [mod('core-lib')], { host: 'gitlab', stars: ESTABLISHED }),
	entry('x/fast-client', [mod('sodium', { name: 'Sodium' })], { stars: 0 }),
	entry('h/helpers', [mod('h-helpers')], { stars: 0 }),
	entry('b/fabric', [mod('legacy-fabric-api', { name: 'Legacy Fabric API' })], { stars: 80 }),
];

beforeAll(async () => {
	index = await mkdtemp(join(tmpdir(), 'ender-catalog-'));

	await mkdir(index, { recursive: true });
	await Bun.write(join(index, 'search.json'), JSON.stringify(listing));

	disguised = join(index, 'disguised');
	await Bun.write(
		join(disguised, 'search.json'),
		JSON.stringify([
			entry('FabricMC/fabric-api', [mod('fabric-api', { name: 'Fabric API' })], { stars: 3000 }),
			entry('x/client', [mod('fabric', { name: 'Fabric API' }), mod('vhx', { name: 'Client' })], { stars: 6 }),
			entry('y/client', [mod('fabric-api', { name: 'Fabric API' })], { stars: 1 }),
		]),
	);
});

afterAll(async () => {
	await rm(index, { recursive: true, force: true });
});

describe('the index catalog', () => {
	test('fit is exact, unknown or none', () => {
		expect(fit([mod('a')], { minecraft: '26.3', loader: 'fabric' })).toBe(2);
		expect(fit([mod('a', { minecraft: 'whatever' })], { minecraft: '26.3', loader: 'fabric' })).toBe(1);
		expect(fit([mod('a')], { minecraft: '26.4', loader: 'fabric' })).toBe(0);
		expect(fit([mod('a')], { minecraft: '26.3', loader: 'neoforge' })).toBe(0);
	});

	// Quilt loads Fabric mods as its own.
	test('a fabric jar fits a quilt instance', () => {
		expect(fit([mod('a')], { minecraft: '26.3', loader: 'quilt' })).toBe(2);
	});

	test('a dependency goes to the repository whose own mod has that id', () => {
		expect(providerOf('modmenu', listing).repo).toBe('TerraformersMC/ModMenu');
	});

	// ModMenu carries fabric-api-base inside its own jar; Fabric API is still where it comes from.
	test('a bundled module is credited to the release that provides the most', () => {
		expect(providerOf('fabric-api-base', listing).repo).toBe('FabricMC/fabric-api');
		expect(providerOf('nobody-has-this', listing)).toBeUndefined();
	});

	test('only a repository with a release for the instance answers for what it requires', () => {
		const port = entry('q/fabric-api', [mod('fabric-api', { loader: 'quilt' })], { stars: 5000 });
		const both = [...listing, port];

		expect(providerOf('fabric-api', both).repo).toBe('q/fabric-api');
		expect(providerOf('fabric-api', both, undefined, { loader: 'fabric' }).repo).toBe('FabricMC/fabric-api');
		expect(providerOf('backpacks', listing, undefined, { minecraft: '26.3' })).toBeUndefined();
	});

	test("a fork keeping another mod's id does not answer for it, and an id shortening its own name does", () => {
		const fork = entry('s/gitmatica', [mod('litematica', { name: 'Gitmatica' })], { stars: 98 });
		const shortened = entry('t/In-Game-Account-Switcher', [mod('ias', { name: 'In-Game Account Switcher' })], {
			stars: 131,
		});
		const both = [...listing, fork, shortened];

		expect(providerOf('litematica', both)).toBeUndefined();
		expect(providerOf('ias', both).repo).toBe('t/In-Game-Account-Switcher');
	});

	// minecraft-access carries Cloth Config and Fabric API in its jar, and has the stars to be trusted
	test('a jar carrying a mod it is not named for does not answer for that mod', () => {
		const carrier = entry('m/access', [mod('minecraft_access', { provides: ['cloth-config', 'fabric-api-base'] })], {
			stars: 95,
		});

		expect(providerOf('cloth-config', [...listing, carrier])).toBeUndefined();
		expect(providerOf('fabric-api-base', [...listing, carrier]).repo).toBe('FabricMC/fabric-api');
	});

	test('a mod id claimed only by a repository nobody has vouched for names nothing', () => {
		expect(providerOf('sodium', listing)).toBeUndefined();
		expect(providerOf('sodium', listing, { repo: 'IrisShaders/Iris' })).toBeUndefined();
	});

	test("an author's own library is trusted by their other mods, however new", () => {
		expect(providerOf('h-helpers', listing, { repo: 'h/m' }).repo).toBe('h/helpers');
		expect(providerOf('h-helpers', listing, { host: 'gitlab', repo: 'h/m' })).toBeUndefined();
	});

	test('a new repository is trusted when its owner has an established one', () => {
		const fresh = entry('a/new-library', [mod('new-library')], { stars: 0 });
		const stranger = entry('nobody/new-library', [mod('other-library')], { stars: 0 });
		const both = [...listing, fresh, stranger];

		expect(providerOf('new-library', both, { repo: 'x/mod' }).repo).toBe('a/new-library');
		expect(providerOf('other-library', both, { repo: 'x/mod' })).toBeUndefined();
		expect(rank(both, 'new library')[0]).toMatchObject({ unproven: '', author: 'a/backpacks' });
		expect(rank(both, 'other library')[0].unproven).toContain('no repository with');
		expect(rank(both, 'backpacks', { minecraft: '26.1' })[0].author).toBe('');
		expect(rank(listing, 'backpacks', { minecraft: '26.1' })[0].author).toBe('');
	});

	test('what a jar needs is neither the platform nor what it carries', () => {
		const mods = [
			mod('travelbag', {
				depends: ['fabricloader', 'minecraft', 'java', 'fabric-api', 'fabric-permissions-api-v0'],
				provides: ['fabric-permissions-api-v0'],
			}),
		];

		expect(requiredIds(mods)).toEqual(['fabric-api']);
	});
});

describe('resolving from an index record', () => {
	const context = () => ({ minecraft: '26.3', loader: 'fabric', index });

	test('takes the release whose jar declares the instance, with the hash and dependencies the index holds', async () => {
		const record = {
			releases: [
				release('2.0', [asset('modmenu-2.0.jar', [mod('modmenu', { minecraft: '~26.4' })])]),
				release('1.0', [
					asset('modmenu-1.0.jar', [mod('modmenu', { depends: ['fabric-screen-api-v1', 'minecraft'] })]),
				]),
			],
		};
		const resolved = await resolveFromRecord(record, { source: 'github', id: 'TerraformersMC/ModMenu' }, context());

		expect(resolved.version).toBe('1.0');
		expect(resolved.file).toEqual({
			filename: 'modmenu-1.0.jar',
			url: 'https://example.invalid/modmenu-1.0.jar',
			checksum: { algorithm: 'sha256', value: 'ab' },
			size: 1,
		});
		expect(resolved.dependencies).toEqual([{ source: 'github', id: 'FabricMC/fabric-api' }]);
	});

	test('a declared match beats a range that cannot be read, even an older one', async () => {
		const record = {
			releases: [
				release('2.0', [asset('m-2.0.jar', [mod('m', { minecraft: 'unreadable' })])], {
					published: '2026-10-05T00:00:00Z',
				}),
				release('1.0', [asset('m-1.0.jar', [mod('m')])]),
			],
		};

		expect((await resolveFromRecord(record, { source: 'github', id: 'a/m' }, context())).version).toBe('1.0');
	});

	test('picks the jar for the instance loader out of a multiloader release', async () => {
		const record = {
			releases: [
				release('1.0', [
					asset('m-neoforge-1.0.jar', [mod('m', { loader: 'neoforge', minecraft: '[26.3,26.4)' })]),
					asset('m-fabric-1.0.jar', [mod('m')]),
				]),
			],
		};

		expect((await resolveFromRecord(record, { source: 'github', id: 'a/m' }, context())).file.filename).toBe(
			'm-fabric-1.0.jar',
		);
	});

	test('skips jars that failed, are gone, or do not match the asset pattern', async () => {
		const record = {
			releases: [
				release('1.0', [
					asset('m-broken.jar', undefined, { error: 'download answered 502' }),
					asset('m-gone.jar', [mod('m')], { gone: '2026-10-02' }),
					asset('m-extra.jar', [mod('m')]),
					asset('m.jar', [mod('m')]),
				]),
			],
		};

		expect(
			(await resolveFromRecord(record, { source: 'github', id: 'a/m', asset: '^m\\.jar$' }, context())).file.filename,
		).toBe('m.jar');
	});

	test('nothing fitting leaves it to the GitHub API', async () => {
		const record = { releases: [release('1.0', [asset('m.jar', [mod('m', { minecraft: '~26.1' })])])] };

		expect(await resolveFromRecord(record, { source: 'github', id: 'a/m' }, context())).toBeUndefined();
	});

	test('refuses a jar listed as known bad', async () => {
		const record = { releases: [release('1.0', [asset('m.jar', [mod('m')], { knownBad: 'carries a stealer' })])] };

		await expect(resolveFromRecord(record, { source: 'github', id: 'a/m' }, context())).rejects.toThrow(
			'known bad: carries a stealer',
		);
	});

	test('says when the jar was replaced after it was published, and when a dependency has no home', async () => {
		const record = {
			releases: [
				release('1.0', [
					asset('m.jar', [mod('m', { depends: ['mystery-lib'] })], {
						replaced: [{ id: 0, sha256: 'old', until: '2026-10-03' }],
					}),
				]),
			],
		};
		const warned = spyOn(console, 'warn').mockImplementation(() => {});

		try {
			await resolveFromRecord(record, { source: 'github', id: 'a/m' }, context());

			const lines = warned.mock.calls.map(([line]) => line);

			expect(lines).toContain(
				'!! github:a/m 1.0 m.jar was replaced after it was published; the earlier jar was seen until 2026-10-03',
			);
			expect(lines).toContain(
				'!! github:a/m requires "mystery-lib", which the index does not know; declare it yourself',
			);
		} finally {
			warned.mockRestore();
		}
	});

	test('still resolves a repository its host no longer has, so an installed copy keeps working, and says so', async () => {
		const record = { gone: '2026-10-25', releases: [release('1.0', [asset('m.jar', [mod('m')])])] };
		const warned = spyOn(console, 'warn').mockImplementation(() => {});

		try {
			expect((await resolveFromRecord(record, { source: 'github', id: 'a/m' }, context())).version).toBe('1.0');
			expect(warned.mock.calls.map(([line]) => line)).toContain(
				'!! github:a/m was deleted or made private on GitHub (seen 2026-10-25); a copy already installed keeps working, but it cannot be downloaded again or updated',
			);
		} finally {
			warned.mockRestore();
		}
	});
});

describe('searching the index', () => {
	test('matches ids and names before descriptions, and leaves out what does not fit or is archived', async () => {
		const hits = await search('backpacks', { index, minecraft: '26.1', loader: 'fabric' });

		expect(hits.map(hit => hit.id)).toEqual(['a/backpacks']);
		expect(await search('backpacks', { index, minecraft: '26.3', loader: 'fabric' })).toEqual([]);
	});

	test('a repository without a description is listed by its summary', async () => {
		const summarized = join(index, 'summarized');

		await Bun.write(
			join(summarized, 'search.json'),
			JSON.stringify([entry('s/quiet', [mod('quiet')], { summary: { text: 'Ships you can walk on', from: 'jar' } })]),
		);

		expect((await search('quiet', { index: summarized }))[0].description).toBe('Ships you can walk on');
	});

	test("a repository's summary is searched where it has no description", () => {
		const summarized = entry('s/summarized', [mod('quiet')], {
			summary: { text: 'Ships you can walk on', from: 'readme' },
		});

		expect(rank([...listing, summarized], 'walk ships').map(({ entry: found }) => found.repo)).toEqual([
			's/summarized',
		]);
	});

	test("a theme the index gave a repository finds it, above a word in another's description", () => {
		const themed = entry('t/boats', [mod('boats')], { tags: ['ship', 'sail'] });
		const described = entry('d/other', [mod('other')], { description: 'Not ships, but trains' });

		expect(rank([described, themed], 'ships').map(({ entry: found }) => found.repo)).toEqual(['t/boats', 'd/other']);
	});

	test('equal matches are ordered by how far they are relied on, not by stars alone', () => {
		const now = Date.parse('2026-10-27T00:00:00Z');
		const released = when => ({ tag: '1', published: when, mods: [mod('x')], provides: [], capabilities: [] });
		const starred = entry('a/starred', [mod('x')], { stars: 40, latest: released('2023-01-01T00:00:00Z') });
		const relied = entry('b/relied', [mod('x')], { stars: 10, usedBy: 12, latest: released('2026-09-01T00:00:00Z') });

		expect(standing(relied, now)).toBeGreaterThan(standing(starred, now));
		expect(standing(entry('c/none', [mod('x')], { stars: 0, latest: { mods: [] } }), now)).toBe(0);
	});

	test('every word of the query has to land somewhere', async () => {
		expect((await search('menu mods', { index })).map(hit => hit.id)).toEqual(['TerraformersMC/ModMenu']);
		expect(await search('menu banana', { index })).toEqual([]);
	});

	test('the whole query naming a mod outranks a word of it naming another', async () => {
		expect((await search('fabric api', { index })).map(hit => hit.id)).toEqual(['FabricMC/fabric-api', 'b/fabric']);
		expect((await search('mod menu', { index }))[0].id).toBe('TerraformersMC/ModMenu');
	});

	test("a copy of an established mod's id or name ranks below it, and says whose it is", async () => {
		const hits = await search('fabric api', { index: disguised });

		expect(hits.map(hit => hit.id)).toEqual(['FabricMC/fabric-api', 'x/client', 'y/client']);
		expect(hits[1].note).toContain('declares the name "Fabric API", as FabricMC/fabric-api does');
		expect(hits[2].note).toContain('declares "fabric-api", as FabricMC/fabric-api does');
		expect(hits[0].note).not.toContain('declares');
	});

	test('what a listing says an entry shares is taken as it is', () => {
		const listed = listing.map(item =>
			item.repo === 'b/fabric' ? { ...item, shares: 'declares "x", as y/x does' } : item,
		);

		expect(rank(listed, 'legacy fabric api')[0].sharing).toBe('declares "x", as y/x does');
		expect(rank(listing, 'legacy fabric api')[0].sharing).toBe('');
	});

	test('a mod no established repository declares says so when the query names it', async () => {
		const [hit] = await search('sodium', { index });

		expect(hit.id).toBe('x/fast-client');
		expect(hit.note).toContain(`no repository with ${ESTABLISHED} stars or more declares "Sodium"`);
		expect((await search('fabric api', { index }))[0].note).not.toContain('declares');
		expect((await search('fast', { index }))[0].note).not.toContain('declares');
	});

	test('with no query, everything that fits answers, by stars', () => {
		expect(rank(listing, '', { minecraft: '26.1' }).map(({ entry }) => entry.repo)).toEqual(['a/backpacks']);
		expect(
			rank(listing, ' ')
				.map(({ entry }) => entry.repo)
				.slice(0, 3),
		).toEqual(['FabricMC/fabric-api', 'TerraformersMC/ModMenu', 'b/fabric']);
	});

	// ender-index's web page bundles the ranking for a browser, where the client's disk and network are not
	test('the ranking and the spelling of a spec reach nothing but the range parser, so a browser can run them', async () => {
		const imports = async file =>
			[...(await Bun.file(file).text()).matchAll(/^import .* from '(.+)';$/gm)].map(m => m[1]);

		expect(await imports('src/mods/rank.js')).toEqual(['./range']);
		expect(await imports('src/mods/range.js')).toEqual([]);
		expect(await imports('src/mods/spec.js')).toEqual([]);
		expect(await imports('src/mods/support.js')).toEqual([]);
	});

	test('a missing index says where it looked', async () => {
		await expect(search('x', { index: join(index, 'nowhere') })).rejects.toThrow(
			`No mod index at ${join(index, 'nowhere')}`,
		);
	});
});

describe('a bare name', () => {
	test('becomes the repository whose jars declare that mod id', async () => {
		const logged = spyOn(console, 'log').mockImplementation(() => {});

		try {
			expect(await refineModSpec(parseModSpec('modmenu'), { index })).toEqual({
				source: 'github',
				id: 'TerraformersMC/ModMenu',
			});
			expect(await refineModSpec(parseModSpec('fabric-api@0.165.0+26.3'), { index })).toEqual({
				source: 'github',
				id: 'FabricMC/fabric-api',
				version: '0.165.0+26.3',
			});
			expect(logged.mock.calls.map(([line]) => line)).toContain('  modmenu is gh:TerraformersMC/ModMenu');
		} finally {
			logged.mockRestore();
		}
	});

	test('the index does not know is refused, naming the prefixes that reach elsewhere', async () => {
		await expect(refineModSpec(parseModSpec('jei'), { index })).rejects.toThrow(
			'"jei" is not a mod the index knows. For Modrinth write mr:jei, for CurseForge cf:jei.',
		);
	});

	test('claimed only by repositories nobody has vouched for is refused, and says how to choose one', async () => {
		await expect(refineModSpec(parseModSpec('sodium'), { index })).rejects.toThrow(
			'"sodium" is claimed in the index only by repositories too new or unknown to take on a name alone',
		);
	});
});

describe('a published index', () => {
	let server;
	let home;
	let previousHome;
	let answer;
	const served = [];

	beforeAll(async () => {
		home = await mkdtemp(join(tmpdir(), 'ender-home-'));
		previousHome = process.env.ENDER_HOME;
		process.env.ENDER_HOME = home;
		server = Bun.serve({
			port: 0,
			fetch: request => {
				const status = answer(request);

				served.push(status);

				if (status === 304) return new Response(undefined, { status: 304 });
				if (status !== 200) return new Response('no', { status });

				return Response.json(listing, { headers: { etag: '"v1"' } });
			},
		});
	});

	afterAll(async () => {
		server.stop();

		if (previousHome === undefined) delete process.env.ENDER_HOME;
		else process.env.ENDER_HOME = previousHome;

		await rm(home, { recursive: true, force: true });
	});

	const base = name => `http://localhost:${server.port}/${name}`;

	test('is fetched whole once, and after that only asked whether it changed', async () => {
		answer = request => (request.headers.get('if-none-match') === '"v1"' ? 304 : 200);

		const first = await search('menu', { index: base('a') });

		served.length = 0;
		forgetLoaded();

		const again = await search('menu', { index: base('a') });

		expect(served).toEqual([304]);
		expect(again).toEqual(first);
	});

	test('unreachable, the kept copy is used and that is said', async () => {
		answer = () => 200;

		await search('menu', { index: base('b') });

		answer = () => 503;
		forgetLoaded();

		const warned = spyOn(console, 'warn').mockImplementation(() => {});

		try {
			const hits = await search('menu', { index: base('b') });

			expect(hits.map(hit => hit.id)).toEqual(['TerraformersMC/ModMenu']);
			expect(warned.mock.calls[0][0]).toContain('The index could not be reached');
		} finally {
			warned.mockRestore();
		}
	});
});

describe('mods on Codeberg and GitLab', () => {
	const context = () => ({ minecraft: '26.3', loader: 'fabric', index });

	test('resolve from their records, kept apart from GitHub owners', async () => {
		await Bun.write(
			join(index, 'mods', 'codeberg.org', 'enjarai', 'barrel.json'),
			JSON.stringify({ releases: [release('3.8.4', [asset('barrel.jar', [mod('do_a_barrel_roll')])])] }),
		);

		const resolved = await hosted('codeberg').resolve({ source: 'codeberg', id: 'enjarai/barrel' }, context());

		expect(resolved.source).toBe('codeberg');
		expect(resolved.version).toBe('3.8.4');
	});

	test('one the index has not crawled says how to get it crawled', async () => {
		await expect(hosted('gitlab').resolve({ source: 'gitlab', id: 'g/missing' }, context())).rejects.toThrow(
			`gitlab:g/missing is not in the index; add "gitlab:g/missing" to ender-index's repos.txt`,
		);
	});

	test('a dependency claimed only by an unvouched repository is said, not installed', async () => {
		const record = { releases: [release('1.0', [asset('m.jar', [mod('m', { depends: ['sodium'] })])])] };
		const warned = spyOn(console, 'warn').mockImplementation(() => {});

		try {
			const resolved = await resolveFromRecord(record, { source: 'github', id: 'IrisShaders/Iris' }, context());

			expect(resolved.dependencies).toEqual([]);
			expect(warned.mock.calls.map(([line]) => line)).toContain(
				'!! github:IrisShaders/Iris requires "sodium"; 1 repository in the index claims that id, but any jar can, and none is established enough to install unasked. Declare the one you trust.',
			);
		} finally {
			warned.mockRestore();
		}
	});

	test('a dependency on a mod hosted elsewhere is declared from that host', async () => {
		const record = { releases: [release('1.0', [asset('m.jar', [mod('m', { depends: ['core-lib'] })])])] };
		const resolved = await resolveFromRecord(record, { source: 'github', id: 'a/m' }, context());

		expect(resolved.dependencies).toEqual([{ source: 'gitlab', id: 'lib/core' }]);
	});
});

describe("the support an instance's authors take", () => {
	test('is grouped by author, each link once, with mods from elsewhere and without a link counted apart', () => {
		const entries = [
			entry('maker/one', [mod('one')], { funding: [{ platform: 'ko_fi', url: 'https://ko-fi.com/maker' }] }),
			entry('maker/two', [mod('two')], {
				funding: [
					{ platform: 'ko_fi', url: 'https://ko-fi.com/maker' },
					{ platform: 'custom', url: 'https://www.maker.example/tip' },
				],
			}),
			entry('quiet/three', [mod('three')]),
		];
		const found = authorsOf(
			[
				{ source: 'github', id: 'maker/one' },
				{ source: 'github', id: 'maker/two' },
				{ source: 'github', id: 'maker/two' },
				{ source: 'github', id: 'quiet/three' },
				{ source: 'modrinth', id: 'sodium' },
				{ source: 'local', path: './x.jar' },
			],
			entries,
		);

		expect(found).toEqual({
			authors: [
				{
					owner: 'maker',
					host: 'github',
					links: [
						{ url: 'https://ko-fi.com/maker', label: 'Ko-fi' },
						{ url: 'https://www.maker.example/tip', label: 'maker.example' },
					],
					mods: ['maker/one', 'maker/two'],
				},
			],
			unsupported: ['quiet/three'],
			elsewhere: ['modrinth:sodium'],
		});
	});
});

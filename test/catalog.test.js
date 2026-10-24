import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';

import { parseModSpec, refineModSpec } from '../src/commands/context';
import { fit, providerOf, requiredIds } from '../src/mods/catalog';
import { resolveFromRecord, search } from '../src/mods/github';

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
];

beforeAll(async () => {
	index = await mkdtemp(join(tmpdir(), 'ender-catalog-'));

	await mkdir(index, { recursive: true });
	await Bun.write(join(index, 'search.json'), JSON.stringify(listing));
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
		expect(providerOf('modmenu', listing)).toBe('TerraformersMC/ModMenu');
	});

	// ModMenu carries fabric-api-base inside its own jar; Fabric API is still where it comes from.
	test('a bundled module is credited to the release that provides the most', () => {
		expect(providerOf('fabric-api-base', listing)).toBe('FabricMC/fabric-api');
		expect(providerOf('nobody-has-this', listing)).toBeUndefined();
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

		expect((await resolveFromRecord(record, { id: 'a/m' }, context())).version).toBe('1.0');
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

		expect((await resolveFromRecord(record, { id: 'a/m' }, context())).file.filename).toBe('m-fabric-1.0.jar');
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

		expect((await resolveFromRecord(record, { id: 'a/m', asset: '^m\\.jar$' }, context())).file.filename).toBe('m.jar');
	});

	test('nothing fitting leaves it to the GitHub API', async () => {
		const record = { releases: [release('1.0', [asset('m.jar', [mod('m', { minecraft: '~26.1' })])])] };

		expect(await resolveFromRecord(record, { id: 'a/m' }, context())).toBeUndefined();
	});

	test('refuses a jar listed as known bad', async () => {
		const record = { releases: [release('1.0', [asset('m.jar', [mod('m')], { knownBad: 'carries a stealer' })])] };

		await expect(resolveFromRecord(record, { id: 'a/m' }, context())).rejects.toThrow('known bad: carries a stealer');
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
			await resolveFromRecord(record, { id: 'a/m' }, context());

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
});

describe('searching the index', () => {
	test('matches ids and names before descriptions, and leaves out what does not fit or is archived', async () => {
		const hits = await search('backpacks', { index, minecraft: '26.1', loader: 'fabric' });

		expect(hits.map(hit => hit.id)).toEqual(['a/backpacks']);
		expect(await search('backpacks', { index, minecraft: '26.3', loader: 'fabric' })).toEqual([]);
	});

	test('every word of the query has to land somewhere', async () => {
		expect((await search('menu mods', { index })).map(hit => hit.id)).toEqual(['TerraformersMC/ModMenu']);
		expect(await search('menu banana', { index })).toEqual([]);
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
});

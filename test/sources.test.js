import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { fabric } from '../src/meta/fabric';
import { forge, neoforge } from '../src/meta/forge-like';
import * as curseforge from '../src/mods/curseforge';
import * as github from '../src/mods/github';
import * as modrinth from '../src/mods/modrinth';
import { withFetch } from './fetch';

const json = (body, status = 200) => Response.json(body, { status });

describe('Modrinth', () => {
	const versions = [
		{
			id: 'newer',
			version_number: '0.6.0-beta.1',
			name: 'Sodium 0.6.0 beta',
			version_type: 'beta',
			date_published: '2026-10-20T00:00:00Z',
			files: [{ primary: true, filename: 'sodium-0.6.0-beta.1.jar', url: 'https://cdn/beta.jar', size: 2, hashes: {} }],
			dependencies: [],
		},
		{
			id: 'older',
			version_number: '0.5.8',
			name: 'Sodium 0.5.8',
			version_type: 'release',
			date_published: '2026-10-01T00:00:00Z',
			files: [
				{ primary: false, filename: 'sodium-0.5.8-sources.jar', url: 'https://cdn/sources.jar', size: 1 },
				{
					primary: true,
					filename: 'sodium-0.5.8.jar',
					url: 'https://cdn/sodium.jar',
					size: 3,
					hashes: { sha1: 'ABC' },
				},
			],
			dependencies: [
				{ dependency_type: 'required', project_id: 'P3pIqLHM' },
				{ dependency_type: 'optional', project_id: 'mOgUt4GM' },
				{ dependency_type: 'required', version_id: 'only-a-version' },
			],
		},
	];

	test('asks for the versions built for the instance, and takes the newest release, its primary file and what it requires', async () => {
		await withFetch(
			() => json(versions),
			async asked => {
				const resolved = await modrinth.resolve({ id: 'sodium' }, { minecraft: '26.3', loader: 'fabric' });

				expect(asked[0].url).toBe(
					'https://api.modrinth.com/v2/project/sodium/version?loaders=%5B%22fabric%22%5D&game_versions=%5B%2226.3%22%5D',
				);
				expect(resolved).toEqual({
					source: 'modrinth',
					id: 'sodium',
					name: 'Sodium 0.5.8',
					version: '0.5.8',
					file: {
						filename: 'sodium-0.5.8.jar',
						url: 'https://cdn/sodium.jar',
						checksum: { algorithm: 'sha1', value: 'abc' },
						size: 3,
					},
					dependencies: [{ source: 'modrinth', id: 'P3pIqLHM' }],
				});
			},
		);
	});

	test('a pinned version is found by its number or its id, and a prerelease is taken when allowed', async () => {
		await withFetch(
			() => json(versions),
			async () => {
				const context = { minecraft: '26.3', loader: 'fabric' };

				expect((await modrinth.resolve({ id: 'sodium', version: '0.6.0-beta.1' }, context)).version).toBe(
					'0.6.0-beta.1',
				);
				expect((await modrinth.resolve({ id: 'sodium', version: 'newer' }, context)).version).toBe('0.6.0-beta.1');
				expect((await modrinth.resolve({ id: 'sodium' }, { ...context, allowPrerelease: true })).version).toBe(
					'0.6.0-beta.1',
				);
				await expect(modrinth.resolve({ id: 'sodium', version: '9.9' }, context)).rejects.toThrow(
					'modrinth:sodium has no version "9.9"',
				);
			},
		);
	});

	test('says when a project is not one, and when it has nothing for the instance, naming any loader for vanilla', async () => {
		await withFetch(
			url => (url.includes('/project/nope/') ? json({ error: 'not_found' }, 404) : json([])),
			async () => {
				await expect(modrinth.resolve({ id: 'nope' }, { minecraft: '26.3' })).rejects.toThrow(
					'modrinth:nope is not a Modrinth project; ender search finds what it is called',
				);
				await expect(modrinth.resolve({ id: 'sodium' }, { minecraft: '26.3' })).rejects.toThrow(
					'modrinth:sodium has no build for Minecraft 26.3 on any loader',
				);
			},
		);
	});

	test('asks which versions are these very files by sha1, and answers by lowercase hash', async () => {
		await withFetch(
			() => json({ ABC: { project_id: 'p', id: 'v' } }),
			async asked => {
				const found = await modrinth.versionsByHash(['ABC']);

				expect(asked[0]).toMatchObject({ url: 'https://api.modrinth.com/v2/version_files', method: 'POST' });
				expect(JSON.parse(asked[0].body)).toEqual({ hashes: ['ABC'], algorithm: 'sha1' });
				expect([...found]).toEqual([['abc', { project: 'p', version: 'v' }]]);
				expect(await modrinth.versionsByHash([])).toEqual(new Map());
				expect(asked).toHaveLength(1);
			},
		);
	});

	test('searches mods alone, narrowed by loader and game version as facets', async () => {
		await withFetch(
			() => json({ hits: [{ slug: 'sodium', title: 'Sodium', description: 'fast', downloads: 5 }] }),
			async asked => {
				const hits = await modrinth.search('fast', { minecraft: '26.3', loader: 'fabric', limit: 3 });
				const { searchParams } = new URL(asked[0].url);

				expect(searchParams.get('query')).toBe('fast');
				expect(searchParams.get('limit')).toBe('3');
				expect(JSON.parse(searchParams.get('facets'))).toEqual([
					['project_type:mod'],
					['categories:fabric'],
					['versions:26.3'],
				]);
				expect(hits[0]).toMatchObject({ source: 'modrinth', id: 'sodium', name: 'Sodium', downloads: 5 });
			},
		);
	});
});

describe('CurseForge without a key', () => {
	const project = {
		id: 238222,
		title: 'Just Enough Items',
		summary: 'View items and recipes',
		downloads: { total: 9 },
		urls: { curseforge: 'https://www.curseforge.com/minecraft/mc-mods/jei' },
		files: [
			{
				id: 9453343,
				name: 'jei-26.3-neoforge-31.17.0.109.jar',
				display: '31.17.0.109 for NeoForge 26.3',
				type: 'beta',
				filesize: 4793704,
				versions: ['26.3', 'NeoForge'],
				uploaded_at: '2026-11-05T12:32:31.187Z',
			},
			{
				id: 9400001,
				name: 'jei-26.3-neoforge-31.16.0.100.jar',
				display: '31.16.0.100 for NeoForge 26.3',
				type: 'release',
				filesize: 4700000,
				versions: ['26.3', 'NeoForge'],
				uploaded_at: '2026-10-05T00:00:00Z',
			},
			{
				id: 9300001,
				name: 'jei-1.21.1-forge-19.0.0.1.jar',
				display: '19.0.0.1 for Forge 1.21.1',
				type: 'release',
				filesize: 1,
				versions: ['1.21.1', 'Forge'],
				uploaded_at: '2026-09-01T00:00:00Z',
			},
		],
	};
	const siteFile = (id, fileName, releaseType, gameVersions, dateCreated) => ({
		id,
		fileName,
		displayName: fileName,
		fileLength: 10,
		gameVersions,
		releaseType,
		dateCreated,
	});

	test('turns the slug into a project through the mirror, then takes the site API files that fit, release before beta', async () => {
		await withFetch(
			url => {
				if (url === 'https://api.cfwidget.com/minecraft/mc-mods/jei') return json(project);
				if (url === 'https://www.curseforge.com/api/v1/mods/238222/files?pageIndex=0&pageSize=50') {
					return json({
						data: [
							siteFile(2, 'jei-26.3-neoforge-2.jar', 2, ['26.3', 'NeoForge'], '2026-11-05T00:00:00Z'),
							siteFile(1, 'jei-26.3-neoforge-1.jar', 1, ['26.3', 'NeoForge'], '2026-10-05T00:00:00Z'),
							siteFile(3, 'jei-26.3-fabric-3.jar', 1, ['26.3', 'Fabric'], '2026-10-06T00:00:00Z'),
						],
					});
				}
			},
			async () => {
				const resolved = await curseforge.resolve({ id: 'jei' }, { minecraft: '26.3', loader: 'neoforge' });

				expect(resolved).toEqual({
					source: 'curseforge',
					id: 'jei',
					name: 'Just Enough Items',
					version: 'jei-26.3-neoforge-1.jar',
					file: {
						filename: 'jei-26.3-neoforge-1.jar',
						url: 'https://mediafilez.forgecdn.net/files/0/1/jei-26.3-neoforge-1.jar',
						size: 10,
					},
					dependencies: [],
				});
			},
		);
	});

	test("reads the mirror's own files, as the mirror spells them, when the site API does not answer", async () => {
		await withFetch(
			url => (url.startsWith('https://api.cfwidget.com/') ? json(project) : undefined),
			async () => {
				const context = { minecraft: '26.3', loader: 'neoforge' };
				const resolved = await curseforge.resolve({ id: 'jei' }, context);

				expect(resolved.version).toBe('31.16.0.100 for NeoForge 26.3');
				expect(resolved.file).toEqual({
					filename: 'jei-26.3-neoforge-31.16.0.100.jar',
					url: 'https://mediafilez.forgecdn.net/files/9400/1/jei-26.3-neoforge-31.16.0.100.jar',
					size: 4700000,
				});
				expect((await curseforge.resolve({ id: 'jei' }, { ...context, allowPrerelease: true })).version).toBe(
					'31.17.0.109 for NeoForge 26.3',
				);
				expect((await curseforge.resolve({ id: 'jei', version: '9453343' }, context)).file.size).toBe(4793704);
				await expect(curseforge.resolve({ id: '238222' }, { minecraft: '26.3', loader: 'fabric' })).rejects.toThrow(
					'curseforge:238222 has no build for Minecraft 26.3 on fabric',
				);
				await expect(curseforge.resolve({ id: 'jei' }, { minecraft: '1.21.1' })).resolves.toMatchObject({
					version: '19.0.0.1 for Forge 1.21.1',
				});
			},
		);
	});

	test('a project named by number is asked for by number', async () => {
		await withFetch(
			url => (url === 'https://api.cfwidget.com/238222' ? json(project) : undefined),
			async asked => {
				await curseforge.resolve({ id: '238222' }, { minecraft: '26.3', loader: 'neoforge' });

				expect(asked[0].url).toBe('https://api.cfwidget.com/238222');
			},
		);
	});

	test('search without a key looks the words up as one exact slug, and says so', async () => {
		await withFetch(
			url => (url === 'https://api.cfwidget.com/minecraft/mc-mods/just-enough-items' ? json(project) : undefined),
			async () => {
				expect(await curseforge.search('Just Enough Items', {})).toEqual([
					{
						source: 'curseforge',
						id: 'jei',
						name: 'Just Enough Items',
						description: 'View items and recipes',
						downloads: 9,
						exact: true,
					},
				]);
				expect(await curseforge.search('nothing such', {})).toEqual([]);
			},
		);
	});
});

describe('CurseForge with a key', () => {
	const file = (id, fileName, releaseType, fileDate, extra = {}) => ({
		id,
		fileName,
		displayName: fileName,
		fileLength: 7,
		releaseType,
		fileDate,
		hashes: [
			{ algo: 2, value: 'md5md5' },
			{ algo: 1, value: 'SHA1SHA1' },
		],
		dependencies: [
			{ relationType: 3, modId: 306612 },
			{ relationType: 2, modId: 999 },
		],
		...extra,
	});

	test('finds the project by slug and its files by game version and loader, each signed with the key', async () => {
		await withFetch(
			url => {
				if (url.startsWith('https://api.curseforge.com/v1/mods/search?')) {
					return json({ data: [{ id: 238222, name: 'Just Enough Items', slug: 'jei' }] });
				}
				if (url.startsWith('https://api.curseforge.com/v1/mods/238222/files?')) {
					return json({
						data: [
							file(2, 'jei-2.jar', 2, '2026-11-05T00:00:00Z', { downloadUrl: 'https://edge.forgecdn.net/2.jar' }),
							file(1, 'jei-1.jar', 1, '2026-10-05T00:00:00Z', { downloadUrl: null }),
						],
					});
				}
			},
			async asked => {
				const resolved = await curseforge.resolve({ id: 'jei' }, { minecraft: '26.3', loader: 'fabric', key: 'k' });
				const [search, files] = asked.map(request => new URL(request.url));

				expect(asked.every(request => request.headers['x-api-key'] === 'k')).toBe(true);
				expect(Object.fromEntries(search.searchParams)).toEqual({ gameId: '432', classId: '6', slug: 'jei' });
				expect(Object.fromEntries(files.searchParams)).toEqual({
					pageSize: '50',
					gameVersion: '26.3',
					modLoaderType: '4',
				});
				expect(resolved).toEqual({
					source: 'curseforge',
					id: 'jei',
					name: 'Just Enough Items',
					version: 'jei-1.jar',
					file: {
						filename: 'jei-1.jar',
						url: 'https://mediafilez.forgecdn.net/files/0/1/jei-1.jar',
						checksum: { algorithm: 'sha1', value: 'sha1sha1' },
						size: 7,
					},
					dependencies: [{ source: 'curseforge', id: '306612' }],
				});
			},
		);
	});

	test('a slug CurseForge has not got is said, and a project by number is not looked up at all', async () => {
		await withFetch(
			url => (url.includes('/mods/search?') ? json({ data: [] }) : json({ data: [] })),
			async asked => {
				await expect(curseforge.resolve({ id: 'nope' }, { key: 'k' })).rejects.toThrow(
					'CurseForge has no mod with slug "nope"',
				);
				await expect(curseforge.resolve({ id: '42' }, { minecraft: '26.3', key: 'k' })).rejects.toThrow(
					'curseforge:42 has no build for Minecraft 26.3 on any loader',
				);
				expect(asked.map(request => new URL(request.url).pathname)).toEqual(['/v1/mods/search', '/v1/mods/42/files']);
			},
		);
	});
});

describe('GitHub releases, for a repository the index has not crawled', () => {
	let index;

	beforeAll(async () => {
		index = await mkdtemp(join(tmpdir(), 'ender-no-index-'));
	});

	afterAll(async () => {
		await rm(index, { recursive: true, force: true });
	});

	const asset = (name, extra = {}) => ({
		name,
		browser_download_url: `https://github.com/a/m/releases/download/x/${name}`,
		size: 100,
		...extra,
	});
	const releases = [
		{
			tag_name: 'v3.0',
			draft: true,
			prerelease: false,
			published_at: '2026-11-01T00:00:00Z',
			assets: [asset('m-3.0.jar')],
		},
		{
			tag_name: 'v2.0-beta',
			draft: false,
			prerelease: true,
			published_at: '2026-10-20T00:00:00Z',
			assets: [asset('m-2.0-beta.jar')],
		},
		{
			tag_name: 'v1.5',
			draft: false,
			prerelease: false,
			published_at: '2026-10-15T00:00:00Z',
			assets: [asset('notes.txt')],
		},
		{
			tag_name: 'v1.0',
			draft: false,
			prerelease: false,
			published_at: '2026-10-01T00:00:00Z',
			assets: [
				asset('m-1.0-sources.jar'),
				asset('m-1.0.jar', { digest: 'sha256:' + 'f'.repeat(64), size: 4096 }),
				asset('m-1.0-javadoc.jar'),
			],
		},
	];
	const context = extra => ({ minecraft: '26.3', loader: 'fabric', githubToken: 'tok', index, ...extra });

	test('takes the newest release that is neither a draft nor without a jar, its plain jar checked by the digest GitHub lists', async () => {
		await withFetch(
			url => (url === 'https://api.github.com/repos/a/m/releases?per_page=30' ? json(releases) : undefined),
			async asked => {
				const resolved = await github.resolve({ source: 'github', id: 'a/m' }, context());

				expect(asked[0].headers).toMatchObject({ accept: 'application/vnd.github+json', authorization: 'Bearer tok' });
				expect(resolved).toEqual({
					source: 'github',
					id: 'a/m',
					name: 'a/m v1.0',
					version: 'v1.0',
					file: {
						filename: 'm-1.0.jar',
						url: 'https://github.com/a/m/releases/download/x/m-1.0.jar',
						checksum: { algorithm: 'sha256', value: 'f'.repeat(64) },
						size: 4096,
					},
					dependencies: [],
				});
				expect(
					(await github.resolve({ source: 'github', id: 'a/m' }, context({ allowPrerelease: true }))).version,
				).toBe('v2.0-beta');
			},
		);
	});

	test('a pinned tag is asked for as itself, as one path segment', async () => {
		await withFetch(
			url =>
				url === 'https://api.github.com/repos/a/m/releases/tags/v1.0%2Bmc26.3'
					? json({ tag_name: 'v1.0+mc26.3', assets: [asset('m-1.0+mc26.3.jar')] })
					: undefined,
			async asked => {
				const resolved = await github.resolve({ source: 'github', id: 'a/m', version: 'v1.0+mc26.3' }, context());

				expect(asked).toHaveLength(1);
				expect(resolved.file).toEqual({
					filename: 'm-1.0+mc26.3.jar',
					url: 'https://github.com/a/m/releases/download/x/m-1.0+mc26.3.jar',
					checksum: undefined,
					size: 100,
				});
			},
		);
	});

	test('says when no release carries a jar, when a release carries no mod jar, and when the jar names another game', async () => {
		await withFetch(
			url => {
				if (url.includes('/repos/none/x/')) return json([{ tag_name: 'v1', assets: [asset('notes.txt')] }]);
				if (url.includes('/repos/only/x/')) {
					return json([{ tag_name: 'v1', assets: [asset('x-sources.jar'), asset('x-javadoc.jar')] }]);
				}
				if (url.includes('/repos/old/x/')) return json([{ tag_name: 'v1', assets: [asset('x-mc1.20.1.jar')] }]);
			},
			async () => {
				await expect(github.resolve({ source: 'github', id: 'none/x' }, context())).rejects.toThrow(
					'github:none/x has no release carrying a jar',
				);
				await expect(github.resolve({ source: 'github', id: 'only/x' }, context())).rejects.toThrow(
					'github:only/x release v1 has no mod jar. It ships: x-sources.jar, x-javadoc.jar. Narrow it with an "asset" pattern.',
				);
				await expect(github.resolve({ source: 'github', id: 'old/x' }, context())).rejects.toThrow(
					'github:old/x v1 ships x-mc1.20.1.jar, which its name says is for another Minecraft than 26.3. For Modrinth write mr:x, for CurseForge cf:x.',
				);
			},
		);
	});

	test('the newest full release carrying a file of a kind, for a pack kept in a repository', async () => {
		await withFetch(
			() =>
				json([
					{ tag_name: 'v2', draft: false, prerelease: true, assets: [asset('pack-2.mrpack')] },
					{ tag_name: 'v1', draft: false, prerelease: false, assets: [asset('readme.md'), asset('pack-1.mrpack')] },
				]),
			async () => {
				expect((await github.newestAsset('a/pack', '.mrpack', 'tok')).name).toBe('pack-1.mrpack');
				expect(await github.newestAsset('a/pack', '.zip', 'tok')).toBeUndefined();
			},
		);
	});
});

describe('the loader meta services', () => {
	test('Fabric takes the newest stable loader for a game version, and says when it has none yet', async () => {
		await withFetch(
			url => {
				if (url === 'https://meta.fabricmc.net/v2/versions/loader/26.3') {
					return json([
						{ loader: { version: '0.20.0-beta.1', stable: false } },
						{ loader: { version: '0.19.5', stable: true } },
					]);
				}
				if (url === 'https://meta.fabricmc.net/v2/versions/loader/26w40a') return json({ message: 'bad' }, 400);
				if (url === 'https://meta.fabricmc.net/v2/versions/loader/26.9') return json([]);
			},
			async () => {
				expect(await fabric.latestLoader('26.3')).toBe('0.19.5');
				await expect(fabric.latestLoader('26w40a')).rejects.toThrow('Fabric has no loader for Minecraft 26w40a yet');
				await expect(fabric.latestLoader('26.9')).rejects.toThrow('Fabric publishes no loader for Minecraft 26.9');
			},
		);
	});

	test('a Fabric profile is asked for by game and loader, the server one marked as such', async () => {
		await withFetch(
			() => json({ mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotServer', libraries: [] }),
			async asked => {
				await fabric.profile('26.3', '0.19.5', 'server');
				await fabric.profile('26.3', '0.19.5');

				expect(asked.map(request => request.url)).toEqual([
					'https://meta.fabricmc.net/v2/versions/loader/26.3/0.19.5/profile/json?server=true',
					'https://meta.fabricmc.net/v2/versions/loader/26.3/0.19.5/profile/json',
				]);
			},
		);
	});

	test("a Fabric profile's libraries are maven coordinates, laid out under the shared library tree", () => {
		const [job] = fabric.libraryJobs({
			libraries: [{ name: 'net.fabricmc:fabric-loader:0.19.5', sha1: 'AB', size: 5 }],
		});

		expect(job).toMatchObject({
			name: 'net.fabricmc:fabric-loader:0.19.5',
			url: 'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar',
			checksum: { algorithm: 'sha1', value: 'ab' },
			size: 5,
		});
		expect(job.path).toEndWith(join('net', 'fabricmc', 'fabric-loader', '0.19.5', 'fabric-loader-0.19.5.jar'));
	});

	test('Forge offers the recommended and latest builds for a game version, NeoForge those numbered after it', async () => {
		await withFetch(
			url => {
				if (url.includes('promotions_slim.json')) {
					return json({
						promos: { '1.21.1-recommended': '52.0.40', '1.21.1-latest': '52.1.1', '1.20.1-latest': '47.3.0' },
					});
				}
				if (url.includes('neoforged.net/api/maven/versions')) {
					return json({ versions: ['21.0.167', '21.1.5-beta', '21.1.200', '26.3.1', '26.3.2'] });
				}
			},
			async () => {
				expect(await forge.versionsFor('1.21.1')).toEqual(['52.0.40', '52.1.1']);
				expect(await forge.latestLoader('1.21.1')).toBe('52.1.1');
				await expect(forge.latestLoader('26.3')).rejects.toThrow('Forge has no build for Minecraft 26.3 yet');
				expect(await neoforge.versionsFor('1.21.1')).toEqual(['21.1.5-beta', '21.1.200']);
				expect(await neoforge.versionsFor('1.21')).toEqual(['21.0.167']);
				expect(await neoforge.versionsFor('26.3')).toEqual(['26.3.1', '26.3.2']);
				expect(await neoforge.latestLoader('26.3')).toBe('26.3.2');
			},
		);
	});
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { siteModule } from '../scripts/embedSite';
import { INSTANCE, SPEC, allowed, buildSibling, servePage, siteFiles, webApi } from '../src/commands/web';
import { KEPT_JOBS, detach, jobRunner } from '../src/jobs';

const ORIGIN = 'http://localhost:7460';

const request = (path, { method = 'GET', host = 'localhost:7460', origin, body, type = 'application/json' } = {}) =>
	new Request(`http://${host}${path}`, {
		method,
		headers: { host, ...(origin ? { origin } : {}), ...(method === 'GET' ? {} : { 'content-type': type }) },
		...(['POST', 'DELETE'].includes(method) ? { body: body ?? '{}' } : {}),
	});

/** A job runner that runs nothing: each job prints what it was asked and ends as `code` says. */
const scratch = [];

const fakeJobs = async (code = 0) => {
	const directory = await mkdtemp(join(tmpdir(), 'ender-jobs-'));

	scratch.push(directory);
	const started = [];
	const jobs = jobRunner({
		command: args => args,
		directory: () => directory,
		start: async (argv, log) => {
			started.push(argv);
			await Bun.write(log, `:: ${argv.join(' ')}\nok done\n`);

			return { code };
		},
	});

	return { jobs, started, directory };
};

let site;

beforeAll(async () => {
	site = await mkdtemp(join(tmpdir(), 'ender-web-'));
	await Bun.write(join(site, 'index.html'), '<!doctype html><title>index</title>');
	await Bun.write(join(site, '@fontsource/font.woff2'), new Uint8Array([1, 2, 3]));
});

afterAll(() => Promise.all([site, ...scratch].map(path => rm(path, { recursive: true, force: true }))));

describe('ender web', () => {
	test('answers a page served from this machine, and only that', () => {
		expect(allowed(request('/api/instances'))).toBe(true);
		expect(allowed(request('/api/instances/a/add', { method: 'POST', origin: 'http://localhost:7460' }))).toBe(true);
		expect(allowed(request('/api/instances/a/add', { method: 'POST', origin: 'https://evil.example' }))).toBe(false);
		expect(allowed(request('/api/instances/a/add', { method: 'POST' }))).toBe(false);
		expect(allowed(request('/api/instances', { host: 'evil.example:7460' }))).toBe(false);
		expect(allowed(request('/', { host: 'localhost:9000' }), 9000)).toBe(true);
	});

	test('adds only what search writes, to an instance by name, never a path, a url or a flag', () => {
		expect(SPEC.test('gh:owner/repo')).toBe(true);
		expect(SPEC.test('gl:group/sub/project')).toBe(true);
		expect(SPEC.test('mr:sodium')).toBe(true);
		expect(SPEC.test('./evil.jar')).toBe(false);
		expect(SPEC.test('https://evil.example/x.jar')).toBe(false);
		expect(SPEC.test('gh:owner/repo --instance other')).toBe(false);
		expect(SPEC.test('gh:../../etc')).toBe(false);
		expect(INSTANCE.test('suite')).toBe(true);
		expect(INSTANCE.test('../etc')).toBe(false);
		expect(INSTANCE.test('--purge')).toBe(false);
		expect(INSTANCE.test('-y')).toBe(false);
		expect(INSTANCE.test('my pack')).toBe(false);
	});

	test('refuses a write that is not JSON, as a form carried in a readme on the page would send it', async () => {
		const { jobs, started } = await fakeJobs();
		const api = webApi({ jobs });
		const form = request('/api/instances', {
			method: 'POST',
			origin: ORIGIN,
			type: 'text/plain',
			body: '{"name":"cozy","specs":["gh:attacker/evil"],"x":"="}',
		});

		expect((await api(form)).status).toBe(415);
		expect(started).toEqual([]);
	});

	test('answers what ender answers as JSON from its stdout alone, and says when it is not JSON', async () => {
		const answers = {
			ls: { code: 0, stdout: '[]', stderr: '!! a warning on the way' },
			info: { code: 1, stdout: '', stderr: 'xx No instance named gone' },
		};
		const api = webApi({ run: async ([verb]) => answers[verb] ?? { code: 0, stdout: 'not json', stderr: '' } });

		expect(await (await api(request('/api/instances'))).json()).toEqual([]);

		const missing = await api(request('/api/instances/gone'));

		expect(missing.status).toBe(502);
		expect(await missing.json()).toEqual({ error: 'xx No instance named gone' });
		expect((await api(request('/api/instances/..%2Fetc'))).status).toBe(400);
		expect((await api(request('/api/instances/%E0%A4%A'))).status).toBe(400);
		expect((await api(request('/api/other'))).status).toBe(404);
		expect(await api(request('/index.html'))).toBeUndefined();
	});

	test('answers which ender it is without running anything', async () => {
		const api = webApi({ run: () => expect.unreachable() });
		const { version } = await import('../package.json');

		expect(await (await api(request('/api/ender'))).json()).toEqual({ version });
	});

	test('starts what takes a while as a job the page follows, and refuses what it refuses before starting anything', async () => {
		const { jobs, started } = await fakeJobs();
		const api = webApi({ jobs });
		const send = (method, path, body) => api(request(path, { method, origin: ORIGIN, body: JSON.stringify(body) }));
		const post = (path, body) => send('POST', path, body);
		const startedJob = async response => {
			expect(response.status).toBe(202);

			const { job } = await response.json();

			await jobs.get(job.id).finished;

			return job;
		};

		await startedJob(
			await post('/api/instances', { name: 'family', minecraft: '26.3', loader: 'fabric', specs: ['mr:sodium'] }),
		);
		expect((await post('/api/instances', { name: '../x' })).status).toBe(400);
		expect((await post('/api/instances', { name: '--purge' })).status).toBe(400);
		expect((await post('/api/instances', { name: 'x', loader: 'bukkit' })).status).toBe(400);
		expect((await post('/api/instances', { name: 'x', minecraft: '26.3 --gameDir /' })).status).toBe(400);
		expect((await post('/api/instances', { name: 'x', minecraft: '--demo' })).status).toBe(400);
		expect((await post('/api/instances', { name: 'x', specs: ['./evil.jar'] })).status).toBe(400);
		await startedJob(await post('/api/import', { source: 'gist:a1db98319884288ad3d83a0db854291f' }));
		expect((await post('/api/import', { source: '/home/me/pack.zip' })).status).toBe(400);
		expect((await post('/api/import', { source: 'http://plain.example/pack.zip' })).status).toBe(400);
		await startedJob(await post('/api/instances/family/add', { specs: ['gh:me/mod'] }));
		await startedJob(await post('/api/instances/family/add', { specs: ['gh:me/source'], build: true }));
		expect((await post('/api/instances/family/add', { specs: ['./evil.jar'] })).status).toBe(400);
		await startedJob(await post('/api/instances/family/update'));
		await startedJob(await post('/api/instances/family/launch', { update: true }));

		const deleted = await startedJob(await send('DELETE', '/api/instances/family'));
		const followed = await (await api(request(`/api/jobs/${deleted.id}?from=1`))).json();

		expect(followed).toMatchObject({ state: 'done', code: 0, title: 'Deleting family', lines: ['ok done'], next: 2 });
		expect(started).toEqual([
			['new', 'family', 'mr:sodium', '--minecraft', '26.3', '--loader', 'fabric'],
			['import', 'gist:a1db98319884288ad3d83a0db854291f', '--sync'],
			['add', 'gh:me/mod', '--instance', 'family'],
			['add', 'gh:me/source', '--build', '--instance', 'family'],
			['update', '--instance', 'family'],
			['launch', 'family', '--update'],
			['delete', 'family', '--yes'],
		]);
		expect((await (await api(request('/api/jobs'))).json()).map(job => job.title)[0]).toBe('Deleting family');
	});

	test('runs one job on an instance at a time, and says which one holds it', async () => {
		let release;
		const jobs = jobRunner({
			command: args => args,
			directory: () => site,
			start: () => new Promise(resolve => (release = resolve)),
		});
		const api = webApi({ jobs });
		const launch = () => api(request('/api/instances/family/launch', { method: 'POST', origin: ORIGIN, body: '{}' }));

		expect((await launch()).status).toBe(202);

		const busy = await launch();

		expect(busy.status).toBe(409);
		expect((await busy.json()).error).toBe('family is busy: Playing family');

		release({ code: 1 });
		await Promise.all(jobs.list().map(job => job.finished));
		expect(jobs.list()[0]).toMatchObject({ state: 'failed', code: 1 });
		expect((await launch()).status).toBe(202);
	});

	test("publishes a list as a pack of only a pack's fields, and an instance through ender export", async () => {
		const published = [];
		const ran = [];
		const api = webApi({
			publish: async pack => {
				published.push(pack);

				return { id: 'abc', url: 'https://gist.github.com/abc', line: 'ender import gist:abc', updated: false };
			},
			run: async args => {
				ran.push(args);

				return { code: 0, stdout: '{"id":"def","updated":true,"left":[]}', stderr: '' };
			},
		});
		const post = (path, body) => api(request(path, { method: 'POST', origin: ORIGIN, body: JSON.stringify(body) }));
		const pack = { name: 'mine', minecraft: '26.3', loader: 'fabric', mods: ['gh:me/mod'] };

		expect((await (await post('/api/gists', { pack: { ...pack, extra: 'kept out' } })).json()).id).toBe('abc');
		expect(published).toEqual([pack]);
		expect((await post('/api/gists', { pack: { ...pack, mods: ['./evil.jar'] } })).status).toBe(400);
		expect((await post('/api/gists', { pack: { mods: [] } })).status).toBe(400);
		expect((await (await post('/api/instances/family/gist')).json()).updated).toBe(true);
		await post('/api/instances/family/gist', { fresh: true });
		expect(ran).toEqual([
			['export', 'family', '--gist', '--json'],
			['export', 'family', '--gist', '--json', '--new'],
		]);
	});

	test('serves the site built in as it serves one from a directory, and nothing outside it', async () => {
		const fromDirectory = await siteFiles(site);
		const module = await siteModule(site);
		const built = new Map(
			Object.entries(JSON.parse(module.slice('export default '.length, -2))).map(([path, data]) => [
				path,
				Buffer.from(data, 'base64'),
			]),
		);

		for (const files of [fromDirectory, built]) {
			expect([...files.keys()].toSorted()).toEqual(['@fontsource/font.woff2', 'index.html']);
			expect(servePage(files, '/').headers.get('content-type')).toStartWith('text/html');
			expect(servePage(files, '/').headers.get('cache-control')).toBe('no-cache');
			expect(servePage(files, '/@fontsource/font.woff2').headers.get('content-type')).toBe('font/woff2');
			expect(servePage(files, '/../../etc/passwd')).toBeUndefined();
			expect(servePage(files, '/missing.js')).toBeUndefined();
		}
	});

	test('a checkout builds the index beside it for each start, and says so when that build fails', async () => {
		const index = await mkdtemp(join(tmpdir(), 'ender-web-index-'));

		try {
			expect(await buildSibling(index)).toBeUndefined();

			await Bun.write(
				join(index, 'package.json'),
				JSON.stringify({ scripts: { 'build:site': 'echo broken && exit 3' } }),
			);
			await expect(buildSibling(index)).rejects.toThrow('did not build: broken');

			const files = await siteFiles(undefined, { sibling: async () => site });

			expect(files.has('index.html')).toBe(true);
			expect(await siteFiles(undefined, { sibling: async () => undefined })).toBeUndefined();
		} finally {
			await rm(index, { recursive: true, force: true });
		}
	});

	test('refuses to embed a directory that is not a built site', async () => {
		const empty = await mkdtemp(join(tmpdir(), 'ender-web-empty-'));

		try {
			await expect(siteModule(empty)).rejects.toThrow('has no index.html');
		} finally {
			await rm(empty, { recursive: true, force: true });
		}
	});
});

describe('stars', () => {
	test('are listed and set through the account ender signs in with, for an owner/repo and nothing else', async () => {
		const set = [];
		const api = webApi({
			stars: {
				list: async () => ['me/mod'],
				set: async (repository, starring) => {
					set.push([repository, starring]);
				},
			},
		});
		const send = (method, path) => api(request(path, { method, origin: ORIGIN, body: '{}' }));

		expect(await (await api(request('/api/stars', { origin: ORIGIN }))).json()).toEqual({ repositories: ['me/mod'] });
		expect((await send('PUT', '/api/stars/me/mod')).status).toBe(200);
		expect((await send('DELETE', '/api/stars/me/mod')).status).toBe(200);
		expect((await send('PUT', '/api/stars/../user')).status).toBe(404);
		expect((await send('PUT', '/api/stars/me/%2E%2E')).status).toBe(404);
		expect((await send('POST', '/api/stars/me/mod')).status).toBe(404);
		expect(set).toEqual([
			['me/mod', true],
			['me/mod', false],
		]);
	});

	test('say how to sign in when there is no account to keep them', async () => {
		const api = webApi({
			stars: {
				list: async () => {
					throw Object.assign(new Error('This needs a GitHub account'), { status: 401 });
				},
			},
		});
		const answer = await api(request('/api/stars', { origin: ORIGIN }));

		expect(answer.status).toBe(401);
		expect((await answer.json()).error).toContain('GitHub account');
	});

	test('are read from GitHub page by page, and a refusal says the token needs starring', async () => {
		const { setStar, starredRepositories } = await import('../src/stars');
		const asked = [];
		const fetcher = async (url, init) => {
			asked.push(`${init.method ?? 'GET'} ${url}`);

			if (url.includes('page=2')) return Response.json([{ full_name: 'b/two' }]);
			if (init.method === 'PUT') return Response.json({ message: 'Resource not accessible' }, { status: 403 });

			return Response.json([{ full_name: 'a/one' }], {
				headers: { link: '<https://api.github.com/user/starred?per_page=100&page=2>; rel="next"' },
			});
		};

		expect(await starredRepositories({ configured: 'token', fetcher })).toEqual(['a/one', 'b/two']);
		await expect(setStar('a/one', true, { configured: 'token', fetcher })).rejects.toThrow('allowed to star');
		expect(asked).toEqual([
			'GET https://api.github.com/user/starred?per_page=100',
			'GET https://api.github.com/user/starred?per_page=100&page=2',
			'PUT https://api.github.com/user/starred/a/one',
		]);
	});
});

describe('issues on the index', () => {
	test('are filed as the signed-in account for an ask or a pack, and only in the shapes the index reads', async () => {
		const filed = [];
		const api = webApi({
			account: async () => 'me',
			fileIssue: async (kind, answer) => {
				filed.push([kind, answer]);

				return { number: 7, url: 'https://github.com/fatlard1993/ender-index/issues/7' };
			},
		});
		const post = (path, body) => api(request(path, { method: 'POST', origin: ORIGIN, body: JSON.stringify(body) }));

		expect(await (await api(request('/api/account', { origin: ORIGIN }))).json()).toEqual({ login: 'me' });
		expect((await post('/api/asks', { kind: 'fund', mod: 'github:a/b' })).status).toBe(201);
		expect((await post('/api/asks', { kind: 'release', mod: 'gitlab:g/sub/p' })).status).toBe(201);
		expect(
			(await post('/api/listings', { pack: 'https://gist.github.com/me/0123456789ABCDEF0123456789abcdef/raw' })).status,
		).toBe(201);
		expect((await post('/api/listings', { pack: 'gh:me/pack' })).status).toBe(201);
		expect((await post('/api/asks', { kind: 'anything', mod: 'github:a/b' })).status).toBe(400);
		expect((await post('/api/asks', { kind: 'fund', mod: 'github:a/b\n### Pack' })).status).toBe(400);
		expect((await post('/api/asks', { kind: 'fund', mod: 'github:../b' })).status).toBe(400);
		expect((await post('/api/listings', { pack: 'https://example.com/pack' })).status).toBe(400);
		expect(filed).toEqual([
			['fund', 'github:a/b'],
			['release', 'gitlab:g/sub/p'],
			['pack', 'gist:0123456789abcdef0123456789abcdef'],
			['pack', 'gh:me/pack'],
		]);

		const again = webApi({ fileIssue: async () => ({ number: 7, url: 'https://github.com/x/7', before: true }) });
		const answer = await again(
			request('/api/asks', {
				method: 'POST',
				origin: ORIGIN,
				body: JSON.stringify({ kind: 'fund', mod: 'github:a/b' }),
			}),
		);

		expect(answer.status).toBe(200);
		expect(await answer.json()).toMatchObject({ before: true });
	});

	test("are written as the index's issue form writes them, under its title and labels", async () => {
		const { fileIndexIssue } = await import('../src/indexIssues');
		let asked;
		const result = await fileIndexIssue('fund', 'github:a/b', {
			configured: 'token',
			fetcher: async (url, init = {}) => {
				if (url.endsWith('/user')) return Response.json({ login: 'me' });
				if (init.method !== 'POST') return Response.json([]);

				asked = { url, ...init, body: JSON.parse(init.body) };

				return Response.json({ number: 7, html_url: 'https://github.com/x/7' }, { status: 201 });
			},
		});

		expect(asked.url).toBe('https://api.github.com/repos/fatlard1993/ender-index/issues');
		expect(asked.body).toEqual({
			title: "I would pay this mod's author",
			labels: ['interest', 'fund'],
			body: '### Mod\n\ngithub:a/b\n',
		});
		expect(result).toEqual({ number: 7, url: 'https://github.com/x/7' });
	});

	test('are not filed again by an account that filed the same one before, open or closed', async () => {
		const { fileIndexIssue } = await import('../src/indexIssues');
		const asked = [];
		const opened = [
			{
				number: 2,
				title: "I would pay this mod's author",
				body: '### Mod\n\ngithub:a/other',
				html_url: 'https://github.com/x/2',
			},
			{
				number: 3,
				title: "I would pay this mod's author",
				body: '### Mod\n\ngithub:a/b',
				html_url: 'https://github.com/x/3',
			},
		];
		const fetcher = async (url, init = {}) => {
			asked.push(`${init.method ?? 'GET'} ${url}`);

			if (url.endsWith('/user')) return Response.json({ login: 'me' });
			if (init.method !== 'POST') return Response.json(opened);

			return Response.json({ number: 9, html_url: 'https://github.com/x/9' }, { status: 201 });
		};

		expect(await fileIndexIssue('fund', 'github:a/b', { configured: 'token', fetcher })).toEqual({
			number: 3,
			url: 'https://github.com/x/3',
			before: true,
		});
		expect(asked).toContain(
			'GET https://api.github.com/repos/fatlard1993/ender-index/issues?creator=me&state=all&per_page=100',
		);
		expect(asked.some(line => line.startsWith('POST'))).toBe(false);
		expect((await fileIndexIssue('release', 'github:a/b', { configured: 'token', fetcher })).number).toBe(9);
	});
});

describe('publishing a gist', () => {
	test('a secret gist holding ender.pack.json, under the account ender signs in with', async () => {
		const { publishPack } = await import('../src/gist');
		let asked;
		const result = await publishPack(
			{ name: 'family', minecraft: '26.3', loader: 'fabric', mods: ['mr:sodium'] },
			{
				configured: 'token',
				fetcher: async (url, init) => {
					asked = { url, ...init, body: JSON.parse(init.body) };

					return Response.json({ id: 'abc', html_url: 'https://gist.github.com/abc' }, { status: 201 });
				},
			},
		);

		expect(asked.url).toBe('https://api.github.com/gists');
		expect(asked.headers.authorization).toBe('Bearer token');
		expect(asked.body.public).toBe(false);
		expect(JSON.parse(asked.body.files['ender.pack.json'].content).name).toBe('family');
		expect(result).toEqual({
			id: 'abc',
			url: 'https://gist.github.com/abc',
			line: 'ender import gist:abc',
			updated: false,
		});
	});

	test('updates the gist published before, so its followers get the change, and publishes anew when it is gone', async () => {
		const { publishPack } = await import('../src/gist');
		const asked = [];
		const answering = gone => async (url, init) => {
			asked.push(`${init.method} ${url}`);

			if (init.method === 'PATCH' && gone) return Response.json({ message: 'Not Found' }, { status: 404 });

			return Response.json({ id: gone ? 'new' : 'abc', html_url: 'https://gist.github.com/x' });
		};
		const pack = { name: 'family', minecraft: '26.3', loader: 'fabric', mods: [] };

		expect(await publishPack(pack, { id: 'abc', configured: 'token', fetcher: answering(false) })).toMatchObject({
			id: 'abc',
			updated: true,
		});
		expect(await publishPack(pack, { id: 'abc', configured: 'token', fetcher: answering(true) })).toMatchObject({
			id: 'new',
			updated: false,
		});
		expect(asked).toEqual([
			'PATCH https://api.github.com/gists/abc',
			'PATCH https://api.github.com/gists/abc',
			'POST https://api.github.com/gists',
		]);
	});

	test('says what GitHub refused, and what a token without the gist scope needs', async () => {
		const { publishPack } = await import('../src/gist');

		await expect(
			publishPack(
				{ minecraft: '26.3', loader: 'fabric', mods: [] },
				{ configured: 'token', fetcher: async () => Response.json({ message: 'Not Found' }, { status: 404 }) },
			),
		).rejects.toThrow('the token needs the gist scope');
		await expect(
			publishPack(
				{ minecraft: '26.3', loader: 'fabric', mods: [] },
				{
					configured: 'token',
					fetcher: async () => Response.json({ message: 'API rate limit exceeded' }, { status: 403 }),
				},
			),
		).rejects.toThrow(/^GitHub would not create the gist \(403: API rate limit exceeded\)$/);
	});
});

describe('jobs', () => {
	test('run let go, with what they print kept, and how they ended', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ender-jobs-'));

		try {
			const jobs = jobRunner({ command: args => [process.execPath, '-e', ...args], directory: () => directory });
			const good = await jobs.start(['console.log(":: one"); console.error("!! two")'], { title: 'good' });
			const bad = await jobs.start(['console.log("xx broke"); process.exit(3)'], { title: 'bad' });

			await Promise.all([good.finished, bad.finished]);

			expect(good).toMatchObject({ state: 'done', code: 0 });
			expect(await jobs.lines(good)).toEqual([':: one', '!! two']);
			expect(bad).toMatchObject({ state: 'failed', code: 3 });
			expect(await jobs.lines(bad, 0)).toEqual(['xx broke']);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('say so when the command could not start at all', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ender-jobs-'));

		try {
			const result = await detach(['/no/such/ender'], join(directory, 'x.log'));

			expect(result.code).toBe(127);
			expect(result.error).toContain('ENOENT');
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test(`keep the last ${KEPT_JOBS} that ended, and their logs`, async () => {
		const { jobs, directory } = await fakeJobs();

		try {
			for (let index = 0; index < KEPT_JOBS + 2; index++) await (await jobs.start([`${index}`], {})).finished;

			expect(jobs.list()).toHaveLength(KEPT_JOBS);
			expect(jobs.list().at(-1).log).toEndWith('.log');
			expect([...new Bun.Glob('*.log').scanSync({ cwd: directory })]).toHaveLength(KEPT_JOBS);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

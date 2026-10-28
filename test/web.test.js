import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { siteModule } from '../scripts/embedSite';
import { INSTANCE, SPEC, allowed, servePage, siteFiles, webApi } from '../src/commands/web';

const request = (path, { method = 'GET', host = 'localhost:7460', origin, body } = {}) =>
	new Request(`http://${host}${path}`, {
		method,
		headers: { host, ...(origin ? { origin } : {}) },
		...(method === 'POST' ? { body: body ?? '{}' } : {}),
	});

let site;

beforeAll(async () => {
	site = await mkdtemp(join(tmpdir(), 'ender-web-'));
	await Bun.write(join(site, 'index.html'), '<!doctype html><title>index</title>');
	await Bun.write(join(site, '@fontsource/font.woff2'), new Uint8Array([1, 2, 3]));
});

afterAll(() => rm(site, { recursive: true, force: true }));

describe('ender web', () => {
	test('answers a page served from this machine, and only that', () => {
		expect(allowed(request('/api/instances'))).toBe(true);
		expect(allowed(request('/api/instances/a/add', { method: 'POST', origin: 'http://localhost:7460' }))).toBe(true);
		expect(allowed(request('/api/instances/a/add', { method: 'POST', origin: 'https://evil.example' }))).toBe(false);
		expect(allowed(request('/api/instances/a/add', { method: 'POST' }))).toBe(false);
		expect(allowed(request('/api/instances', { host: 'evil.example:7460' }))).toBe(false);
		expect(allowed(request('/', { host: 'localhost:9000' }), 9000)).toBe(true);
	});

	test('adds only what search writes, to an instance by name, never a path, a url or another flag', () => {
		expect(SPEC.test('gh:owner/repo')).toBe(true);
		expect(SPEC.test('gl:group/sub/project')).toBe(true);
		expect(SPEC.test('mr:sodium')).toBe(true);
		expect(SPEC.test('./evil.jar')).toBe(false);
		expect(SPEC.test('https://evil.example/x.jar')).toBe(false);
		expect(SPEC.test('gh:owner/repo --instance other')).toBe(false);
		expect(SPEC.test('gh:../../etc')).toBe(false);
		expect(INSTANCE.test('suite')).toBe(true);
		expect(INSTANCE.test('../etc')).toBe(false);
	});

	test('answers the page by running ender, and runs nothing for what it refuses', async () => {
		const ran = [];
		const api = webApi({
			run: async args => {
				ran.push(args);

				return { code: 0, output: args[0] === 'add' ? 'added' : '[]' };
			},
		});
		const post = (path, specs) =>
			api(request(path, { method: 'POST', origin: 'http://localhost:7460', body: JSON.stringify({ specs }) }));

		expect(await (await api(request('/api/instances'))).json()).toEqual([]);
		expect((await post('/api/instances/suite/add', ['mr:sodium'])).status).toBe(200);
		expect((await post('/api/instances/suite/add', ['./evil.jar'])).status).toBe(400);
		expect((await api(request('/api/instances/..%2Fetc'))).status).toBe(400);
		expect((await api(request('/api/other'))).status).toBe(404);
		expect(await api(request('/index.html'))).toBeUndefined();
		expect(ran).toEqual([
			['ls', '--json'],
			['add', 'mr:sodium', '--instance', 'suite'],
		]);
	});

	test('says what ender said when it fails, rather than answering as if it worked', async () => {
		const api = webApi({ run: async () => ({ code: 1, output: 'No instance named gone' }) });
		const response = await api(request('/api/instances/gone'));

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: 'No instance named gone' });
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
			expect(servePage(files, '/@fontsource/font.woff2').headers.get('content-type')).toBe('font/woff2');
			expect(servePage(files, '/../../etc/passwd')).toBeUndefined();
			expect(servePage(files, '/missing.js')).toBeUndefined();
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

	test('makes, imports, updates, launches and deletes instances by the same rules, and refuses what they refuse', async () => {
		const ran = [];
		const started = [];
		const api = webApi({
			run: async args => {
				ran.push(args);

				return { code: 0, output: '' };
			},
			start: async (args, name) => {
				started.push([args, name]);

				return { log: `/logs/${name}.log` };
			},
		});
		const send = (method, path, body) =>
			api(request(path, { method, origin: 'http://localhost:7460', body: JSON.stringify(body) }));
		const post = (path, body) => send('POST', path, body);

		expect(
			(await post('/api/instances', { name: 'family', minecraft: '26.3', loader: 'fabric', specs: ['mr:sodium'] }))
				.status,
		).toBe(200);
		expect((await post('/api/instances', { name: '../x' })).status).toBe(400);
		expect((await post('/api/instances', { name: 'x', loader: 'bukkit' })).status).toBe(400);
		expect((await post('/api/instances', { name: 'x', minecraft: '26.3 --gameDir /' })).status).toBe(400);
		expect((await post('/api/instances', { name: 'x', specs: ['./evil.jar'] })).status).toBe(400);
		expect((await post('/api/import', { source: 'gist:a1db98319884288ad3d83a0db854291f' })).status).toBe(200);
		expect((await post('/api/import', { source: 'gh:me/pack' })).status).toBe(200);
		expect((await post('/api/import', { source: '/home/me/pack.zip' })).status).toBe(400);
		expect((await post('/api/import', { source: 'http://plain.example/pack.zip' })).status).toBe(400);
		expect((await post('/api/instances/family/update')).status).toBe(200);
		expect((await post('/api/instances/family/launch', { update: true })).status).toBe(202);
		expect((await send('DELETE', '/api/instances/family')).status).toBe(200);
		expect(ran).toEqual([
			['new', 'family', 'mr:sodium', '--minecraft', '26.3', '--loader', 'fabric'],
			['import', 'gist:a1db98319884288ad3d83a0db854291f'],
			['import', 'gh:me/pack'],
			['update', '--instance', 'family'],
			['delete', 'family', '--yes'],
		]);
		expect(started).toEqual([[['launch', 'family', '--update'], 'family']]);
	});

	test("publishes a list as a pack, or an instance's chosen mods, and only a pack of specs search writes", async () => {
		const published = [];
		const api = webApi({
			publish: async pack => {
				published.push(pack);

				return { id: 'abc', url: 'https://gist.github.com/abc', line: 'ender import gist:abc' };
			},
			packOf: async name => ({ name, minecraft: '26.3', loader: 'fabric', mods: ['mr:sodium'] }),
		});
		const post = (path, body) =>
			api(request(path, { method: 'POST', origin: 'http://localhost:7460', body: JSON.stringify(body) }));
		const pack = { name: 'mine', minecraft: '26.3', loader: 'fabric', mods: ['gh:me/mod'] };

		expect(await (await post('/api/gists', { pack })).json()).toEqual({
			id: 'abc',
			url: 'https://gist.github.com/abc',
			line: 'ender import gist:abc',
		});
		expect((await post('/api/gists', { pack: { ...pack, mods: ['./evil.jar'] } })).status).toBe(400);
		expect((await post('/api/gists', { pack: { mods: [] } })).status).toBe(400);
		expect((await post('/api/instances/family/gist')).status).toBe(200);
		expect(published.map(each => each.name)).toEqual(['mine', 'family']);
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
		expect(result).toEqual({ id: 'abc', url: 'https://gist.github.com/abc', line: 'ender import gist:abc' });
	});

	test('says what GitHub refused, and what a token without the gist scope needs', async () => {
		const { publishPack } = await import('../src/gist');

		await expect(
			publishPack(
				{ minecraft: '26.3', loader: 'fabric', mods: [] },
				{ configured: 'token', fetcher: async () => Response.json({ message: 'Not Found' }, { status: 404 }) },
			),
		).rejects.toThrow('the token needs the gist scope');
	});
});

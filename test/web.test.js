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
});

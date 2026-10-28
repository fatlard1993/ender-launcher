import { join, normalize, sep } from 'node:path';

import { openInBrowser } from '../browser';
import { done, info, paint } from '../out';
import { isCompiled } from './upgrade';

export const PORT = 7460;

/**
 * What the page may ask ender to add or drop: a repository or a project by the prefixes search writes. A path or a url
 * is refused, because then any page that reached this server could put any jar in an instance.
 */
export const SPEC = /^(gh|cb|gl|mr|cf):[\w-][\w.-]*(\/[\w-][\w.-]*)*$/;

export const INSTANCE = /^[\w-][\w.-]*$/;

/**
 * A request this server answers. It runs ender on this machine, so only a page served from here may ask: another
 * site's page fails the origin check, and a name rebound to this address fails the host check.
 */
export const allowed = (request, port = PORT) => {
	const local = [`localhost:${port}`, `127.0.0.1:${port}`];

	if (!local.includes(request.headers.get('host'))) return false;
	if (request.method === 'GET') return true;

	return local.map(host => `http://${host}`).includes(request.headers.get('origin'));
};

/** This ender, run again with these arguments: the binary itself when compiled, else Bun on this checkout. */
export const runSelf = async args => {
	const command = isCompiled() ? [process.execPath, ...args] : [process.execPath, Bun.main, ...args];
	const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);

	return { code, output: `${stdout}${stderr}`.trim() };
};

const json = (body, status = 200) => Response.json(body, { status });

/**
 * The page's questions of this machine's instances, each answered by running ender: list them, show one, and add or
 * drop mods by spec. Undefined for a path that is not the API's.
 */
export const webApi =
	({ run = runSelf } = {}) =>
	async request => {
		const { pathname } = new URL(request.url);

		if (!pathname.startsWith('/api/')) return undefined;

		const enderJson = async args => {
			const { code, output } = await run(args);

			if (code !== 0) return json({ error: output || `ender ${args[0]} failed` }, 502);

			return json(JSON.parse(output));
		};
		const parts = pathname.split('/').slice(2).map(decodeURIComponent);
		const [collection, name, verb, ...rest] = parts;

		if (collection !== 'instances' || rest.length > 0) return json({ error: 'Not found' }, 404);
		if (name === undefined && request.method === 'GET') return enderJson(['ls', '--json']);
		if (!INSTANCE.test(name ?? '')) return json({ error: 'Not an instance name' }, 400);
		if (verb === undefined && request.method === 'GET') return enderJson(['info', name, '--json']);

		if (['add', 'drop'].includes(verb) && request.method === 'POST') {
			const { specs } = await request.json().catch(() => ({}));

			if (!Array.isArray(specs) || specs.length === 0 || !specs.every(spec => SPEC.test(spec))) {
				return json({ error: 'Each mod has to be a spec search writes, such as gh:owner/repo' }, 400);
			}

			const { code, output } = await run([verb, ...specs, '--instance', name]);

			return json({ ok: code === 0, output }, code === 0 ? 200 : 502);
		}

		return json({ error: 'Not found' }, 404);
	};

const TYPES = {
	html: 'text/html; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	svg: 'image/svg+xml',
	woff2: 'font/woff2',
	json: 'application/json',
	png: 'image/png',
};

const typeOf = path => TYPES[path.split('.').at(-1)] ?? 'application/octet-stream';

/**
 * The index's pages, as path -> bytes: those a release built in, else the built site in ENDER_SITE. Undefined when
 * there are neither, as in a checkout nobody built the site for.
 */
export const siteFiles = async (directory = process.env.ENDER_SITE) => {
	if (directory) {
		const files = new Map();

		for (const path of new Bun.Glob('**/*').scanSync({ cwd: directory, dot: false })) {
			files.set(path.split(sep).join('/'), new Uint8Array(await Bun.file(join(directory, path)).arrayBuffer()));
		}

		return files.size > 0 ? files : undefined;
	}

	// eslint-disable-next-line import/no-unresolved -- written by scripts/embedSite.js for a release
	const built = await import('./site.generated.js').catch(() => undefined);

	return built && new Map(Object.entries(built.default).map(([path, data]) => [path, Buffer.from(data, 'base64')]));
};

/** A file of the site for a request's path; the page for the root, and nothing outside the site. */
export const servePage = (files, pathname) => {
	const path = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '') || 'index.html';
	const bytes = files.get(path.split(sep).join('/'));

	return bytes ? new Response(bytes, { headers: { 'content-type': typeOf(path) } }) : undefined;
};

/** Serve the index, managing this machine's instances, on this machine alone, and open it in the browser. */
export const web = async ({ flags }) => {
	const port = Number(flags.port ?? PORT);
	const files = await siteFiles();

	if (files === undefined) {
		throw new Error(
			'This ender has no pages built in, as a checkout does not: build the index (bun run build:site in ender-index) and run it with ENDER_SITE set to its client/build',
		);
	}

	const answer = webApi();
	let server;

	try {
		server = Bun.serve({
			hostname: '127.0.0.1',
			port,
			fetch: async request => {
				if (!allowed(request, port))
					return new Response('Only a page served from this machine may ask', { status: 403 });

				return (
					(await answer(request)) ??
					servePage(files, new URL(request.url).pathname) ??
					new Response('Not found', { status: 404 })
				);
			},
		});
	} catch (error) {
		if (error.code === 'EADDRINUSE') throw new Error(`Port ${port} is in use; pick another with ender web --port`);

		throw error;
	}

	const url = `http://localhost:${server.port}/`;

	done(`The index, managing this machine's instances, is at ${url}`);
	info(paint.dim('  Ctrl-C stops it'));

	if (flags.open !== false && !(await openInBrowser(url)))
		info(paint.dim('  No browser opened; open the address above'));

	return new Promise(() => {});
};

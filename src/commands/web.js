import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';

import { openInBrowser } from '../browser';
import { publishPack } from '../gist';
import * as instances from '../instance';
import { packFrom, parseEnderPack } from '../instance/enderPack';
import { done, info, paint } from '../out';
import { paths } from '../paths';
import { REPOSITORY, gistOf } from './packSource';
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

/** How this ender is run again: the binary itself when compiled, else Bun on this checkout. */
const selfCommand = args => (isCompiled() ? [process.execPath, ...args] : [process.execPath, Bun.main, ...args]);

/** This ender, run again with these arguments, waited for: what it printed, and how it ended. */
export const runSelf = async args => {
	const child = Bun.spawn(selfCommand(args), {
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, NO_COLOR: '1' },
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);

	return { code, output: `${stdout}${stderr}`.trim() };
};

/**
 * This ender, run again and let go: a game outlives the page that started it, and Ctrl-C on ender web must not reach
 * it. What it prints goes to a log, which is answered.
 */
export const startSelf = async (args, name) => {
	const log = join(paths.cache, 'launches', `${name}.log`);

	await mkdir(dirname(log), { recursive: true });

	const out = openSync(log, 'w');
	const child = spawn(selfCommand(args)[0], selfCommand(args).slice(1), {
		detached: true,
		stdio: ['ignore', out, out],
		env: { ...process.env, NO_COLOR: '1' },
	});

	child.unref();
	closeSync(out);

	return { log };
};

const json = (body, status = 200) => Response.json(body, { status });

const LOADERS = new Set(['fabric', 'quilt', 'forge', 'neoforge', 'vanilla']);

/** A game version as new takes one: an id such as 26.3, or release or snapshot for the newest. */
const MINECRAFT = /^[\w.+-]{1,40}$/;

/** A pack import fetches: a gist, a GitHub repository, or a link over https; never a file on this machine. */
const importable = source =>
	typeof source === 'string' &&
	(gistOf(source) !== undefined || REPOSITORY.test(source) || /^https:\/\/\S+$/.test(source));

const specsOf = async request => {
	const { specs } = await request.json().catch(() => ({}));

	return Array.isArray(specs) && specs.every(spec => SPEC.test(spec)) ? specs : undefined;
};

const BAD_SPECS = 'Each mod has to be a spec search writes, such as gh:owner/repo';

/**
 * The page's questions of this machine's instances, each answered by running ender: list them and show one, make one
 * from a list of mods or from a pack, add and drop mods, update, launch and delete one, and publish one, or a list,
 * as a gist. Undefined for a path that is not the API's.
 */
export const webApi =
	({ run = runSelf, start = startSelf, publish = publishPack, packOf = instancePack } = {}) =>
	async request => {
		const { pathname } = new URL(request.url);

		if (!pathname.startsWith('/api/')) return undefined;

		const { method } = request;
		const ran = async args => {
			const { code, output } = await run(args);

			return json({ ok: code === 0, output }, code === 0 ? 200 : 502);
		};
		const enderJson = async args => {
			const { code, output } = await run(args);

			if (code !== 0) return json({ error: output || `ender ${args[0]} failed` }, 502);

			return json(JSON.parse(output));
		};
		const published = async pack => {
			try {
				return json(await publish(pack));
			} catch (error) {
				return json({ error: error.message }, 502);
			}
		};
		const [collection, name, verb, ...rest] = pathname.split('/').slice(2).map(decodeURIComponent);

		if (rest.length > 0) return json({ error: 'Not found' }, 404);

		if (collection === 'import' && name === undefined && method === 'POST') {
			const { source } = await request.json().catch(() => ({}));

			if (!importable(source)) return json({ error: 'A pack is a gist, gh:owner/repo, or an https link' }, 400);

			return ran(['import', source, '--sync']);
		}

		if (collection === 'gists' && name === undefined && method === 'POST') {
			const { pack } = await request.json().catch(() => ({}));
			let checked;

			try {
				checked = parseEnderPack(pack, { file: 'The pack' });
			} catch (error) {
				return json({ error: error.message }, 400);
			}

			if (!checked.mods.every(({ spec }) => SPEC.test(spec))) return json({ error: BAD_SPECS }, 400);

			return published(pack);
		}

		if (collection !== 'instances') return json({ error: 'Not found' }, 404);
		if (name === undefined && method === 'GET') return enderJson(['ls', '--json']);

		if (name === undefined && method === 'POST') {
			const { name: wanted, minecraft, loader, specs = [] } = await request.json().catch(() => ({}));

			if (!INSTANCE.test(wanted ?? '')) return json({ error: 'Not an instance name' }, 400);
			if (minecraft !== undefined && !MINECRAFT.test(minecraft)) return json({ error: 'Not a game version' }, 400);
			if (loader !== undefined && !LOADERS.has(loader)) return json({ error: 'Not a loader ender knows' }, 400);
			if (!Array.isArray(specs) || !specs.every(spec => SPEC.test(spec))) return json({ error: BAD_SPECS }, 400);

			return ran([
				'new',
				wanted,
				...specs,
				...(minecraft ? ['--minecraft', minecraft] : []),
				...(loader ? ['--loader', loader] : []),
			]);
		}

		if (!INSTANCE.test(name ?? '')) return json({ error: 'Not an instance name' }, 400);
		if (verb === undefined && method === 'GET') return enderJson(['info', name, '--json']);
		if (verb === undefined && method === 'DELETE') return ran(['delete', name, '--yes']);

		if (['add', 'drop'].includes(verb) && method === 'POST') {
			const specs = await specsOf(request);

			if (!specs?.length) return json({ error: BAD_SPECS }, 400);

			return ran([verb, ...specs, '--instance', name]);
		}

		if (verb === 'update' && method === 'POST') return ran(['update', '--instance', name]);

		if (verb === 'launch' && method === 'POST') {
			const { update } = await request.json().catch(() => ({}));

			return json(await start(['launch', name, ...(update ? ['--update'] : [])], name), 202);
		}

		if (verb === 'gist' && method === 'POST') {
			try {
				return published(await packOf(name));
			} catch (error) {
				return json({ error: error.message }, 404);
			}
		}

		return json({ error: 'Not found' }, 404);
	};

/** An instance's chosen mods as the pack export writes. */
const instancePack = async name => packFrom(await instances.read(name)).pack;

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

/** Where a checkout finds the index's pages when ENDER_SITE names none: an ender-index checkout beside it. */
export const SIBLING_INDEX = join(import.meta.dir, '..', '..', '..', 'ender-index');

/** The sibling index's pages, built fresh from its checkout, so a checkout serves the pages as they stand. */
export const buildSibling = async (index = SIBLING_INDEX) => {
	if (!(await Bun.file(join(index, 'package.json')).exists())) return undefined;

	const build = Bun.spawn([process.execPath, 'run', 'build:site'], { cwd: index, stdout: 'pipe', stderr: 'pipe' });
	const [stdout, stderr, code] = await Promise.all([
		new Response(build.stdout).text(),
		new Response(build.stderr).text(),
		build.exited,
	]);

	if (code !== 0) throw new Error(`The index's pages in ${index} did not build: ${`${stdout}${stderr}`.trim()}`);

	return join(index, 'client', 'build');
};

/**
 * The index's pages, as path -> bytes: the built site in ENDER_SITE, else those a release built in, else a sibling
 * ender-index checkout's, built for the occasion. Undefined when there are none, as in a checkout with no index beside it.
 */
export const siteFiles = async (directory = process.env.ENDER_SITE, { sibling = buildSibling } = {}) => {
	if (directory) {
		const files = new Map();

		for (const path of new Bun.Glob('**/*').scanSync({ cwd: directory, dot: false })) {
			files.set(path.split(sep).join('/'), new Uint8Array(await Bun.file(join(directory, path)).arrayBuffer()));
		}

		return files.size > 0 ? files : undefined;
	}

	// eslint-disable-next-line import/no-unresolved -- written by scripts/embedSite.js for a release
	const built = await import('./site.generated.js').catch(() => undefined);

	if (built) return new Map(Object.entries(built.default).map(([path, data]) => [path, Buffer.from(data, 'base64')]));
	if (isCompiled()) return undefined;

	const fromIndex = await sibling();

	return fromIndex ? siteFiles(fromIndex) : undefined;
};

/** A file of the site for a request's path; the page for the root, and nothing outside the site. */
export const servePage = (files, pathname) => {
	const path = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '') || 'index.html';
	const bytes = files.get(path.split(sep).join('/'));

	if (!bytes) return undefined;

	// Asked for again each time, or a browser keeps showing the pages of the ender before an upgrade
	return new Response(bytes, { headers: { 'content-type': typeOf(path), 'cache-control': 'no-cache' } });
};

/** Serve the index, managing this machine's instances, on this machine alone, and open it in the browser. */
export const web = async ({ flags }) => {
	const port = Number(flags.port ?? PORT);
	const files = await siteFiles();

	if (files === undefined) {
		throw new Error(
			`This ender has no pages built in, as a checkout does not, and no ender-index checkout is beside it at ${SIBLING_INDEX}: clone one there, or set ENDER_SITE to a built site`,
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

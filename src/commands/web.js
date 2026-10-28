import { join, normalize, sep } from 'node:path';

import { version } from '../../package.json';
import { openInBrowser } from '../browser';
import { publishPack } from '../gist';
import { INSTANCE_NAME } from '../instance';
import { parseEnderPack } from '../instance/enderPack';
import { jobRunner, shown } from '../jobs';
import { KNOWN_LOADERS } from '../meta/resolve';
import { done, info, paint } from '../out';
import { REPOSITORY, gistOf } from './packSource';
import { isCompiled } from './upgrade';

export const PORT = 7460;

export const REFUSED = 'Only a page served from this machine may ask';

/** A mod the page names: a repository or a project by the prefixes search writes, never a path or a flag. */
export const SPEC = /^(gh|cb|gl|mr|cf):[\w-][\w.-]*(\/[\w-][\w.-]*)*$/;

export const INSTANCE = INSTANCE_NAME;

const GAME_VERSION = /^\w[\w.+-]{0,39}$/;

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

/**
 * A form posts from this origin too, and a mod's readme on this page may carry one past its sanitizing; a form cannot
 * send JSON, so a write that is not JSON is refused.
 */
const sentAsJson = request => request.headers.get('content-type')?.split(';')[0].trim() === 'application/json';

export const selfCommand = args => (isCompiled() ? [process.execPath, ...args] : [process.execPath, Bun.main, ...args]);

/** A command run to its end: what it printed to each stream, and how it ended. */
export const collect = async (argv, options = {}) => {
	const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', ...options });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);

	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
};

const json = (body, status = 200) => Response.json(body, { status });

const bodyOf = request => request.json().catch(() => ({}));

/** A pack import fetches: a gist, a GitHub repository, or a link over https; never a file on this machine. */
const importable = source =>
	typeof source === 'string' &&
	(gistOf(source) !== undefined || REPOSITORY.test(source) || /^https:\/\/\S+$/.test(source));

const BAD_SPECS = 'Each mod has to be a spec search writes, such as gh:owner/repo';

const allSpecs = specs => Array.isArray(specs) && specs.every(spec => SPEC.test(spec));

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The page's questions of this machine's instances, each answered by running ender as `command` builds it. What takes
 * a while is a job the page follows; what ender answers as JSON is answered as it is. Undefined for a path that is not
 * the API's.
 */
export const webApi = ({
	command = selfCommand,
	run = args => collect(command(args), { env: { ...process.env, NO_COLOR: '1' } }),
	jobs = jobRunner({ command }),
	publish = publishPack,
} = {}) => {
	const answerJson = async args => {
		const { code, stdout, stderr } = await run(args);

		if (code !== 0) return json({ error: stderr || stdout || `ender ${args[0]} failed` }, 502);

		try {
			return json(JSON.parse(stdout));
		} catch {
			return json({ error: `ender ${args[0]} did not answer JSON: ${stdout.slice(0, 200)}` }, 502);
		}
	};
	const startJob = async (args, { title, instance }) => {
		const busy = jobs.running(instance);

		if (busy) return json({ error: `${instance} is busy: ${busy.title}`, job: shown(busy) }, 409);

		return json({ job: shown(await jobs.start(args, { title, instance })) }, 202);
	};

	return async request => {
		const { pathname, searchParams } = new URL(request.url);

		if (!pathname.startsWith('/api/')) return undefined;

		const { method } = request;

		if (method !== 'GET' && !sentAsJson(request)) return json({ error: 'The page sends its requests as JSON' }, 415);

		let segments;

		try {
			segments = pathname.split('/').slice(2).map(decodeURIComponent);
		} catch {
			return json({ error: 'Not a path the page asks' }, 400);
		}

		const [area, name, verb, ...rest] = segments;

		if (rest.length > 0) return json({ error: 'Not found' }, 404);
		if (area === 'ender' && method === 'GET') return json({ version });

		if (area === 'jobs' && method === 'GET') {
			if (name === undefined) return json(jobs.list().map(shown));

			const job = jobs.get(name);

			if (!job) return json({ error: 'No such job' }, 404);

			const from = Math.max(0, Number(searchParams.get('from')) || 0);
			const seen = shown(job);
			const lines = await jobs.lines(seen, from);

			return json({ ...seen, lines, next: from + lines.length });
		}

		if (area === 'import' && name === undefined && method === 'POST') {
			const { source } = await bodyOf(request);

			if (!importable(source)) return json({ error: 'A pack is a gist, gh:owner/repo, or an https link' }, 400);

			return startJob(['import', source, '--sync'], { title: `Importing ${source}` });
		}

		if (area === 'gists' && name === undefined && method === 'POST') {
			const { pack } = await bodyOf(request);
			let checked;

			try {
				checked = parseEnderPack(pack, { file: 'The pack' });
			} catch (error) {
				return json({ error: error.message }, 400);
			}

			if (!checked.mods.every(({ spec }) => SPEC.test(spec))) return json({ error: BAD_SPECS }, 400);

			try {
				return json(
					await publish({ name: pack.name, minecraft: pack.minecraft, loader: pack.loader, mods: pack.mods }),
				);
			} catch (error) {
				return json({ error: error.message }, 502);
			}
		}

		if (area !== 'instances') return json({ error: 'Not found' }, 404);
		if (name === undefined && method === 'GET') return answerJson(['ls', '--json']);

		if (name === undefined && method === 'POST') {
			const { name: wanted, minecraft, loader, specs = [] } = await bodyOf(request);

			if (!INSTANCE.test(wanted ?? '')) return json({ error: `"${wanted ?? ''}" cannot name an instance` }, 400);
			if (minecraft !== undefined && !GAME_VERSION.test(minecraft)) return json({ error: 'Not a game version' }, 400);
			if (loader !== undefined && !KNOWN_LOADERS.has(loader)) return json({ error: 'Not a loader ender knows' }, 400);
			if (!allSpecs(specs)) return json({ error: BAD_SPECS }, 400);

			return startJob(
				[
					'new',
					wanted,
					...specs,
					...(minecraft ? ['--minecraft', minecraft] : []),
					...(loader ? ['--loader', loader] : []),
				],
				{ title: `Making ${wanted}`, instance: wanted },
			);
		}

		if (!INSTANCE.test(name ?? '')) return json({ error: 'Not an instance name' }, 400);

		const named = { instance: name };

		if (verb === undefined && method === 'GET') return answerJson(['info', name, '--json']);
		if (verb === undefined && method === 'DELETE') {
			return startJob(['delete', name, '--yes'], { title: `Deleting ${name}`, ...named });
		}

		if (['add', 'drop'].includes(verb) && method === 'POST') {
			const { specs } = await bodyOf(request);

			if (!allSpecs(specs) || specs.length === 0) return json({ error: BAD_SPECS }, 400);

			return startJob([verb, ...specs, '--instance', name], {
				title: `${verb === 'add' ? 'Adding' : 'Dropping'} ${specs.length === 1 ? specs[0] : plural(specs.length, 'mod')}`,
				...named,
			});
		}

		if (verb === 'update' && method === 'POST') {
			return startJob(['update', '--instance', name], { title: `Updating ${name}`, ...named });
		}

		if (verb === 'launch' && method === 'POST') {
			const { update } = await bodyOf(request);

			return startJob(['launch', name, ...(update ? ['--update'] : [])], { title: `Playing ${name}`, ...named });
		}

		if (verb === 'gist' && method === 'POST') {
			const { fresh } = await bodyOf(request);

			return answerJson(['export', name, '--gist', '--json', ...(fresh ? ['--new'] : [])]);
		}

		return json({ error: 'Not found' }, 404);
	};
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

/** Where a checkout finds the index's pages when ENDER_SITE names none: an ender-index checkout beside it. */
export const SIBLING_INDEX = join(import.meta.dir, '..', '..', '..', 'ender-index');

/** The sibling index's pages, built fresh from its checkout, so a checkout serves the pages as they stand. */
export const buildSibling = async (index = SIBLING_INDEX) => {
	if (!(await Bun.file(join(index, 'package.json')).exists())) return undefined;

	const { code, stdout, stderr } = await collect([process.execPath, 'run', 'build:site'], { cwd: index });

	if (code !== 0) throw new Error(`The index's pages in ${index} did not build: ${[stdout, stderr].join('\n').trim()}`);

	return join(index, 'client', 'build');
};

/** The index's pages, as path -> bytes, or undefined when there are none. */
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

	const siblingBuild = await sibling();

	return siblingBuild ? siteFiles(siblingBuild) : undefined;
};

/** A file of the site for a request's path; the page for the root, and nothing outside the site. */
export const servePage = (files, pathname) => {
	let decoded;

	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return undefined;
	}

	const path = normalize(decoded).replace(/^[/\\]+/, '') || 'index.html';
	const bytes = files.get(path.split(sep).join('/'));

	if (!bytes) return undefined;

	// Asked for again each time, or a browser keeps showing the pages of the ender before an upgrade
	return new Response(bytes, { headers: { 'content-type': typeOf(path), 'cache-control': 'no-cache' } });
};

export const web = async ({ flags }) => {
	const port = Number(flags.port ?? PORT);
	const files = await siteFiles();

	if (files === undefined) {
		throw new Error(
			isCompiled()
				? "This ender was built without the index's pages: set ENDER_SITE to a built site, or install a release"
				: `A checkout has no pages built in, and no ender-index checkout is beside it at ${SIBLING_INDEX}: clone one there, or set ENDER_SITE to a built site`,
		);
	}

	const answer = webApi();
	let server;

	try {
		server = Bun.serve({
			hostname: '127.0.0.1',
			port,
			fetch: async request => {
				if (!allowed(request, port)) return new Response(REFUSED, { status: 403 });

				return (
					(await answer(request)) ??
					servePage(files, new URL(request.url).pathname) ??
					new Response('Not found', { status: 404 })
				);
			},
		});
	} catch (error) {
		if (error.code === 'EADDRINUSE') {
			throw new Error(
				`Port ${port} is in use, perhaps by an ender web already running: open http://localhost:${port}/, or pick another port with ender web --port`,
			);
		}

		throw error;
	}

	const url = `http://localhost:${server.port}/`;

	done(`The index, managing this machine's instances, is at ${url}`);
	info(paint.dim('  Ctrl-C stops it'));

	if (flags.open !== false && !(await openInBrowser(url)))
		info(paint.dim('  No browser opened; open the address above'));

	return new Promise(() => {});
};

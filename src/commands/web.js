import { mkdir } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

import { version } from '../../package.json';
import { NAME as PLAYER } from '../auth/accounts';
import { openInBrowser } from '../browser';
import { publishPack } from '../gist';
import { INSTANCE_NAME } from '../instance';
import { parseEnderPack } from '../instance/enderPack';
import { detach, jobRunner, shown } from '../jobs';
import { dataRoot, paths } from '../paths';
import { KNOWN_LOADERS } from '../meta/resolve';
import { done, info, paint } from '../out';
import { signedInAs } from '../githubAccount';
import { fileIndexIssue, modLink } from '../indexIssues';
import { setStar, starredRepositories } from '../stars';
import { REPOSITORY, gistOf } from './packSource';
import { appBundleOf, isCompiled, latestRelease, whoUpgrades } from './upgrade';

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

/** Where this ender is, as a person would find it (the app, not the binary inside it), and where it keeps its data. */
export const installedWhere = () => ({
	installed: isCompiled() ? (appBundleOf() ?? process.execPath) : join(import.meta.dir, '..', '..'),
	data: dataRoot(),
});

/** An Azure application id: a guid. */
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What `ask` answered within the last `fresh` milliseconds, asked again after; a failure is not kept. */
export const cached = (ask, fresh, now = Date.now) => {
	let kept;

	return async () => {
		if (kept && now() - kept.at < fresh) return kept.value;

		const value = await ask();

		kept = { value, at: now() };

		return value;
	};
};

const bodyOf = request => request.json().catch(() => ({}));

/** A pack import fetches: a gist, a GitHub repository, or a link over https; never a file on this machine. */
const importable = source =>
	typeof source === 'string' &&
	(gistOf(source) !== undefined || REPOSITORY.test(source) || /^https:\/\/\S+$/.test(source));

/** A GitHub repository as owner/repo, neither of them dots alone, which would climb out of the path it is put in. */
const STARRABLE = /^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/;

const ASKABLE = new Set(['fund', 'release']);

/** A mod as the index keys it, a repository on a host it crawls, no part of it dots alone. */
const MOD_KEY = /^(github|codeberg|gitlab):(?!\.+\/)[\w.-]+(\/(?!\.+(\/|$))[\w.-]+)+$/;

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
	stars = { list: starredRepositories, set: setStar },
	account = signedInAs,
	fileIssue = fileIndexIssue,
	newest = cached(async () => (await latestRelease()).version, 60 * 60_000),
	upgradedBy = whoUpgrades,
	restart = async () => {},
	where = installedWhere,
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
	/** Runs a change, then answers with what `then` reads afterwards, so the page shows the state ender holds. */
	const changeThen = async (args, then) => {
		const { code, stdout, stderr } = await run(args);

		if (code !== 0) return json({ error: stderr || stdout || `ender ${args.join(' ')} failed` }, 502);

		return answerJson(then);
	};
	const players = ['account', '--json'];
	const filed = async (kind, answer) => {
		try {
			const issue = await fileIssue(kind, answer);

			return json(issue, issue.before ? 200 : 201);
		} catch (error) {
			return json({ error: error.message }, error.status ?? 502);
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
		if (area === 'ender' && method === 'GET') return json({ version, ...where() });

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

		if (area === 'account' && name === undefined && method === 'GET') {
			try {
				return json({ login: await account() });
			} catch (error) {
				return json({ error: error.message }, error.status ?? 502);
			}
		}

		if (area === 'players') {
			if (name === undefined && method === 'GET') return answerJson(players);

			if (name === undefined && method === 'POST') {
				const { name: wanted } = await bodyOf(request);

				if (!PLAYER.test(wanted ?? ''))
					return json({ error: 'A player name is 3 to 16 letters, digits or underscores' }, 400);

				return changeThen(['account', 'add', '--offline', wanted], players);
			}

			if (!PLAYER.test(name ?? '')) return json({ error: 'Not a player name' }, 400);
			if (verb === 'use' && method === 'POST') return changeThen(['account', 'use', name], players);
			if (verb === undefined && method === 'DELETE') return changeThen(['account', 'remove', name], players);

			return json({ error: 'Not found' }, 404);
		}

		if (area === 'sign-in' && name === undefined && method === 'POST') {
			return startJob(['account', 'add', '--no-qr'], { title: 'Signing in to Microsoft' });
		}

		if (area === 'sign-in' && name === 'client-id' && method === 'PUT') {
			const { clientId } = await bodyOf(request);

			if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId.trim())) {
				return json(
					{ error: "A client id is the Application (client) ID on the app's Azure page, like 1a2b3c4d-..." },
					400,
				);
			}

			return changeThen(['config', 'clientId', clientId.trim()], players);
		}

		if (area === 'upgrade' && name === undefined && method === 'GET') {
			const how = upgradedBy();

			try {
				return json({ current: version, latest: await newest(), how });
			} catch (error) {
				return json({ current: version, how, error: error.message });
			}
		}

		if (area === 'upgrade' && name === undefined && method === 'POST') {
			const how = upgradedBy();

			if (how !== 'self') {
				return json(
					{
						error:
							how === 'brew'
								? 'Homebrew installed this ender; brew upgrade ender brings it up to date'
								: 'This ender runs from a checkout; git pull brings it up to date',
					},
					409,
				);
			}

			return startJob(['upgrade'], { title: 'Upgrading ender' });
		}

		if (area === 'restart' && name === undefined && method === 'POST') {
			if (jobs.busy())
				return json({ error: 'ender is still working on something the page started; restart once it ends' }, 409);

			setTimeout(restart, 50);

			return json({ restarting: true });
		}

		if (area === 'asks' && name === undefined && method === 'POST') {
			const { kind, mod } = await bodyOf(request);

			if (!ASKABLE.has(kind)) return json({ error: 'An ask is for a way to pay its author, or a built release' }, 400);
			if (!MOD_KEY.test(mod ?? '')) return json({ error: 'A mod is named as the index keys it, host:owner/repo' }, 400);

			return filed(kind, mod);
		}

		if (area === 'listings' && name === undefined && method === 'POST') {
			const { pack, mod } = await bodyOf(request);

			if (mod !== undefined) {
				const link = typeof mod === 'string' ? modLink(mod) : undefined;

				return link ? filed('mod', link) : json({ error: 'A mod to list is gh:owner/repo, or its link' }, 400);
			}

			const gist = typeof pack === 'string' ? gistOf(pack) : undefined;

			if (gist) return filed('pack', `gist:${gist}`);
			if (!REPOSITORY.test(pack ?? '')) return json({ error: 'A pack to list is a gist, or gh:owner/repo' }, 400);

			return filed('pack', pack);
		}

		if (area === 'stars') {
			const starring = { PUT: true, DELETE: false }[method];

			try {
				if (name === undefined && method === 'GET') return json({ repositories: await stars.list() });
				if (starring === undefined || !STARRABLE.test(`${name}/${verb}`)) return json({ error: 'Not found' }, 404);

				await stars.set(`${name}/${verb}`, starring);

				return json({ starred: starring });
			} catch (error) {
				return json({ error: error.message }, error.status ?? 502);
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
			const { specs, build } = await bodyOf(request);

			if (!allSpecs(specs) || specs.length === 0) return json({ error: BAD_SPECS }, 400);

			return startJob([verb, ...specs, ...(verb === 'add' && build === true ? ['--build'] : []), '--instance', name], {
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

		if (verb === 'player' && method === 'PUT') {
			const { player } = await bodyOf(request);

			if (player !== null && !PLAYER.test(player ?? '')) return json({ error: 'Not a player name' }, 400);

			return changeThen(['account', 'assign', player ?? 'none', '--instance', name], ['info', name, '--json']);
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

/**
 * A file of the site for a request's path, nothing outside the site, and the page for any path with no extension: the
 * site's pages are paths, /mod/github/a/b, which its script shows.
 */
export const servePage = (files, pathname) => {
	let decoded;

	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return undefined;
	}

	const asked = normalize(decoded).replace(/^[/\\]+/, '');
	const path = extname(asked) === '' ? 'index.html' : asked;
	const bytes = files.get(path.split(sep).join('/'));

	if (!bytes) return undefined;

	// Asked for again each time, or a browser keeps showing the pages of the ender before an upgrade
	return new Response(bytes, { headers: { 'content-type': typeOf(path), 'cache-control': 'no-cache' } });
};

/** Whether an ender web already answers on this port, so a second start opens it rather than failing. */
export const enderAt = async (port, ask = fetch) => {
	try {
		const answered = await ask(`http://127.0.0.1:${port}/api/ender`);

		return answered.ok && typeof (await answered.json()).version === 'string';
	} catch {
		return false;
	}
};

export const IDLE_MINUTES = 15;

/**
 * Idle once no page has asked anything for `minutes` and no job it started is running. An open page asks at least
 * every few minutes, so only a closed one lets it go idle.
 */
export const idleWatch = ({ minutes = IDLE_MINUTES, busy, now = Date.now }) => {
	let last = now();

	return {
		seen: () => {
			last = now();
		},
		idle: () => !busy() && now() - last >= minutes * 60_000,
	};
};

const opened = async (url, flags) => {
	if (flags.open !== false && !(await openInBrowser(url)))
		info(paint.dim('  No browser opened; open the address above'));
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

	const jobs = jobRunner({ command: selfCommand });
	let server;
	/**
	 * The page asks after an upgrade, to be served by the new ender: this one lets go of the port and starts the new
	 * binary in the background, which stops once its page is closed, since no terminal holds it.
	 */
	const restart = async () => {
		await server.stop(true);
		await mkdir(paths.cache, { recursive: true });
		detach(selfCommand(['web', '--port', String(port), '--no-open', '--until-idle']), join(paths.cache, 'web.log'));
		info(`ender web moved to the background, as the upgraded ender; it stops once its page is closed`);
		setTimeout(() => process.exit(0), 200);
	};
	const answer = webApi({ jobs, restart });
	const watch = idleWatch({ busy: jobs.busy });

	try {
		server = Bun.serve({
			hostname: '127.0.0.1',
			port,
			fetch: async request => {
				if (!allowed(request, port)) return new Response(REFUSED, { status: 403 });

				watch.seen();

				return (
					(await answer(request)) ??
					servePage(files, new URL(request.url).pathname) ??
					new Response('Not found', { status: 404 })
				);
			},
		});
	} catch (error) {
		if (error.code === 'EADDRINUSE' && (await enderAt(port))) {
			const url = `http://localhost:${port}/`;

			done(`ender web is already running at ${url}`);
			await opened(url, flags);

			return 0;
		}

		if (error.code === 'EADDRINUSE') {
			throw new Error(
				`Port ${port} is in use, perhaps by an ender web already running: open http://localhost:${port}/, or pick another port with ender web --port`,
			);
		}

		throw error;
	}

	const url = `http://localhost:${server.port}/`;

	done(`The index, managing this machine's instances, is at ${url}`);
	info(
		paint.dim(flags.untilIdle ? `  It stops ${IDLE_MINUTES} minutes after its last page closes` : '  Ctrl-C stops it'),
	);
	await opened(url, flags);

	if (!flags.untilIdle) return new Promise(() => {});

	return new Promise(resolve => {
		const timer = setInterval(() => {
			if (!watch.idle()) return;

			clearInterval(timer);
			server.stop();
			info(`No page has asked anything for ${IDLE_MINUTES} minutes; ender web stopped`);
			resolve(0);
		}, 60_000);
	});
};

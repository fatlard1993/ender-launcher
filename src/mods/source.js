import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

import { extractArchive } from '../archive';
import { readConfig, updateConfig } from '../config';
import { ensureFile } from '../download';
import { provideJdk } from '../jdk';
import { versionMeta } from '../meta/mojang';
import { step, warn } from '../out';
import { dataRoot, paths } from '../paths';
import { builtJar, readProperties, runGradle } from './gradle';

/** Where each host serves a repository's files at one commit, as a zip. */
export const SOURCE_ZIPS = {
	github: (name, commit) => `https://codeload.github.com/${name}/zip/${commit}`,
	codeberg: (name, commit) => `https://codeberg.org/${name}/archive/${commit}.zip`,
	gitlab: (name, commit) => `https://gitlab.com/${name}/-/archive/${commit}/${name.split('/').at(-1)}-${commit}.zip`,
};

/** The Java a project builds with when the game version it names says nothing: what current Minecraft runs on. */
const DEFAULT_JAVA = 21;

const VARIANTS = /-(sources|testsupport|dev|javadoc|api|slim|shadow)\.jar$/i;

/** The jar a build left: the one its declared version names, or else the largest that is not a by-product. */
export const pickBuiltJar = async (directory, version) => {
	const named = version && (await builtJar(directory, version));

	if (named) return named;

	const libs = join(directory, 'build', 'libs');
	const jars = (await readdir(libs).catch(() => [])).filter(file => file.endsWith('.jar') && !VARIANTS.test(file));
	const sized = await Promise.all(jars.map(async file => ({ file, size: (await stat(join(libs, file))).size })));

	return sized.length > 0 ? join(libs, sized.toSorted((a, b) => b.size - a.size)[0].file) : undefined;
};

/** Folders a build writes or keeps for itself, never part of what the project ships as its build. */
const SKIPPED = new Set(['.git', '.gradle', 'build', 'run', 'out']);

/** The builds a settings file includes, whose own code runs while the project builds. */
const includedBuilds = text => [...text.matchAll(/includeBuild\s*\(?\s*["']([^"']+)["']/g)].map(([, path]) => path);

/**
 * The files that decide what a gradle build runs: the wrapper and its jar, every build and settings script, the
 * properties and version catalogs they read, and all of buildSrc, build-logic and any build a settings file includes.
 */
export const isBuildScript = (path, included = []) =>
	/^gradlew(\.bat)?$/.test(path) ||
	path.startsWith('gradle/') ||
	/(^|\/)[^/]+\.gradle(\.kts)?$/.test(path) ||
	/(^|\/)gradle\.properties$/.test(path) ||
	/^(buildSrc|build-logic)\//.test(path) ||
	included.some(root => path.startsWith(`${root.replace(/^\.\//, '').replace(/\/$/, '')}/`));

/** A project's build scripts, each by its path with its sha256: what an allowance to build it is held to. */
export const buildScripts = async directory => {
	const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
		.filter(entry => entry.isFile())
		.map(entry => relative(directory, join(entry.parentPath ?? entry.path, entry.name)).replaceAll('\\', '/'))
		.filter(path => !path.split('/').some(part => SKIPPED.has(part)));
	const settings = files.filter(path => /^settings\.gradle(\.kts)?$/.test(path));
	const included = (
		await Promise.all(settings.map(async path => includedBuilds(await Bun.file(join(directory, path)).text())))
	).flat();
	const scripts = {};

	for (const path of files.filter(path => isBuildScript(path, included)).toSorted()) {
		scripts[path] = new Bun.CryptoHasher('sha256')
			.update(await Bun.file(join(directory, path)).arrayBuffer())
			.digest('hex');
	}

	return scripts;
};

/** What changed in a project's build scripts since an allowance: files added, changed and removed. */
export const scriptChanges = (allowed, now) => ({
	added: Object.keys(now).filter(path => !(path in allowed)),
	changed: Object.keys(now).filter(path => path in allowed && allowed[path] !== now[path]),
	removed: Object.keys(allowed).filter(path => !(path in now)),
});

/** Where the build scripts a player allowed are kept, to show what changed when they do. */
const allowedCopy = key => join(dataRoot(), 'builds-allowed', ...key.split(':'));

/**
 * The player's allowance to build a repository: the commit and build scripts it was given for. One given before ender
 * kept which scripts it covered holds none, and is asked for again. Undefined when building it was never allowed.
 */
export const allowanceOf = async key => {
	const { builds } = await readConfig();

	if (Array.isArray(builds)) return builds.includes(key) ? { scripts: undefined } : undefined;

	return builds?.[key];
};

const keepAllowance = async (key, allowance) => {
	const { builds } = await readConfig();
	const kept = Array.isArray(builds) ? {} : { ...builds };

	await updateConfig({ builds: { ...kept, [key]: allowance } });
};

/** Copy a project's build scripts out of its source, to show beside a later commit's. */
const copyScripts = async (directory, scripts, to) => {
	await rm(to, { recursive: true, force: true });

	for (const path of Object.keys(scripts)) {
		await mkdir(dirname(join(to, path)), { recursive: true });
		await copyFile(join(directory, path), join(to, path));
	}
};

/** Where the build scripts of a commit held for the player are kept, beside the ones they allowed. */
const pendingCopy = (key, commit) => `${allowedCopy(key)}@${commit.slice(0, 7)}`;

/** A key and commit as a held build names them, and nothing a path could be built from otherwise. */
export const HELD_KEY = /^(github|codeberg|gitlab):[\w.-]+(\/[\w.-]+)+$/;
export const HELD_COMMIT = /^[0-9a-f]{7,64}$/;

const heldOf = async (key, commit) => {
	if (!HELD_KEY.test(key ?? '') || !HELD_COMMIT.test(commit ?? '') || key.split('/').includes('..')) return undefined;

	const file = Bun.file(`${pendingCopy(key, commit)}.json`);
	const held = (await file.exists()) ? await file.json() : undefined;

	return held?.commit === commit ? held : undefined;
};

/**
 * Allow the build scripts of a commit held because they changed, as the player saw them: the copy kept when it was
 * held, not whatever the commit's source holds later. Answers whether there was such a commit to allow.
 */
export const allowHeldScripts = async (key, commit) => {
	const held = await heldOf(key, commit);

	if (!held) return false;

	await rm(allowedCopy(key), { recursive: true, force: true });
	await rename(pendingCopy(key, commit), allowedCopy(key));
	await rm(`${pendingCopy(key, commit)}.json`, { force: true });
	await keepAllowance(key, held);

	return true;
};

/**
 * What changed in a held commit's build scripts since the ones allowed, as git prints a diff, or undefined without
 * git or such a commit. The allowed copy is missing for an allowance from before ender kept scripts, and every script
 * then shows as added.
 */
export const heldScriptsDiff = async (key, commit) => {
	if (!(await heldOf(key, commit))) return undefined;

	const allowed = allowedCopy(key);

	await mkdir(allowed, { recursive: true });

	try {
		const child = Bun.spawn(
			['git', 'diff', '--no-index', '--no-color', '--', basename(allowed), basename(pendingCopy(key, commit))],
			{ cwd: dirname(allowed), stdout: 'pipe', stderr: 'ignore' },
		);
		const text = await new Response(child.stdout).text();

		return (await child.exited) <= 1 ? text : undefined;
	} catch {
		return undefined;
	}
};

/** A build that waits for the player, because its build scripts changed since they allowed it. */
export class ScriptsChanged extends Error {}

const listed = (word, paths) => (paths.length > 0 ? [`${word}: ${paths.join(', ')}`] : []);

/**
 * Hold a build to the scripts its allowance was given for. Allowing it now, by name, takes these scripts as allowed;
 * otherwise scripts that changed since stop it, saying which and where both copies are to compare.
 */
const holdToAllowance = async ({ key, commit, directory, allowance, allowing }) => {
	const scripts = await buildScripts(directory);
	const copy = allowedCopy(key);

	if (!allowing) {
		const changes = allowance.scripts ? scriptChanges(allowance.scripts, scripts) : undefined;

		if (changes === undefined || Object.values(changes).some(paths => paths.length > 0)) {
			const pending = pendingCopy(key, commit);

			await copyScripts(directory, scripts, pending);
			await Bun.write(`${pending}.json`, JSON.stringify({ commit, scripts }));

			const what = changes
				? [
						`${key}'s build scripts changed since you allowed building it${allowance.commit ? ` at ${allowance.commit.slice(0, 7)}` : ''}:`,
						...listed('added', changes.added),
						...listed('changed', changes.changed),
						...listed('removed', changes.removed),
						`Compare them with: git diff --no-index ${copy} ${pending}`,
					]
				: [
						`${key} was allowed to build before ender kept which build scripts an allowance covers.`,
						`Its build scripts at ${commit.slice(0, 7)} are in ${pending}.`,
					];

			throw new ScriptsChanged(
				[
					...what,
					`They run on this machine with your permissions; ender add ${key} --build allows these. [build-scripts:${key}@${commit}]`,
				].join('\n'),
			);
		}
	}

	const changes = allowance.scripts && scriptChanges(allowance.scripts, scripts);

	if (allowing && changes && Object.values(changes).some(paths => paths.length > 0)) {
		warn(
			[
				`Allowing ${key}'s changed build scripts, as --build says:`,
				...listed('added', changes.added),
				...listed('changed', changes.changed),
				...listed('removed', changes.removed),
			].join('\n'),
		);
	}

	await copyScripts(directory, scripts, copy);
	await keepAllowance(key, { commit, scripts });
};

const javaFor = async minecraft =>
	minecraft
		? ((await versionMeta(minecraft).catch(() => undefined))?.meta.javaVersion?.majorVersion ?? DEFAULT_JAVA)
		: DEFAULT_JAVA;

const fetchSource = async (host, name, commit, directory) => {
	const archive = join(paths.cache, 'sources', `${host}-${name.replaceAll('/', '-')}-${commit}.zip`);
	const unpacked = `${directory}.part`;

	await ensureFile({ url: SOURCE_ZIPS[host](name, commit), path: archive });
	await rm(unpacked, { recursive: true, force: true });

	const [first] = await extractArchive(archive, unpacked);

	await rm(directory, { recursive: true, force: true });
	await mkdir(dirname(directory), { recursive: true });
	await rename(join(unpacked, first.split('/')[0]), directory);
	await rm(unpacked, { recursive: true, force: true });
	await rm(archive, { force: true });
};

/**
 * A jar built from a repository's source at one commit, built once and kept: the zip of that commit from its host,
 * built by its own gradle wrapper with a JDK of the Java its game version runs on, once its build scripts are the ones
 * the player allowed.
 */
export const buildFromSource = async ({ host, name, commit, minecraft, allowance, allowing = false }) => {
	const label = `${host}:${name}`;
	const built = join(paths.cache, 'builds', host, name, `${commit}.jar`);

	if (allowance === undefined && !allowing) throw new Error(`Building ${label} was not allowed`);
	if (allowance?.commit === commit && (await Bun.file(built).exists())) return built;

	const directory = join(paths.cache, 'sources', host, name, commit);

	if (!(await Bun.file(join(directory, 'gradlew')).exists())) await fetchSource(host, name, commit, directory);

	await holdToAllowance({ key: label, commit, directory, allowance: allowance ?? {}, allowing });

	if (await Bun.file(built).exists()) return built;

	const javaHome = await provideJdk(await javaFor(minecraft));

	step(
		`Building ${label} at ${commit.slice(0, 7)}; a first build fetches gradle and the game's code, and takes minutes`,
	);
	await runGradle(directory, { javaHome, label, skipTests: true });

	const jar = await pickBuiltJar(directory, (await readProperties(directory))?.mod_version);

	if (jar === undefined) throw new Error(`${label} built, but left no jar in build/libs`);

	await mkdir(dirname(built), { recursive: true });
	await copyFile(jar, built);

	return built;
};

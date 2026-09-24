import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readJson, writeJson } from './json';
import { detail, warn } from './out';
import { paths } from './paths';
import { installedRuntimes, isInstalled, provideRuntime, runtimeBinary } from './runtime';

const searchRoots = [
	'/usr/lib/jvm',
	'/usr/java',
	'/Library/Java/JavaVirtualMachines',
	join(homedir(), '.local/share/PrismLauncher/java'),
	join(homedir(), '.sdkman/candidates/java'),
	paths.java,
];

const cachePath = () => join(paths.cache, 'java.json');

const candidatePaths = async () => {
	const found = new Set();

	if (process.env.JAVA_HOME) found.add(join(process.env.JAVA_HOME, 'bin/java'));

	for (const root of searchRoots) {
		let entries;

		try {
			entries = await readdir(root);
		} catch {
			continue;
		}

		for (const entry of entries) {
			found.add(join(root, entry, 'bin/java'));
			found.add(join(root, entry, 'Contents/Home/bin/java'));
			found.add(join(root, entry, 'jre.bundle/Contents/Home/bin/java'));
		}
	}

	found.add('/usr/bin/java');

	const usable = [];

	for (const path of found) {
		if (await Bun.file(path).exists()) usable.push(path);
	}

	return usable;
};

/** Ask the binary itself; a path's name lies often enough that reading it is not worth the risk. */
const probe = async path => {
	const process_ = Bun.spawn([path, '-version'], { stdout: 'pipe', stderr: 'pipe' });
	const [stderr, stdout] = await Promise.all([
		new Response(process_.stderr).text(),
		new Response(process_.stdout).text(),
	]);

	await process_.exited;

	const matched = /version "(\d+)(?:\.(\d+))?[^"]*"/.exec(`${stderr}\n${stdout}`);

	if (matched === null) return undefined;

	// Java 8 and earlier report 1.8.0; everything since leads with the major.
	const major = matched[1] === '1' ? Number(matched[2]) : Number(matched[1]);

	return Number.isNaN(major) ? undefined : { path, major, mtime: Bun.file(path).lastModified };
};

export const installations = async ({ refresh = false } = {}) => {
	const cached = await readJson(cachePath(), undefined).catch(() => undefined);
	const paths_ = await candidatePaths();

	// A cached major is a belief about a path, and an in-place jdk upgrade rewrites the binary
	// without moving it. The mtime is what tells the two apart.
	if (!refresh && cached?.entries) {
		const stillValid = [];

		for (const entry of cached.entries) {
			const file = Bun.file(entry.path);

			if ((await file.exists()) && entry.mtime === file.lastModified) stillValid.push(entry);
		}

		if (stillValid.length === paths_.length) return stillValid;
	}

	const entries = (await Promise.all(paths_.map(probe))).filter(Boolean);

	await writeJson(cachePath(), { entries });

	return entries;
};

/**
 * The runtime a version runs on, in order of preference: an explicit path, a managed runtime
 * already here, a local JDK of the exact major the version was built against, and only then the
 * component Mojang names for it, fetched.
 *
 * The exact-major step is what keeps a machine that already has the right Java from downloading a
 * second copy of it, while a version whose major is missing still gets the runtime it expects
 * rather than whichever nearby one happens to be installed.
 */
export const selectJava = async (required, override, { component, manage = true } = {}) => {
	if (override) {
		const probed = await probe(override);

		if (probed === undefined) throw new Error(`Not a usable java binary: ${override}`);
		if (probed.major < required) warn(`${override} is Java ${probed.major}, but ${required} was asked for`);

		return probed;
	}

	const managed = component && (await isInstalled(component)) ? runtimeBinary(component) : undefined;

	if (managed) return (await probe(managed)) ?? { path: managed, major: required };

	const available = await installations();

	// A machine that already has the major this version was built against needs nothing downloaded.
	const exact = available.find(({ major }) => major === required);

	if (exact) {
		detail('java', exact.path, exact.major);

		return exact;
	}

	// Nothing here matches, so the version's own answer is fetched rather than a nearby major
	// pressed into service.
	if (component && manage) {
		const path = await provideRuntime(component);

		return (await probe(path)) ?? { path, major: required };
	}

	if (available.length === 0) {
		throw new Error(
			component
				? `No Java installation found. Run "ender java install ${component}", or set javaPath.`
				: 'No Java installation found. Install a JDK or set javaPath.',
		);
	}

	const suitable = available.filter(({ major }) => major >= required).sort((a, b) => a.major - b.major);

	if (suitable.length > 0) {
		detail('java', suitable[0].path, suitable[0].major);

		return suitable[0];
	}

	const newest = available.sort((a, b) => b.major - a.major)[0];

	warn(`Minecraft wants Java ${required}; the newest found is ${newest.major}. Trying it anyway.`);

	return newest;
};

export const managedRuntimes = installedRuntimes;

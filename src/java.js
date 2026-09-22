import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readJson, writeJson } from './json';
import { detail, warn } from './out';
import { paths } from './paths';

const searchRoots = [
	'/usr/lib/jvm',
	'/usr/java',
	'/Library/Java/JavaVirtualMachines',
	join(homedir(), '.local/share/PrismLauncher/java'),
	join(homedir(), '.sdkman/candidates/java'),
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
export const probe = async path => {
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

	return Number.isNaN(major) ? undefined : { path, major };
};

export const installations = async ({ refresh = false } = {}) => {
	const cached = await readJson(cachePath(), undefined).catch(() => undefined);

	if (!refresh && cached?.entries) {
		const stillThere = [];

		for (const entry of cached.entries) {
			if (await Bun.file(entry.path).exists()) stillThere.push(entry);
		}

		if (stillThere.length > 0) return stillThere;
	}

	const entries = (await Promise.all((await candidatePaths()).map(probe))).filter(Boolean);

	await writeJson(cachePath(), { entries });

	return entries;
};

/**
 * The closest runtime at or above what the version asks for. Running a game on a newer major than
 * Mojang tested is usually fine; running it on an older one reliably is not.
 */
export const selectJava = async (required, override) => {
	if (override) {
		const probed = await probe(override);

		if (probed === undefined) throw new Error(`Not a usable java binary: ${override}`);
		if (probed.major < required) warn(`${override} is Java ${probed.major}, but ${required} was asked for`);

		return probed;
	}

	const available = await installations();

	if (available.length === 0) throw new Error('No Java installation found. Install a JDK or set javaPath.');

	const suitable = available.filter(({ major }) => major >= required).sort((a, b) => a.major - b.major);

	if (suitable.length > 0) {
		detail('java', suitable[0].path, suitable[0].major);

		return suitable[0];
	}

	const newest = available.sort((a, b) => b.major - a.major)[0];

	warn(`Minecraft wants Java ${required}; the newest found is ${newest.major}. Trying it anyway.`);

	return newest;
};

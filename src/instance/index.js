import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

import { readJson, writeJson } from '../json';
import { instanceDir, lockPath, manifestPath, paths } from '../paths';

export const INSTANCE_NAME = /^\w[\w.-]{0,63}$/;

export const assertInstanceName = name => {
	if (!INSTANCE_NAME.test(name ?? '')) {
		throw new Error(
			`"${name}" cannot name an instance: start with a letter or digit, then use letters, digits, dots, dashes and underscores, 64 at most`,
		);
	}
};

/** A name anyone gave a pack, made into one an instance can take. */
export const instanceNameOf = text =>
	(text ?? '')
		.trim()
		.toLowerCase()
		.replaceAll(/[^\w.-]+/g, '-')
		.replaceAll(/^[-.]+|-+$/g, '')
		.slice(0, 64) || 'pack';

export const PRISM_ROOT = join(homedir(), '.local/share/PrismLauncher');

const isDirectory = async path => {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
};

/**
 * Caches belonging to other launchers that hold the same files under the same layout.
 * Adopting from them turns a first install from a gigabyte of downloads into a pass of hardlinks.
 */
export const defaultDonors = async () => {
	const donors = { libraries: [], assets: [] };

	for (const key of ['libraries', 'assets']) {
		const directory = join(PRISM_ROOT, key);

		if (await isDirectory(directory)) donors[key].push(directory);
	}

	return donors;
};

export const defaults = name => ({
	name,
	type: 'client',
	minecraft: 'release',
	loader: { type: 'fabric', version: undefined },
	gameDir: join(instanceDir(name), 'game'),
	username: undefined,
	memory: undefined,
	jvmArgs: [],
	env: {},
	mods: [],
});

export const exists = async name => Bun.file(manifestPath(name)).exists();

export const read = async name => {
	const manifest = await readJson(manifestPath(name), undefined).catch(() => undefined);

	if (manifest === undefined) throw new Error(`No instance named "${name}"`);

	return { ...defaults(name), ...manifest, name };
};

export const write = async manifest => {
	await writeJson(manifestPath(manifest.name), manifest);

	return manifest;
};

export const readLock = async name => readJson(lockPath(name), { mods: [] });

export const writeLock = async (name, lock) => writeJson(lockPath(name), lock);

export const list = async () => {
	const entries = await readdir(paths.instances).catch(() => []);
	const found = [];

	for (const entry of entries) {
		if (await exists(entry)) found.push(await read(entry));
	}

	return found.sort((a, b) => a.name.localeCompare(b.name));
};

/** An override that is undefined is an override that was not given, not one set to nothing. */
const given = overrides => Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));

export const create = async (name, overrides = {}) => {
	assertInstanceName(name);

	if (await exists(name)) throw new Error(`An instance named "${name}" already exists`);

	const manifest = { ...defaults(name), ...given(overrides), name };

	await mkdir(join(manifest.gameDir, 'mods'), { recursive: true });

	return write(manifest);
};

const isWithin = (path, directory) => {
	const between = relative(directory, path);

	return between !== '' && !between.startsWith('..');
};

/**
 * Forget an instance. A game directory inside the instance's own, as every default one is, is moved aside to
 * paths.kept rather than deleted with it, worlds and all; only purgeGameDir deletes it. Answers where it was kept.
 */
export const remove = async (name, { purgeGameDir = false } = {}) => {
	const manifest = await read(name);
	let kept;

	if (purgeGameDir) {
		await rm(manifest.gameDir, { recursive: true, force: true });
	} else if (isWithin(manifest.gameDir, instanceDir(name)) && (await isDirectory(manifest.gameDir))) {
		const stamp = `${name}-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}`;

		kept = join(paths.kept, stamp);

		for (let again = 2; await isDirectory(kept); again++) kept = join(paths.kept, `${stamp}-${again}`);

		await mkdir(paths.kept, { recursive: true });
		await rename(manifest.gameDir, kept);
	}

	await rm(instanceDir(name), { recursive: true, force: true });

	return { manifest, kept };
};

export const modsDir = manifest => join(manifest.gameDir, 'mods');

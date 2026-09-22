import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readJson, writeJson } from '../json';
import { instanceDir, lockPath, manifestPath, paths } from '../paths';

const PRISM_ROOT = join(homedir(), '.local/share/PrismLauncher');

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
	if (await exists(name)) throw new Error(`An instance named "${name}" already exists`);

	const manifest = { ...defaults(name), ...given(overrides), name };

	await mkdir(join(manifest.gameDir, 'mods'), { recursive: true });

	return write(manifest);
};

export const remove = async (name, { purgeGameDir = false } = {}) => {
	const manifest = await read(name);

	if (purgeGameDir) await rm(manifest.gameDir, { recursive: true, force: true });

	await rm(instanceDir(name), { recursive: true, force: true });

	return manifest;
};

export const modsDir = manifest => join(manifest.gameDir, 'mods');

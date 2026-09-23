import { readdir, unlink } from 'node:fs/promises';
import { basename, join, resolve as resolvePath } from 'node:path';

import { checksumOf, checksumText, ensureFile, pool } from '../download';
import { detail, fail, plural, progress, step, warn } from '../out';
import * as curseforge from './curseforge';
import * as github from './github';
import * as gradle from './gradle';
import * as modrinth from './modrinth';

/** Sources that can be searched. A gradle project is found on disk, not looked up. */
export const sources = { modrinth, curseforge, github };

const resolvers = { ...sources, gradle };

export const entryKey = entry => `${entry.source}:${entry.id ?? entry.path ?? entry.url}`;

const resolveLocal = entry => {
	const path = resolvePath(entry.path);

	return {
		source: 'local',
		id: entry.path,
		name: basename(path),
		version: 'local',
		file: { filename: entry.file ?? basename(path), localPath: path },
		dependencies: [],
	};
};

const resolveUrl = entry => ({
	source: 'url',
	id: entry.url,
	name: entry.file ?? basename(new URL(entry.url).pathname),
	version: 'url',
	file: {
		filename: entry.file ?? basename(new URL(entry.url).pathname),
		url: entry.url,
		checksum: checksumOf(entry.sha1 ?? entry.checksum),
	},
	dependencies: [],
});

/**
 * A filename is chosen by whoever published the mod, so it is a remote string on its way to a path.
 * Stripping it to a basename here covers every source at once, including ones added later.
 */
const named = resolution => {
	const filename = basename(resolution.file.filename);

	if (filename === '' || filename === '.' || filename === '..') {
		throw new Error(`${resolution.source}:${resolution.id} published an unusable filename`);
	}

	return { ...resolution, file: { ...resolution.file, filename } };
};

export const resolveEntry = async (entry, context) => {
	if (entry.source === 'local') return named(resolveLocal(entry));
	if (entry.source === 'url') return named(resolveUrl(entry));

	const source = resolvers[entry.source];

	if (source === undefined) throw new Error(`Unknown mod source "${entry.source}"`);

	return named(await source.resolve(entry, context));
};

/** Resolve the declared list, pulling in required dependencies the declared mods name. */
export const resolveAll = async (entries, context, { withDependencies = true } = {}) => {
	const resolved = new Map();
	const queue = entries.map(entry => ({ entry, requested: true }));

	while (queue.length > 0) {
		const { entry, requested } = queue.shift();
		const key = entryKey(entry);

		if (resolved.has(key)) continue;

		try {
			const resolution = await resolveEntry(entry, context);

			resolved.set(key, { ...resolution, key, requested });

			if (!withDependencies) continue;

			for (const dependency of resolution.dependencies ?? []) {
				if (!resolved.has(entryKey(dependency))) queue.push({ entry: dependency, requested: false });
			}
		} catch (error) {
			// A dependency we inferred is not worth failing the whole sync over.
			if (requested) throw error;

			warn(error.message);
		}
	}

	return [...resolved.values()];
};

const install = async (resolution, modsDir) => {
	const path = join(modsDir, resolution.file.filename);

	if (resolution.file.localPath) {
		await Bun.write(path, Bun.file(resolution.file.localPath));

		return path;
	}

	await ensureFile({
		url: resolution.file.url,
		path,
		checksum: resolution.file.checksum,
		size: resolution.file.size,
	});

	return path;
};

/**
 * Make the mods directory match the manifest.
 *
 * Only files a previous sync recorded in the lock are ever removed, so a jar dropped in by hand
 * stays where it was put.
 */
export const syncMods = async ({ entries, modsDir, lock, context, withDependencies = true }) => {
	const all = await resolveAll(entries, context, { withDependencies });

	// The same mod can be declared by slug and arrive again by project id. Two keys, one file:
	// installing both concurrently means two writers racing for one destination.
	const byFile = new Map();

	for (const resolution of all)
		if (!byFile.has(resolution.file.filename)) byFile.set(resolution.file.filename, resolution);

	const resolved = [...byFile.values()];
	const failures = [];
	let installed = resolved;

	if (resolved.length > 0) {
		const bar = progress();

		const outcomes = await pool(
			resolved,
			async resolution => {
				try {
					await install(resolution, modsDir);

					return resolution;
				} catch (error) {
					// Held rather than thrown: a lock that omits what landed orphans those files.
					failures.push({ resolution, error });

					return undefined;
				}
			},
			{ concurrency: 6, onProgress: (finished, total) => bar.update(`   mods ${finished}/${total}`) },
		);

		bar.clear();

		installed = outcomes.filter(Boolean);
	}

	const wanted = new Set(installed.map(resolution => resolution.file.filename));
	const previous = lock?.mods ?? [];
	const removed = [];

	for (const stale of previous) {
		if (wanted.has(stale.filename)) continue;

		try {
			await unlink(join(modsDir, stale.filename));

			removed.push(stale.filename);
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}

	const present = await readdir(modsDir).catch(() => []);
	const unmanaged = present.filter(file => file.endsWith('.jar') && !wanted.has(file));

	return {
		resolved: installed,
		failures,
		removed,
		unmanaged,
		lock: {
			mods: installed.map(resolution => ({
				key: resolution.key,
				source: resolution.source,
				id: resolution.id,
				name: resolution.name,
				version: resolution.version,
				filename: resolution.file.filename,
				checksum: checksumText(resolution.file.checksum),
				url: resolution.file.url,
				requested: resolution.requested,
			})),
		},
	};
};

export const reportSync = ({ resolved, failures = [], removed, unmanaged }) => {
	for (const resolution of resolved) {
		detail(resolution.requested ? '  ' : '  +', resolution.name, resolution.version);
	}

	step(`${plural(resolved.length, 'mod')} in place${removed.length > 0 ? `, ${removed.length} removed` : ''}`);

	if (unmanaged.length > 0) warn(`Left alone (not in the manifest): ${unmanaged.join(', ')}`);

	for (const { resolution, error } of failures) fail(`${resolution.source}:${resolution.id} :: ${error.message}`);

	return failures.length;
};

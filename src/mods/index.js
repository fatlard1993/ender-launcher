import { readdir, unlink } from 'node:fs/promises';
import { basename, join, resolve as resolvePath } from 'node:path';

import { checksumOf, checksumText, ensureFile, pool } from '../download';
import { readJson, writeJson } from '../json';
import { detail, fail, plural, progress, step, warn } from '../out';
import { gainedSince, scanJar } from './capabilities';
import * as curseforge from './curseforge';
import * as github from './github';
import * as gradle from './gradle';
import { readMods } from './metadata';
import * as modrinth from './modrinth';

/** Sources that can be searched. A gradle project is found on disk, not looked up. */
export const sources = { github, modrinth, curseforge };

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
 * Installed jars that declare a mod id an earlier one already declared. The loader refuses two
 * jars with one id, which is what the same mod arriving from two sources produces: Fabric API
 * declared from Modrinth and required again through the index. A declared mod is kept over an
 * inferred dependency, and otherwise the first in resolve order is.
 */
export const duplicateMods = resolutions => {
	const ordered = [...resolutions].sort((a, b) => Number(b.requested) - Number(a.requested));
	const owners = new Map();
	const kept = [];
	const dropped = [];

	for (const resolution of ordered) {
		const clash = resolution.modIds.find(id => owners.has(id));

		if (clash === undefined) {
			for (const id of resolution.modIds) owners.set(id, resolution);

			kept.push(resolution);
		} else dropped.push({ resolution, id: clash, keptAs: owners.get(clash) });
	}

	return { kept: resolutions.filter(resolution => kept.includes(resolution)), dropped };
};

const withModIds = async (resolution, modsDir) => {
	const mods = await readMods(join(modsDir, resolution.file.filename)).catch(() => []);

	return { ...resolution, modIds: [...new Set(mods.map(mod => mod.id).filter(Boolean))] };
};

/** A download takes the place of what the lock recorded under its key when any of these moved. */
const replaces = (resolution, locked) =>
	locked.filename !== resolution.file.filename ||
	locked.version !== resolution.version ||
	(locked.checksum !== undefined &&
		resolution.file.checksum !== undefined &&
		locked.checksum !== checksumText(resolution.file.checksum));

/**
 * Scan the jars that downloads are about to replace. This happens before installing, because a
 * replacement under the same file name would overwrite its own baseline.
 */
const scanBaselines = async (resolved, previous, modsDir) => {
	const locked = new Map(previous.map(mod => [mod.key, mod]));
	const replacing = resolved.filter(
		resolution =>
			resolution.file.url !== undefined &&
			locked.has(resolution.key) &&
			replaces(resolution, locked.get(resolution.key)),
	);
	const baselines = new Map();
	const bar = progress();

	for (const [index, resolution] of replacing.entries()) {
		const { filename, version } = locked.get(resolution.key);

		bar.update(`   scanning ${index + 1}/${replacing.length}`);

		try {
			baselines.set(resolution.key, { from: version, scan: await scanJar(join(modsDir, filename)) });
		} catch (error) {
			baselines.set(resolution.key, {
				from: version,
				error:
					error.code === 'ENOENT' ? new Error(`${filename} is gone, so there is nothing to compare against`) : error,
			});
		}
	}

	bar.clear();

	return baselines;
};

/** What each installed replacement can reach that the jar it replaced could not. */
const compareReplacements = async (installed, baselines, modsDir) => {
	const gained = [];
	const notCompared = [];
	const bar = progress();
	let index = 0;

	for (const resolution of installed) {
		const baseline = baselines.get(resolution.key);

		if (baseline === undefined) continue;

		bar.update(`   comparing ${++index}/${baselines.size}`);

		try {
			if (baseline.error) throw baseline.error;

			const found = gainedSince(baseline.scan, await scanJar(join(modsDir, resolution.file.filename)));

			if (Object.keys(found.capabilities).length + Object.keys(found.hosts).length + found.unreadable.length > 0) {
				gained.push({ resolution, from: baseline.from, gained: found });
			}
		} catch (error) {
			notCompared.push({ resolution, from: baseline.from, error });
		}
	}

	bar.clear();

	return { gained, notCompared };
};

/**
 * Make the mods directory match the manifest.
 *
 * Only files a previous sync recorded in the lock are ever removed, so a jar dropped in by hand
 * stays where it was put.
 */
export const syncMods = async ({ entries, modsDir, lock, context, withDependencies = true, modIdCache }) => {
	const all = await resolveAll(entries, context, { withDependencies });

	// The same mod can be declared by slug and arrive again by project id. Two keys, one file:
	// installing both concurrently means two writers racing for one destination.
	const byFile = new Map();

	for (const resolution of all)
		if (!byFile.has(resolution.file.filename)) byFile.set(resolution.file.filename, resolution);

	const knownIds = modIdCache ? await readJson(modIdCache, {}) : {};
	const idsOf = resolution => knownIds[checksumText(resolution.file.checksum)];

	// Jars whose ids are already known by checksum settle their clashes before anything downloads.
	// Only a jar that would lose under the full rule is dropped here, so the result is the same.
	const early = duplicateMods(
		[...byFile.values()].filter(idsOf).map(resolution => ({ ...resolution, modIds: idsOf(resolution) })),
	).dropped;
	const earlyKeys = new Set(early.map(({ resolution }) => resolution.key));
	const resolved = [...byFile.values()].filter(resolution => !earlyKeys.has(resolution.key));
	const previous = lock?.mods ?? [];
	const baselines = await scanBaselines(resolved, previous, modsDir);
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

	const identified = await Promise.all(installed.map(resolution => withModIds(resolution, modsDir)));
	const { kept, dropped: late } = duplicateMods(identified);
	const duplicates = [...early, ...late];

	for (const { resolution } of late) await unlink(join(modsDir, resolution.file.filename)).catch(() => {});

	if (modIdCache) {
		let learned = false;

		for (const resolution of identified) {
			const key = checksumText(resolution.file.checksum);

			if (key !== undefined && knownIds[key] === undefined) {
				knownIds[key] = resolution.modIds;
				learned = true;
			}
		}

		if (learned) await writeJson(modIdCache, knownIds);
	}

	installed = kept;

	const { gained, notCompared } = await compareReplacements(installed, baselines, modsDir);
	const wanted = new Set(installed.map(resolution => resolution.file.filename));
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
		gained,
		notCompared,
		duplicates,
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

const evidence = classes => {
	const [[where, via], ...rest] = Object.entries(classes);

	return `${where} (${via.join(', ')})${rest.length > 0 ? ` and ${plural(rest.length, 'more class', 'es')}` : ''}`;
};

export const reportSync = ({
	resolved,
	failures = [],
	gained = [],
	notCompared = [],
	duplicates = [],
	removed,
	unmanaged,
}) => {
	for (const resolution of resolved) {
		detail(resolution.requested ? '  ' : '  +', resolution.name, resolution.version);
	}

	step(`${plural(resolved.length, 'mod')} in place${removed.length > 0 ? `, ${removed.length} removed` : ''}`);

	if (unmanaged.length > 0) warn(`Left alone (not in the manifest): ${unmanaged.join(', ')}`);

	for (const { resolution, from, gained: found } of gained) {
		const mod = `${resolution.source}:${resolution.id} ${resolution.version}`;

		for (const [capability, classes] of Object.entries(found.capabilities)) {
			warn(`${mod} gained ${capability} since ${from}: ${evidence(classes)}`);
		}

		for (const [host, classes] of Object.entries(found.hosts)) {
			warn(`${mod} names a new host since ${from}: ${host} in ${classes[0]}`);
		}

		if (found.unreadable.length > 0)
			warn(`${mod} has unreadable classes since ${from}: ${found.unreadable.join(', ')}`);
	}

	for (const { resolution, id, keptAs } of duplicates) {
		const line = `${resolution.source}:${resolution.id} is mod "${id}", already here from ${keptAs.source}:${keptAs.id}; not installed`;

		if (resolution.requested) warn(`${line}. It is declared twice; drop one.`);
		else detail(line);
	}

	for (const { resolution, from, error } of notCompared) {
		warn(`${resolution.source}:${resolution.id} ${resolution.version} was not compared with ${from}: ${error.message}`);
	}

	for (const { resolution, error } of failures) fail(`${resolution.source}:${resolution.id} :: ${error.message}`);

	return failures.length;
};

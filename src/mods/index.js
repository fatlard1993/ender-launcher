import { mkdir, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';

import { checksumOf, checksumText, ensureFile, pool } from '../download';
import { version as enderVersion } from '../../package.json';
import { readJson, writeJson } from '../json';
import { detail, fail, info, paint, plural, progress, step, warn } from '../out';
import { readConfig, updateConfig } from '../config';
import { gainedSince, scanJar } from './capabilities';
import * as curseforge from './curseforge';
import * as github from './github';
import * as gradle from './gradle';
import * as indexed from './indexed';
import { readMods } from './metadata';
import * as modrinth from './modrinth';

/** Sources that can be searched. A gradle project is found on disk, not looked up. */
export const sources = { index: indexed, modrinth, curseforge };

const resolvers = {
	github,
	codeberg: indexed.hosted('codeberg'),
	gitlab: indexed.hosted('gitlab'),
	modrinth,
	curseforge,
	gradle,
};

export const entryKey = entry => `${entry.source}:${entry.id ?? entry.path ?? entry.url}`;

/** Whether an instance installs an entry: every one it declares, but an optional one only once a player turns it on. */
export const isWanted = manifest => {
	const chosen = new Set(manifest.chosen ?? []);

	return entry => !entry.optional || chosen.has(entryKey(entry));
};

/**
 * An instance's entries with what a pack chose at the start moved to its `chosen` list: an optional entry a pack turns
 * on by default is on until a player turns it off, and the mark itself is not kept on the entry.
 */
export const takeChosen = manifest => {
	const chosen = new Set(manifest.chosen ?? []);

	for (const kind of ['mods', 'resourcepacks', 'shaderpacks']) {
		manifest[kind] = (manifest[kind] ?? []).map(({ chosen: on, ...entry }) => {
			if (on) chosen.add(entryKey(entry));

			return entry;
		});
	}

	if (chosen.size > 0) manifest.chosen = [...chosen];

	return manifest;
};

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
const spellingOf = claimant =>
	`${{ github: 'gh', codeberg: 'cb', gitlab: 'gl' }[claimant.host ?? 'github']}:${claimant.repo}`;

const lastSegment = id =>
	String(id ?? '')
		.split('/')
		.at(-1)
		.toLowerCase();

/**
 * The required mod ids the index could not place for these resolutions, less those an entry in `declared` already
 * answers: one naming the id itself, as mr:mixinextras does, or one of the repositories claiming it.
 */
export const unplacedOf = (resolutions, declared) => {
	const named = new Set(declared.map(entry => lastSegment(entry.id)));
	const keys = new Set(declared.map(entryKey));

	return resolutions.flatMap(resolution =>
		(resolution.unplaced ?? [])
			.filter(
				({ modId, claimants }) =>
					!named.has(modId.toLowerCase()) &&
					!claimants.some(claimant => keys.has(`${claimant.host ?? 'github'}:${claimant.repo}`)),
			)
			.map(missing => ({ ...missing, requiredBy: `${resolution.source}:${resolution.id}` })),
	);
};

/** Why a mod cannot come with what it requires, and for each repository claiming it, the line that would bring it. */
export const unplacedMessage = (unplaced, command) =>
	unplaced
		.map(({ modId, claimants, requiredBy }) => {
			const named = claimants.slice(0, 3);

			if (named.length === 0) {
				return `${requiredBy} requires "${modId}", which the index does not know. Name its source beside it: ${command} gh:owner/repo, mr:<slug> or cf:<slug>.`;
			}

			return [
				`${requiredBy} requires "${modId}", and no repository claiming it is established enough to install unasked. Name the one you trust beside it, or its own source:`,
				...named.map(claimant => `  ${command} ${spellingOf(claimant)}   ${plural(claimant.stars ?? 0, 'star')}`),
			].join('\n');
		})
		.join('\n');

/** How many mods resolve at once: each is a request or two to the index, GitHub or Modrinth. */
export const RESOLVE_CONCURRENCY = 8;

/**
 * Resolve the declared list, pulling in required dependencies the declared mods name. The declared mods resolve
 * together, then the dependencies they name, then theirs, and the result keeps that order: which of two jars with one
 * mod id is kept is decided by it.
 */
export const resolveAll = async (entries, context, { withDependencies = true } = {}) => {
	const resolved = new Map();
	let wave = entries.map(entry => ({ entry, requested: true }));

	while (wave.length > 0) {
		const pending = new Map();

		for (const item of wave) {
			const key = entryKey(item.entry);

			if (!resolved.has(key) && !pending.has(key)) pending.set(key, item);
		}

		const items = [...pending.entries()];
		const outcomes = await pool(
			items,
			async ([, { entry }]) => {
				try {
					return { resolution: await resolveEntry(entry, context) };
				} catch (error) {
					return { error };
				}
			},
			{ concurrency: RESOLVE_CONCURRENCY },
		);

		wave = [];

		for (const [at, { resolution, error }] of outcomes.entries()) {
			const [key, { requested }] = items[at];

			if (error) {
				// A dependency we inferred is not worth failing the whole sync over.
				if (requested) throw error;

				warn(error.message);

				continue;
			}

			resolved.set(key, { ...resolution, key, requested });

			if (!withDependencies) continue;

			const missing = unplacedOf([resolution], entries);

			if (missing.length > 0) warn(unplacedMessage(missing, 'ender add'));

			for (const dependency of resolution.dependencies ?? []) {
				if (!resolved.has(entryKey(dependency))) wave.push({ entry: dependency, requested: false });
			}
		}
	}

	return [...resolved.values()];
};

const samePlace = async (a, b) =>
	(await realpath(a).catch(() => resolvePath(a))) === (await realpath(b).catch(() => resolvePath(b)));

const install = async (resolution, modsDir) => {
	const path = join(modsDir, resolution.file.filename);

	if (resolution.file.localPath) {
		// A jar declared from inside mods/ itself is already in place; written onto itself it would be emptied.
		if (!(await samePlace(resolution.file.localPath, path))) await Bun.write(path, Bun.file(resolution.file.localPath));

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

/** Whether every mod a jar declares runs on the client alone; a jar that declares none is not taken for one. */
const clientOnly = async path => {
	const mods = await readMods(path).catch(() => []);

	return mods.length > 0 && mods.every(mod => mod.environment === 'client');
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
 * A jar's scan, kept in `scanCache` by the mod it belongs to and the jar's own hash: the jar a replacement was compared
 * against last time is the baseline the next replacement is compared with, and a large one takes seconds to read.
 */
const scanKept = async (path, key, scanCache) => {
	if (scanCache === undefined) return scanJar(path);

	const sha256 = new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex');
	const file = join(scanCache, `${new Bun.CryptoHasher('sha1').update(key).digest('hex')}.json`);
	const kept = await readJson(file, {}).catch(() => ({}));

	if (kept.sha256 === sha256 && kept.version === enderVersion) return kept.scan;

	const scan = await scanJar(path);

	await writeJson(file, { key, sha256, version: enderVersion, scan }).catch(() => {});

	return scan;
};

/**
 * Scan the jars that downloads are about to replace. This happens before installing, because a
 * replacement under the same file name would overwrite its own baseline.
 */
const scanBaselines = async (resolved, previous, modsDir, scanCache) => {
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
			baselines.set(resolution.key, {
				from: version,
				scan: await scanKept(join(modsDir, filename), resolution.key, scanCache),
			});
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
const compareReplacements = async (installed, baselines, modsDir, scanCache) => {
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

			const found = gainedSince(
				baseline.scan,
				await scanKept(join(modsDir, resolution.file.filename), resolution.key, scanCache),
			);

			const news =
				Object.keys(found.capabilities).length +
				Object.keys(found.signals).length +
				Object.keys(found.secrets).length +
				Object.keys(found.hosts).length +
				found.hidden.length +
				found.unreadable.length;

			if (news > 0) {
				gained.push({ resolution, from: baseline.from, gained: found });
			}
		} catch (error) {
			notCompared.push({ resolution, from: baseline.from, error });
		}
	}

	bar.clear();

	return { gained, notCompared };
};

/** The names a scan gives the places other programs keep their logins, as a player would know them. */
const STORES = {
	discord: "Discord's login token",
	browser: "a browser's saved logins and cookies",
	wallet: 'a cryptocurrency wallet',
	telegram: "Telegram's session",
	steam: "Steam's sign in",
};

/**
 * Whether a jar may be installed though its code names where other programs keep logins: only once the player allowed
 * this very jar, by its hash, so a later build of the same mod is asked about again.
 */
export const allowSecrets = async (sha256, allowing) => {
	const { trustedJars = [] } = await readConfig();

	if (trustedJars.includes(sha256)) return true;
	if (!allowing) return false;

	await updateConfig({ trustedJars: [...trustedJars, sha256] });

	return true;
};

/**
 * The jars just installed whose code names where other programs keep logins, taken out again unless the player
 * allowed them: no mod has a reason to, and stealing those is what Minecraft malware is for. Each is a failure, so the
 * build it was to replace stays.
 */
const holdSecrets = async (installed, previous, modsDir, scanCache, trusting) => {
	const unchanged = new Set(previous.map(mod => `${mod.filename}\0${mod.checksum}`));
	const cleared = [];
	const refused = [];
	const bar = progress();

	for (const [index, resolution] of installed.entries()) {
		const path = join(modsDir, resolution.file.filename);

		bar.update(`   checking ${index + 1}/${installed.length}`);

		if (unchanged.has(`${resolution.file.filename}\0${checksumText(resolution.file.checksum)}`)) {
			cleared.push(resolution);
			continue;
		}

		const scan = await scanKept(path, resolution.key, scanCache).catch(() => undefined);
		const stores = Object.keys(scan?.secrets ?? {});

		if (stores.length === 0) {
			cleared.push(resolution);
			continue;
		}

		const sha256 = new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex');

		if (await allowSecrets(sha256, trusting)) {
			cleared.push(resolution);
			continue;
		}

		await unlink(path).catch(() => {});
		refused.push({
			resolution,
			error: new Error(
				`not installed: its code names where ${stores.map(store => STORES[store] ?? store).join(', ')} ${stores.length === 1 ? 'is' : 'are'} kept, which no mod has a reason to. If you are sure of it, the same command with --trust allows this jar [sha256:${sha256}]`,
			),
		});
	}

	bar.clear();

	return { cleared, refused };
};

/** Where a jar goes that would stop the game loading beside one ender manages: beside mods/, where no loader looks. */
export const displacedDir = modsDir => join(dirname(modsDir), 'mods-displaced');

/**
 * Jars nobody asked ender for that carry a mod id ender already installs. A loader refuses to start with two jars of
 * one id, so each is moved aside rather than left to stop the game. Answers what moved, and which id each repeated.
 */
const displaceCopies = async (files, installed, modsDir) => {
	const managed = new Set(installed.flatMap(resolution => resolution.modIds ?? []));
	const displaced = [];

	for (const file of files) {
		const ids = (await readMods(join(modsDir, file)).catch(() => [])).map(mod => mod.id);
		const repeated = ids.find(id => managed.has(id));

		if (repeated === undefined) continue;

		await mkdir(displacedDir(modsDir), { recursive: true });
		await rename(join(modsDir, file), join(displacedDir(modsDir), file));
		displaced.push({ file, id: repeated });
	}

	return displaced;
};

/**
 * Make the mods directory match the manifest.
 *
 * Only files a previous sync recorded in the lock are ever removed, so a jar dropped in by hand
 * stays where it was put, unless it is another copy of a mod this sync installs.
 */
export const syncMods = async ({
	entries,
	modsDir,
	lock,
	context,
	withDependencies = true,
	modIdCache,
	scanCache,
	clientOnlyCache,
}) => {
	const serving = context.side === 'server';
	const clientOnlyKnown = serving && clientOnlyCache ? new Set(await readJson(clientOnlyCache, [])) : new Set();
	const leftForClients = [];
	const all = (await resolveAll(entries, context, { withDependencies })).filter(resolution => {
		const known = clientOnlyKnown.has(checksumText(resolution.file.checksum));

		if (known) leftForClients.push(resolution);

		return !known;
	});

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
	const baselines = await scanBaselines(resolved, previous, modsDir, scanCache);
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

	// An installed jar matched its checksum, so the ids read from that checksum before are its own.
	const identified = await Promise.all(
		installed.map(resolution =>
			idsOf(resolution)?.length > 0 ? { ...resolution, modIds: idsOf(resolution) } : withModIds(resolution, modsDir),
		),
	);
	const { kept: oneEach, dropped: late } = duplicateMods(identified);
	// A server leaves out a jar whose every mod says it runs on the client alone, as its loader would ignore or refuse it
	const kept = [];

	for (const resolution of oneEach) {
		if (serving && (await clientOnly(join(modsDir, resolution.file.filename)))) {
			await unlink(join(modsDir, resolution.file.filename)).catch(() => {});
			leftForClients.push(resolution);
			if (resolution.file.checksum) clientOnlyKnown.add(checksumText(resolution.file.checksum));
		} else kept.push(resolution);
	}

	if (serving && clientOnlyCache && leftForClients.length > 0) {
		await writeJson(clientOnlyCache, [...clientOnlyKnown].filter(Boolean).toSorted());
	}
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

	const { cleared, refused } = await holdSecrets(kept, previous, modsDir, scanCache, context.trustSecrets ?? false);

	installed = cleared;
	failures.push(...refused);

	const { gained, notCompared } = await compareReplacements(installed, baselines, modsDir, scanCache);
	const wanted = new Set(installed.map(resolution => resolution.file.filename));
	const failedKeys = new Set(failures.map(({ resolution }) => resolution.key));
	const held = [];
	const removed = [];

	for (const stale of previous) {
		if (wanted.has(stale.filename)) continue;

		// A mod whose new build did not arrive keeps the build it had: the game starts with the mod a day behind rather
		// than without it.
		if (failedKeys.has(stale.key) && (await Bun.file(join(modsDir, stale.filename)).exists())) {
			held.push(stale);
			wanted.add(stale.filename);

			continue;
		}

		try {
			await unlink(join(modsDir, stale.filename));

			removed.push(stale.filename);
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}

	const present = await readdir(modsDir).catch(() => []);
	const strays = present.filter(file => file.endsWith('.jar') && !wanted.has(file));
	const displaced = await displaceCopies(strays, installed, modsDir);
	const moved = new Set(displaced.map(({ file }) => file));
	const unmanaged = strays.filter(file => !moved.has(file));

	return {
		resolved: installed,
		failures,
		held,
		gained,
		notCompared,
		duplicates,
		removed,
		unmanaged,
		displaced,
		leftForClients,
		lock: {
			mods: [
				...installed.map(resolution => ({
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
				...held,
			],
		},
	};
};

export const evidence = classes => {
	const [[where, via], ...rest] = Object.entries(classes);

	return `${where} (${via.join(', ')})${rest.length > 0 ? ` and ${plural(rest.length, 'more class', 'es')}` : ''}`;
};

export const reportSync = ({
	resolved,
	failures = [],
	held = [],
	gained = [],
	notCompared = [],
	duplicates = [],
	removed,
	unmanaged,
	displaced = [],
	leftForClients = [],
	modsDir,
}) => {
	for (const resolution of resolved) {
		detail(resolution.requested ? '  ' : '  +', resolution.name, resolution.version);
	}

	step(`${plural(resolved.length, 'mod')} in place${removed.length > 0 ? `, ${removed.length} removed` : ''}`);

	if (unmanaged.length > 0) warn(`Left alone (not in the manifest): ${unmanaged.join(', ')}`);

	if (leftForClients.length > 0) {
		info(
			paint.dim(
				`   ${plural(leftForClients.length, 'mod')} left out, as ${leftForClients.length === 1 ? 'it runs' : 'they run'} on the client alone: ${leftForClients.map(resolution => resolution.name ?? resolution.id).join(', ')}`,
			),
		);
	}

	for (const { file, id } of displaced) {
		warn(`${file} was another copy of ${id}, which ender installs, so it was moved to ${displacedDir(modsDir)}`);
	}

	for (const { resolution, from, gained: found } of gained) {
		const mod = `${resolution.source}:${resolution.id} ${resolution.version}`;

		for (const [capability, classes] of Object.entries(found.capabilities)) {
			warn(`${mod} gained ${capability} since ${from}: ${evidence(classes)}`);
		}

		for (const [signal, classes] of Object.entries(found.signals)) {
			warn(`${mod} gained a ${signal} warning since ${from}: ${evidence(classes)}`);
		}

		for (const [store, classes] of Object.entries(found.secrets)) {
			warn(`${mod} names where ${STORES[store] ?? store} is kept, since ${from}: ${evidence(classes)}`);
		}

		if (found.hidden.length > 0) warn(`${mod} hides code under other names since ${from}: ${found.hidden.join(', ')}`);

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

	const kept = new Map(held.map(mod => [mod.key, mod]));

	for (const { resolution, error } of failures) {
		const previous = kept.get(resolution.key);

		fail(
			`${resolution.source}:${resolution.id} :: ${error.message}${previous ? `; ${previous.version} stays installed` : ''}`,
		);
	}

	return failures.length;
};

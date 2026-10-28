import { mkdir, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { readConfig } from '../config';
import * as instances from '../instance';
import { scanJar } from '../mods/capabilities';
import { listing } from '../mods/catalog';
import { ownerName, supportOf } from '../mods/support';
import { entryKey, evidence, reportSync, resolveAll, sources, syncMods } from '../mods';
import { done, fail, info, paint, plural, step, warn } from '../out';
import { paths } from '../paths';
import { parseModSpec, refineModSpec, specFor, targetInstance } from './context';
import { refreshFromPack } from './packSource';

const contextFor = (manifest, config, flags = {}) => ({
	minecraft: manifest.minecraft,
	loader: manifest.loader?.type === 'vanilla' ? undefined : manifest.loader?.type,
	key: config.curseforgeKey,
	githubToken: config.githubToken,
	index: config.index,
	allowPrerelease: flags.pre ?? manifest.prerelease ?? config.prerelease ?? false,
	// A source built from disk is rebuilt only when asked, because a gradle build is not something
	// to run behind someone during an ordinary sync.
	buildMissing: flags.build ?? false,
	rebuild: flags.build ?? false,
});

/**
 * A spec naming something already declared: a bare name the index cannot place may still be an
 * older entry's own id, such as a Modrinth slug, so it is matched as written rather than refused.
 */
const leniently = async (spec, config) => {
	try {
		return await refineModSpec(parseModSpec(spec), { index: config.index });
	} catch {
		return parseModSpec(spec);
	}
};

export const syncInstance = async (manifest, config, { withDependencies = true, flags = {} } = {}) => {
	const directory = instances.modsDir(manifest);

	await mkdir(directory, { recursive: true });

	const result = await syncMods({
		entries: manifest.mods,
		modsDir: directory,
		lock: await instances.readLock(manifest.name),
		context: contextFor(manifest, config, flags),
		withDependencies,
		modIdCache: join(paths.cache, 'mod-ids.json'),
	});

	await instances.writeLock(manifest.name, result.lock);

	reportSync(result);

	return result;
};

export const sync = async ({ positionals, flags }) => {
	const { manifest, config } = await targetInstance(flags.instance ?? positionals[0]);

	step(`Syncing mods for ${manifest.name}`);

	const { failures } = await syncInstance(manifest, config, { withDependencies: flags.deps !== false, flags });

	return failures.length > 0 ? 1 : 0;
};

export const add = async ({ positionals, flags }) => {
	const { manifest, config } = await targetInstance(flags.instance);

	if (positionals.length === 0) throw new Error('ender add <mod> [mod...]');

	const existing = new Set(manifest.mods.map(entryKey));
	const added = [];

	for (const spec of positionals) {
		const entry = await refineModSpec(parseModSpec(spec), { index: config.index });

		// A relative path means something different from every other directory, so it is anchored
		// now, the way --game-dir already is, rather than at each sync.
		if (entry.path) entry.path = resolve(entry.path);

		if (existing.has(entryKey(entry))) {
			warn(`${spec} is already declared`);

			continue;
		}

		existing.add(entryKey(entry));
		added.push(entry);
	}

	if (added.length === 0) return 0;

	// Resolved before it is written: a name that cannot be found must not enter the manifest, or
	// every later mod command on this instance fails on a typo nothing will show you.
	await resolveAll(added, contextFor(manifest, config, flags), { withDependencies: false });

	manifest.mods.push(...added);

	await instances.write(manifest);

	step(`Added ${plural(added.length, 'mod')} to ${manifest.name}`);

	await syncInstance(manifest, config, { withDependencies: flags.deps !== false, flags });

	const { authors } = authorsOf(added, await listing({ index: config.index }).catch(() => []));

	if (authors.length > 0) {
		info(
			paint.dim(
				`  ${plural(authors.length, 'author')} of what you added ${authors.length === 1 ? 'takes' : 'take'} support: ender support says how`,
			),
		);
	}

	return 0;
};

export const drop = async ({ positionals, flags }) => {
	const { manifest, config } = await targetInstance(flags.instance);

	if (positionals.length === 0) throw new Error('ender drop <mod> [mod...]');

	const wanted = new Set(
		await Promise.all(
			positionals.map(async spec => {
				const entry = await leniently(spec, config);

				if (entry.path) entry.path = resolve(entry.path);

				return entryKey(entry);
			}),
		),
	);
	// Path and url entries carry no id. Without the filter every one of them matches `undefined`
	// and a single unrelated argument drops the lot.
	const byId = new Set(positionals.map(spec => parseModSpec(spec).id).filter(Boolean));

	const kept = manifest.mods.filter(entry => !wanted.has(entryKey(entry)) && !byId.has(entry.id));
	const dropped = manifest.mods.length - kept.length;

	if (dropped === 0) {
		warn('Nothing matched. "ender info" lists what is declared.');

		return 1;
	}

	manifest.mods = kept;

	await instances.write(manifest);

	step(`Dropped ${plural(dropped, 'mod')} from ${manifest.name}`);

	await syncInstance(manifest, config, { withDependencies: flags.deps !== false, flags });

	return 0;
};

/** Unpin everything (or the named mods) so the next resolve picks up newer builds. */
/** The pins an update releases: those set beside a pack, never the pack's own, and of `targeted` alone when given. */
export const releasePins = (manifest, targeted) => {
	const packed = new Set(manifest.pack?.mods ?? []);
	let unpinned = 0;
	const mods = manifest.mods.map(entry => {
		if (entry.version === undefined || packed.has(entryKey(entry))) return entry;
		if (targeted && !targeted.has(entry.id)) return entry;

		++unpinned;

		return { ...entry, version: undefined };
	});

	return { mods, unpinned };
};

/**
 * Bring an instance's mods to the newest builds that fit: a pack-made instance first takes its pack's newest word, and
 * the pins released are those set beside the pack, never the pack's own, or `targeted` alone when given.
 */
export const updateInstance = async (manifest, config, { targeted, flags = {} } = {}) => {
	let packChanges = 0;

	if (manifest.pack) {
		const { added, dropped, moved } = await refreshFromPack(manifest, config);

		packChanges = added.length + dropped.length + (moved ? 1 : 0);

		if (moved) info(`  the pack moved to ${paint.green(moved)}`);
		for (const key of added) info(`  ${paint.green('+')} ${key}`);
		for (const key of dropped) info(`  ${paint.red('-')} ${key}`);
	}

	const { mods, unpinned } = releasePins(manifest, targeted);

	manifest.mods = mods;
	await instances.write(manifest);

	step(`Updating ${manifest.name}${unpinned > 0 ? ` (${plural(unpinned, 'pin')} released)` : ''}`);

	const before = new Map((await instances.readLock(manifest.name)).mods.map(mod => [mod.key, mod.version]));
	const { lock, failures } = await syncInstance(manifest, config, { withDependencies: flags.deps !== false, flags });
	const changed = lock.mods.filter(mod => before.get(mod.key) !== undefined && before.get(mod.key) !== mod.version);

	for (const mod of changed) info(`  ${mod.name} ${paint.dim(before.get(mod.key))} -> ${paint.green(mod.version)}`);

	return { changed, failures, current: changed.length === 0 && packChanges === 0 };
};

/** What an update says it did. */
export const updatedLine = ({ changed, current }) => {
	if (current) return 'Everything was already current';

	return changed.length > 0 ? `${plural(changed.length, 'mod')} updated` : "Updated to the pack's newest list";
};

export const update = async ({ positionals, flags }) => {
	const { manifest, config } = await targetInstance(flags.instance);
	const targeted =
		positionals.length > 0
			? new Set(
					(
						await Promise.all(
							positionals.map(async spec => [parseModSpec(spec).id, (await leniently(spec, config)).id]),
						)
					).flat(),
				)
			: undefined;
	const result = await updateInstance(manifest, config, { targeted, flags });

	done(updatedLine(result));

	return result.failures.length > 0 ? 1 : 0;
};

export const search = async ({ positionals, flags }) => {
	const query = positionals.join(' ');

	if (query === '') throw new Error('ender search <query>');

	let minecraft = flags.minecraft;
	let loader = flags.loader;
	const config = await readConfig();

	if (flags.instance !== undefined || (minecraft === undefined && flags.any !== true)) {
		try {
			const { manifest } = await targetInstance(flags.instance);

			minecraft ??= manifest.minecraft;
			loader ??= manifest.loader?.type === 'vanilla' ? undefined : manifest.loader?.type;
		} catch {
			// Searching without an instance is fine; it just cannot narrow by version.
		}
	}

	// `github` searched the index before the index covered more than GitHub.
	const wanted = flags.source ? [flags.source === 'github' ? 'index' : flags.source] : Object.keys(sources);
	let printed = 0;

	for (const name of wanted) {
		const source = sources[name];

		if (source === undefined) throw new Error(`Unknown source "${name}"`);

		let hits;

		try {
			hits = await source.search(query, {
				minecraft,
				loader,
				limit: flags.limit,
				key: config.curseforgeKey,
				githubToken: config.githubToken,
				index: config.index,
			});
		} catch (error) {
			fail(`${source.label}: ${error.message}`);

			continue;
		}

		if (hits.length === 0) continue;

		const scope = `${minecraft ?? 'any version'} / ${loader ?? 'any loader'}`;
		const note = hits[0]?.exact ? ' :: exact slug, there is no keyless search' : '';

		info(`${paint.bold(source.label)} ${paint.dim(scope + note)}`);

		for (const hit of hits) {
			const count = `${hit.downloads.toLocaleString()} ${hit.stars ? 'stars' : 'downloads'}`;

			info(`  ${paint.cyan(specFor(hit.source, hit.id))} ${paint.dim(hit.note ? `${count} · ${hit.note}` : count)}`);
			info(`    ${hit.name} ${paint.dim('--')} ${hit.description?.slice(0, 90) ?? ''}`);
		}

		printed += hits.length;
	}

	if (printed === 0) info('Nothing matched.');

	return 0;
};

/** The jars a scan covers: jar files named by path, installed mods named by file, id or key, or else all of mods/. */
const scanTargets = async (positionals, flags) => {
	const onDisk = await Promise.all(positionals.map(target => Bun.file(resolve(target)).exists()));

	if (positionals.length > 0 && onDisk.every(Boolean)) return positionals.map(target => resolve(target));

	const { manifest } = await targetInstance(flags.instance);
	const directory = instances.modsDir(manifest);

	if (positionals.length === 0) {
		return (await readdir(directory).catch(() => []))
			.filter(file => file.endsWith('.jar'))
			.sort()
			.map(file => join(directory, file));
	}

	const { mods } = await instances.readLock(manifest.name);

	return positionals.map((target, index) => {
		if (onDisk[index]) return resolve(target);

		const match = mods.find(mod => [mod.filename, mod.id, mod.key].includes(target));

		if (match === undefined) throw new Error(`${target} is neither a jar file nor a mod installed in ${manifest.name}`);

		return join(directory, match.filename);
	});
};

/** What each jar's code can reach: one line per jar for a whole mods/, the evidence for named ones. */
export const scan = async ({ positionals, flags }) => {
	const paths = await scanTargets(positionals, flags);
	const detailed = positionals.length > 0;
	const results = [];
	let failed = 0;

	if (paths.length > 3) step(`Scanning ${plural(paths.length, 'jar')}`);

	for (const path of paths) {
		try {
			results.push({ path, findings: await scanJar(path) });
		} catch (error) {
			fail(`${basename(path)} :: ${error.message}`);

			++failed;
		}
	}

	if (flags.json) {
		info(JSON.stringify(Object.fromEntries(results.map(({ path, findings }) => [path, findings])), undefined, '\t'));

		return failed > 0 ? 1 : 0;
	}

	for (const { path, findings } of results) {
		const reach = Object.keys(findings.capabilities);
		const hosts = Object.keys(findings.hosts);

		info(
			`${paint.bold(basename(path))} ${reach.length > 0 ? reach.join(' ') : paint.dim('reaches none of exec, classloading, native, network, unsafe')}`,
		);

		if (!detailed) continue;

		for (const [capability, classes] of Object.entries(findings.capabilities))
			info(`  ${capability.padEnd(12)} ${evidence(classes)}`);
		if (hosts.length > 0) info(`  ${'hosts'.padEnd(12)} ${hosts.join(' ')}`);
		if (findings.unreadable.length > 0) info(`  ${'unreadable'.padEnd(12)} ${findings.unreadable.join(' ')}`);

		info(paint.dim(`  ${plural(findings.classes, 'class', 'es')}, ${plural(findings.jars.length, 'nested jar')}`));
	}

	return failed > 0 ? 1 : 0;
};

export { parseModSpec, refineModSpec } from './context';

const REPOSITORY_SOURCES = new Set(['github', 'codeberg', 'gitlab']);

/**
 * Who made the mods an instance holds and how each takes support, author by author, from the index; and which mods
 * the index knows no way to support. Mods from Modrinth or CurseForge are counted apart: those sites pay their authors
 * themselves, and their pages say how else to.
 */
export const authorsOf = (mods, entries) => {
	const byRepository = new Map(entries.map(entry => [`${entry.host ?? 'github'}:${entry.repo}`, entry]));
	const authors = new Map();
	const unsupported = [];
	const elsewhere = [];
	const seen = new Set();

	for (const mod of mods) {
		const key = `${mod.source}:${mod.id}`;

		if (seen.has(key)) continue;
		seen.add(key);

		if (!REPOSITORY_SOURCES.has(mod.source)) {
			if (mod.source === 'modrinth' || mod.source === 'curseforge') elsewhere.push(key);

			continue;
		}

		const entry = byRepository.get(key);
		const links = entry ? supportOf(entry) : [];

		if (links.length === 0) {
			unsupported.push(mod.id);

			continue;
		}

		const owner = `${mod.source}:${ownerName(entry)}`;
		const author = authors.get(owner) ?? { owner: ownerName(entry), host: mod.source, links: [], mods: [] };

		for (const link of links) if (!author.links.some(known => known.url === link.url)) author.links.push(link);
		author.mods.push(entry.repo);
		authors.set(owner, author);
	}

	return { authors: [...authors.values()].sort((a, b) => b.mods.length - a.mods.length), unsupported, elsewhere };
};

export const support = async ({ flags }) => {
	const { manifest, config } = await targetInstance(flags.instance);
	const lock = await instances.readLock(manifest.name);
	const found = authorsOf([...manifest.mods, ...lock.mods], await listing({ index: config.index }));

	if (flags.json) {
		info(JSON.stringify(found));

		return 0;
	}

	if (found.authors.length === 0)
		info(`No author of a mod in ${manifest.name} lists a way to support them that the index knows of.`);
	else info(paint.bold(`Support the authors of ${manifest.name}'s mods`));

	for (const author of found.authors) {
		const mods = author.mods.map(repo => repo.split('/')[1]);
		const named = mods.length > 3 ? `${mods.slice(0, 3).join(', ')} +${mods.length - 3}` : mods.join(', ');

		info(`  ${paint.cyan(author.owner)} ${paint.dim(`(${named})`)}`);

		for (const link of author.links) info(`    ${link.label.padEnd(16)} ${link.url}`);
	}

	if (found.unsupported.length > 0) {
		info(
			paint.dim(`  ${plural(found.unsupported.length, 'mod')} list no way to support their author the index knows of`),
		);
	}

	if (found.elsewhere.length > 0) {
		info(
			paint.dim(
				`  ${plural(found.elsewhere.length, 'mod')} from Modrinth or CurseForge, which pay their authors themselves`,
			),
		);
	}

	return 0;
};

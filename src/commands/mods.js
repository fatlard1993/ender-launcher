import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import * as instances from '../instance';
import { entryKey, reportSync, resolveAll, sources, syncMods } from '../mods';
import { done, fail, info, paint, plural, step, warn } from '../out';
import { parseModSpec, targetInstance } from './context';

const contextFor = (manifest, config, flags = {}) => ({
	minecraft: manifest.minecraft,
	loader: manifest.loader?.type === 'vanilla' ? undefined : manifest.loader?.type,
	key: config.curseforgeKey,
	githubToken: config.githubToken,
	allowPrerelease: flags.pre ?? manifest.prerelease ?? config.prerelease ?? false,
});

export const syncInstance = async (manifest, config, { withDependencies = true, flags = {} } = {}) => {
	const directory = instances.modsDir(manifest);

	await mkdir(directory, { recursive: true });

	const result = await syncMods({
		entries: manifest.mods,
		modsDir: directory,
		lock: await instances.readLock(manifest.name),
		context: contextFor(manifest, config, flags),
		withDependencies,
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

	if (positionals.length === 0) throw new Error('mcm add <mod> [mod...]');

	const existing = new Set(manifest.mods.map(entryKey));
	const added = [];

	for (const spec of positionals) {
		const entry = parseModSpec(spec);

		// A relative path means something different from every other directory, so it is anchored
		// now, the way --game-dir already is, rather than at each sync.
		if (entry.source === 'local') entry.path = resolve(entry.path);

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

	return 0;
};

export const drop = async ({ positionals, flags }) => {
	const { manifest, config } = await targetInstance(flags.instance);

	if (positionals.length === 0) throw new Error('mcm drop <mod> [mod...]');

	const wanted = new Set(
		positionals.map(spec => {
			const entry = parseModSpec(spec);

			if (entry.source === 'local') entry.path = resolve(entry.path);

			return entryKey(entry);
		}),
	);
	// Path and url entries carry no id. Without the filter every one of them matches `undefined`
	// and a single unrelated argument drops the lot.
	const byId = new Set(positionals.map(spec => parseModSpec(spec).id).filter(Boolean));

	const kept = manifest.mods.filter(entry => !wanted.has(entryKey(entry)) && !byId.has(entry.id));
	const dropped = manifest.mods.length - kept.length;

	if (dropped === 0) {
		warn('Nothing matched. "mcm info" lists what is declared.');

		return 1;
	}

	manifest.mods = kept;

	await instances.write(manifest);

	step(`Dropped ${plural(dropped, 'mod')} from ${manifest.name}`);

	await syncInstance(manifest, config, { withDependencies: flags.deps !== false, flags });

	return 0;
};

/** Unpin everything (or the named mods) so the next resolve picks up newer builds. */
export const update = async ({ positionals, flags }) => {
	const { manifest, config } = await targetInstance(flags.instance);

	const targeted = positionals.length > 0 ? new Set(positionals.map(spec => parseModSpec(spec).id)) : undefined;
	let unpinned = 0;

	manifest.mods = manifest.mods.map(entry => {
		if (entry.version === undefined) return entry;
		if (targeted && !targeted.has(entry.id)) return entry;

		++unpinned;

		return { ...entry, version: undefined };
	});

	await instances.write(manifest);

	step(`Updating ${manifest.name}${unpinned > 0 ? ` (${plural(unpinned, 'pin')} released)` : ''}`);

	const before = new Map((await instances.readLock(manifest.name)).mods.map(mod => [mod.key, mod.version]));
	const { lock } = await syncInstance(manifest, config, { withDependencies: flags.deps !== false, flags });

	const changed = lock.mods.filter(mod => before.get(mod.key) !== undefined && before.get(mod.key) !== mod.version);

	for (const mod of changed) info(`  ${mod.name} ${paint.dim(before.get(mod.key))} -> ${paint.green(mod.version)}`);

	done(changed.length === 0 ? 'Everything was already current' : `${plural(changed.length, 'mod')} updated`);

	return 0;
};

export const search = async ({ positionals, flags }) => {
	const query = positionals.join(' ');

	if (query === '') throw new Error('mcm search <query>');

	let minecraft = flags.minecraft;
	let loader = flags.loader;
	let key;
	let githubToken;

	if (flags.instance !== undefined || (minecraft === undefined && flags.any !== true)) {
		try {
			const { manifest, config } = await targetInstance(flags.instance);

			minecraft ??= manifest.minecraft;
			loader ??= manifest.loader?.type === 'vanilla' ? undefined : manifest.loader?.type;
			key = config.curseforgeKey;
			githubToken = config.githubToken;
		} catch {
			// Searching without an instance is fine; it just cannot narrow by version.
		}
	}

	const wanted = flags.source ? [flags.source] : Object.keys(sources);
	let printed = 0;

	for (const name of wanted) {
		const source = sources[name];

		if (source === undefined) throw new Error(`Unknown source "${name}"`);

		// GitHub repository search is too noisy to mix into a mod search unasked.
		if (name === 'github' && !flags.source) continue;

		let hits;

		try {
			hits = await source.search(query, { minecraft, loader, limit: flags.limit, key, githubToken });
		} catch (error) {
			fail(`${source.label}: ${error.message}`);

			continue;
		}

		if (hits.length === 0) continue;

		const scope = `${minecraft ?? 'any version'} / ${loader ?? 'any loader'}`;
		const note = hits[0]?.exact ? ' :: exact slug, there is no keyless search' : '';

		info(`${paint.bold(source.label)} ${paint.dim(scope + note)}`);

		for (const hit of hits) {
			const prefix = { curseforge: 'cf:', github: 'gh:' }[name] ?? '';
			const count = `${hit.downloads.toLocaleString()} ${hit.stars ? 'stars' : 'downloads'}`;

			info(`  ${paint.cyan(prefix + hit.id)} ${paint.dim(count)}`);
			info(`    ${hit.name} ${paint.dim('--')} ${hit.description?.slice(0, 90) ?? ''}`);
		}

		printed += hits.length;
	}

	if (printed === 0) info('Nothing matched.');

	return 0;
};

export { parseModSpec } from './context';

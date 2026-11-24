import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { readConfig } from '../config';
import { checksumText, ensureFile, pool } from '../download';
import { readJson, writeJson } from '../json';
import { fileIndexIssue, modLink } from '../indexIssues';
import * as instances from '../instance';
import { scanJar } from '../mods/capabilities';
import { readMods } from '../mods/metadata';
import { checkShape, explanations, knownBad, listing, providers } from '../mods/catalog';
import { ownerName, supportOf } from '../mods/support';
import {
	entryKey,
	evidence,
	isWanted,
	reportSync,
	resolveAll,
	sources,
	syncMods,
	unplacedMessage,
	unplacedOf,
} from '../mods';
import { done, fail, info, paint, plural, step, warn } from '../out';
import { paths } from '../paths';
import { KINDS, reportAssets, syncAssets } from '../mods/assets';
import { parseModSpec, refineModSpec, specFor, targetInstance } from './context';
import { isRemote, refreshFromPack, sourceOf } from './packSource';

/** The sources that resolve through the index. */
const INDEXED = new Set(['github', 'codeberg', 'gitlab', 'index']);

/** The index's page saying what each finding of a scan means. */
const FINDINGS_PAGE = 'https://fatlard1993.github.io/ender-index/findings';

const contextFor = (manifest, config, flags = {}, { adding = false } = {}) => ({
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
	trustSecrets: flags.trust ?? false,
	side: manifest.type === 'server' ? 'server' : 'client',
	// Read once a sync asks: the jars the index lists as known bad, refused from any source
	knownBad: () => knownBad({ index: config.index }),
	// A player adding mods places what they require by the newest providers.json, as one just published may need a library
	// as new; an update keeps to the copy it has
	adding,
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

export const syncInstance = async (manifest, config, { withDependencies = true, flags = {}, adding = false } = {}) => {
	const directory = instances.modsDir(manifest);

	await mkdir(directory, { recursive: true });

	const lock = await instances.readLock(manifest.name);
	const wanted = isWanted(manifest);
	const result = await syncMods({
		entries: manifest.mods.filter(wanted),
		modsDir: directory,
		lock,
		context: contextFor(manifest, config, flags, { adding }),
		withDependencies,
		modIdCache: join(paths.cache, 'mod-ids.json'),
		scanCache: join(paths.cache, 'scans'),
		clientOnlyCache: join(paths.cache, 'client-only.json'),
	});

	const declaresAssets = KINDS.some(
		kind => (manifest[kind] ?? []).length > 0 || (lock.assets?.[kind] ?? []).length > 0,
	);
	const assets = declaresAssets
		? await syncAssets({
				manifest: {
					...manifest,
					...Object.fromEntries(KINDS.map(kind => [kind, (manifest[kind] ?? []).filter(wanted)])),
				},
				lock,
				context: contextFor(manifest, config, flags),
			})
		: { assets: undefined, installed: [], removed: [], failures: [] };

	await instances.writeLock(manifest.name, {
		...lock,
		...result.lock,
		...(assets.assets ? { assets: assets.assets } : {}),
	});

	reportSync({ ...result, modsDir: directory });
	reportAssets(assets);

	return { ...result, failures: [...result.failures, ...assets.failures] };
};

export const sync = async ({ positionals, flags }) => {
	const { manifest, config } = await targetInstance(flags.instance ?? positionals[0]);

	step(`Syncing mods for ${manifest.name}`);

	const { failures } = await syncInstance(manifest, config, { withDependencies: flags.deps !== false, flags });

	return failures.length > 0 ? 1 : 0;
};

/**
 * The mod ids the jars these resolve to declare, which is what answers a requirement, not what their entries are
 * called: mr:geyser's jar is geyser-fabric. Read from the ids a sync already keeps by checksum, and otherwise from the
 * jar, fetched to a scratch folder and kept by checksum for the sync that follows.
 */
export const providedBy = async (resolutions, cache = join(paths.cache, 'mod-ids.json')) => {
	const known = await readJson(cache, {});
	const keyOf = resolution => checksumText(resolution.file?.checksum);
	const unread = resolutions.filter(
		resolution => (resolution.file?.url || resolution.file?.localPath) && known[keyOf(resolution)] === undefined,
	);
	const read = new Map();

	if (unread.length > 0) {
		step(`Reading ${plural(unread.length, 'jar')} for the mod ids they declare`);

		const scratch = await mkdtemp(join(tmpdir(), 'ender-ids-'));

		try {
			await pool(
				unread,
				async resolution => {
					const path = resolution.file.localPath ?? join(scratch, basename(resolution.file.filename));

					if (!resolution.file.localPath) {
						await ensureFile({ url: resolution.file.url, path, checksum: resolution.file.checksum, size: resolution.file.size });
					}

					const ids = [...new Set((await readMods(path).catch(() => [])).map(mod => mod.id).filter(Boolean))];

					read.set(resolution, ids);
					if (keyOf(resolution) !== undefined) known[keyOf(resolution)] = ids;
				},
				{ concurrency: 6 },
			);
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}

		await writeJson(cache, known);
	}

	return resolutions.flatMap(resolution => read.get(resolution) ?? known[keyOf(resolution)] ?? []);
};

/** A mod the game would refuse to load for want of what it requires is not declared; --no-deps declares it alone. */
export const refuseUnplaced = async (resolutions, declared, flags, command, cache) => {
	if (flags.deps === false) return;

	let missing = unplacedOf(resolutions, declared);

	// Only fetched when the names alone leave something unanswered, which is rare.
	if (missing.length > 0) missing = unplacedOf(resolutions, declared, await providedBy(resolutions, cache));

	if (missing.length === 0) return;

	const instance = flags.instance ? ` --instance ${flags.instance}` : '';

	throw new Error(
		`${unplacedMessage(missing, `${command}${instance}`)}\nNothing was added; --no-deps adds it without what it requires.`,
	);
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
	const resolutions = await resolveAll(added, contextFor(manifest, config, flags), { withDependencies: false });

	await refuseUnplaced(resolutions, [...manifest.mods, ...added], flags, `ender add ${positionals.join(' ')}`);

	manifest.mods.push(...added);

	await instances.write(manifest);

	step(`Added ${plural(added.length, 'mod')} to ${manifest.name}`);

	await syncInstance(manifest, config, { withDependencies: flags.deps !== false, flags, adding: true });

	// The listing only says who the index's own mods are by: one added from elsewhere needs no download for it
	const fromIndex = added.some(entry => INDEXED.has(entry.source));
	const { authors } = authorsOf(added, fromIndex ? await listing({ index: config.index }).catch(() => []) : []);

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
 * Read, while an update's pack is, what placing indexed mods' dependencies needs: providers.json, the largest file an
 * update reads, and the manifest naming the index's data shape. Never the listing, five times larger, which only a
 * search or a mod named by its id alone needs, and which an index without providers.json is read for when it is.
 */
export const readAhead = (manifest, config) => {
	if (!manifest.mods.some(entry => INDEXED.has(entry.source))) return;

	const context = { index: config.index };

	providers(context).catch(() => {});
	checkShape(context).catch(() => {});
};

/**
 * Bring an instance's mods to the newest builds that fit: a pack-made instance first takes its pack's newest word, and
 * the pins released are those set beside the pack, never the pack's own, or `targeted` alone when given.
 */
export const updateInstance = async (manifest, config, { targeted, flags = {} } = {}) => {
	let packChanges = 0;

	readAhead(manifest, config);

	if (manifest.pack) {
		const { added, dropped, moved, files, servers } = await refreshFromPack(manifest, config);

		packChanges =
			added.length +
			dropped.length +
			(moved ? 1 : 0) +
			(files?.written.length ?? 0) +
			(servers ? servers.added.length + servers.removed.length : 0);

		if (moved) info(`  the pack moved to ${paint.green(moved)}`);
		for (const key of added) info(`  ${paint.green('+')} ${key}`);
		for (const key of dropped) info(`  ${paint.red('-')} ${key}`);
		for (const file of files?.written ?? []) info(`  ${paint.green('~')} ${file}`);
		for (const server of servers?.added ?? []) info(`  ${paint.green('+')} server ${server.name} (${server.address})`);
		for (const address of servers?.removed ?? []) info(`  ${paint.red('-')} server ${address}`);

		if (files?.kept.length > 0) {
			info(
				paint.dim(
					`  kept your own ${plural(files.kept.length, 'file')} the pack changed: ${files.kept.join(', ')}; delete one to take the pack's`,
				),
			);
		}
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

/**
 * Update an instance, and its pack, on the way to starting it. An update that fails says what failed and starts the
 * mods already installed: a game or server that will not start because a host is down is worse than one a day behind.
 */
export const updateBeforeStart = async (manifest, config, flags) => {
	const going = manifest.type === 'server' ? 'starting' : 'launching';

	try {
		const result = await updateInstance(manifest, config, { flags });

		if (result.failures.length > 0) {
			warn(`${plural(result.failures.length, 'mod')} did not update; ${going} with what is installed`);
		} else {
			done(updatedLine(result));
		}
	} catch (error) {
		warn(`The update did not run (${error.message}); ${going} with what is installed`);
	}
};

const FOLLOW_USAGE =
	'ender follow <pack> [--instance name] [--keep]: a gist link or gist:id, gh:owner/repo, an https link, or an ender or packwiz pack file';

/**
 * An instance set to follow a pack: its own choices give way to the pack's unless kept. Following the pack it already
 * follows changes nothing, so following again is only an update. Answers the choices that gave way.
 */
export const startFollowing = (manifest, source, { keep = false } = {}) => {
	if (manifest.pack?.source === source) return [];

	const given = keep ? [] : manifest.mods.map(entryKey);

	manifest.pack = { source, mods: [] };
	if (!keep) manifest.mods = [];

	return given;
};

/** Have an instance follow a pack, keeping its game directory and worlds: from here every update reads the pack first. */
export const follow = async ({ positionals, flags }) => {
	const [wanted] = positionals;

	if (wanted === undefined) throw new Error(FOLLOW_USAGE);
	if (!isRemote(wanted) && !(await Bun.file(resolve(wanted)).exists())) throw new Error(`No such pack: ${wanted}`);

	const { manifest, config } = await targetInstance(flags.instance);
	const source = sourceOf(wanted);
	const following = manifest.pack?.source === source;
	const given = startFollowing(manifest, source, { keep: flags.keep });

	if (!following) step(`${manifest.name} follows ${source} now`);

	if (flags.sync === false) {
		await instances.write(manifest);

		if (!following) info(paint.dim('  its next update, or start with --update, fetches what the pack names'));

		return 0;
	}

	const result = await updateInstance(manifest, config, { flags });
	const followed = new Set(manifest.pack.mods);

	for (const key of given.filter(each => !followed.has(each))) {
		info(`  ${paint.red('-')} ${key} ${paint.dim('(chosen here, and not in the pack)')}`);
	}

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

/** The index's key for an installed mod from a repository, under which its author's explanations are kept. */
const repositoryKey = mod => (REPOSITORY_SOURCES.has(mod?.source) ? `${mod.source}:${mod.id}` : undefined);

/**
 * The jars a scan covers, each with the index's key for its mod when it is one installed from a repository: jar files
 * named by path, installed mods named by file, id or key, or else all of mods/.
 */
const scanTargets = async (positionals, flags) => {
	const onDisk = await Promise.all(positionals.map(target => Bun.file(resolve(target)).exists()));

	if (positionals.length > 0 && onDisk.every(Boolean)) return positionals.map(target => ({ path: resolve(target) }));

	const { manifest } = await targetInstance(flags.instance);
	const directory = instances.modsDir(manifest);
	const { mods } = await instances.readLock(manifest.name);
	const byFile = new Map(mods.map(mod => [mod.filename, mod]));

	if (positionals.length === 0) {
		return (await readdir(directory).catch(() => []))
			.filter(file => file.endsWith('.jar'))
			.sort()
			.map(file => ({ path: join(directory, file), key: repositoryKey(byFile.get(file)) }));
	}

	return positionals.map((target, index) => {
		if (onDisk[index]) return { path: resolve(target) };

		const match = mods.find(mod => [mod.filename, mod.id, mod.key].includes(target));

		if (match === undefined) throw new Error(`${target} is neither a jar file nor a mod installed in ${manifest.name}`);

		return { path: join(directory, match.filename), key: repositoryKey(match) };
	});
};

/** An author's explanation under the finding it answers, said to be theirs: the index looked it over, but not into it. */
const authorsWord = note =>
	note &&
	info(
		paint.dim(
			`  ${''.padEnd(12)} its author, ${note.by}${note.release ? `, for ${note.release}` : ''}: ${note.text.replaceAll('\n', ' ')} (their words, not checked)`,
		),
	);

/** What each jar's code can reach: one line per jar for a whole mods/, the evidence for named ones. */
export const scan = async ({ positionals, flags }) => {
	const targets = await scanTargets(positionals, flags);
	const detailed = positionals.length > 0;
	const results = [];
	let failed = 0;
	const explained =
		detailed && targets.some(({ key }) => key)
			? await explanations({ index: (await readConfig()).index }).catch(() => ({}))
			: {};

	if (targets.length > 3) step(`Scanning ${plural(targets.length, 'jar')}`);

	for (const { path, key } of targets) {
		try {
			results.push({ path, findings: await scanJar(path), notes: explained[key] ?? {} });
		} catch (error) {
			fail(`${basename(path)} :: ${error.message}`);

			++failed;
		}
	}

	if (flags.json) {
		info(JSON.stringify(Object.fromEntries(results.map(({ path, findings }) => [path, findings])), undefined, '\t'));

		return failed > 0 ? 1 : 0;
	}

	for (const { path, findings, notes } of results) {
		const reach = Object.keys(findings.capabilities);
		const hosts = Object.keys(findings.hosts);

		const warnings = [...Object.keys(findings.signals), ...(findings.hidden.length > 0 ? ['hidden'] : [])];
		const secrets = Object.keys(findings.secrets);

		info(
			[
				paint.bold(basename(path)),
				reach.length > 0 ? reach.join(' ') : paint.dim('reaches none of exec, classloading, native, network, unsafe'),
				warnings.length > 0 && `warns of ${warnings.join(' ')}`,
				secrets.length > 0 && paint.bold(`names where other programs keep logins: ${secrets.join(' ')}`),
			]
				.filter(Boolean)
				.join(' '),
		);

		if (!detailed) continue;

		for (const [capability, classes] of Object.entries(findings.capabilities)) {
			info(`  ${capability.padEnd(12)} ${evidence(classes)}`);
			authorsWord(notes[capability]);
		}
		for (const [signal, classes] of Object.entries(findings.signals)) {
			info(`  ${signal.padEnd(12)} ${evidence(classes)}`);
			authorsWord(notes[signal]);
		}
		for (const [store, classes] of Object.entries(findings.secrets))
			info(`  ${paint.bold(`secrets:${store}`.padEnd(12))} ${evidence(classes)}`);
		if (Object.keys(findings.secrets).length > 0) authorsWord(notes.secrets);
		if (findings.hidden.length > 0) {
			info(`  ${'hidden'.padEnd(12)} ${findings.hidden.join(' ')}`);
			authorsWord(notes.hidden);
		}
		if (hosts.length > 0) {
			info(`  ${'hosts'.padEnd(12)} ${hosts.join(' ')}`);
			authorsWord(notes.hosts);
		}
		if (findings.unreadable.length > 0) info(`  ${'unreadable'.padEnd(12)} ${findings.unreadable.join(' ')}`);

		info(
			paint.dim(
				`  ${plural(findings.classes, 'class', 'es')}, ${plural(findings.jars.length, 'nested jar')}, scanner version ${findings.version}`,
			),
		);
	}

	if (detailed && results.length > 0) info(paint.dim(`What each finding means: ${FINDINGS_PAGE}`));

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

/**
 * Ask the index to list a mod now, rather than when its discovery finds it, as the GitHub account ender signs in with:
 * the index crawls it within minutes and answers on the issue.
 */
export const submit = async ({ positionals, flags }, { file = fileIndexIssue } = {}) => {
	const [named] = positionals;
	const link = named && modLink(named);

	if (!link) {
		fail(
			named
				? `${named} is not a repository the index can list: name it gh:owner/repo, cb:owner/repo, gl:group/project, or by its link`
				: 'ender submit <gh:owner/repo | link>',
		);

		return 2;
	}

	const filed = await file('mod', link);

	if (flags.json) {
		info(JSON.stringify(filed));

		return 0;
	}

	done(
		filed.before
			? `Asked the index to list ${link} before: ${filed.url}`
			: `Asked the index to list ${link}: ${filed.url}. It is crawled within a few minutes, and the issue says it is listed or why not`,
	);

	return 0;
};

/** Each optional entry an instance declares, mods and packs alike, with whether it is on. */
export const offeredIn = manifest => {
	const chosen = new Set(manifest.chosen ?? []);

	return ['mods', 'resourcepacks', 'shaderpacks'].flatMap(kind =>
		(manifest[kind] ?? [])
			.filter(entry => entry.optional)
			.map(entry => ({ kind, key: entryKey(entry), description: entry.description, on: chosen.has(entryKey(entry)) })),
	);
};

/**
 * The optional entries a pack offers, listed, or turned on or off by name: by their key, or by the id or slug alone.
 * A change is installed or removed at the next sync, which this runs.
 */
export const optional = async ({ positionals, flags }) => {
	const { manifest, config } = await targetInstance(flags.instance);
	const [action, ...names] = positionals;
	const offered = offeredIn(manifest);

	if (action === undefined) {
		if (flags.json) {
			console.log(JSON.stringify(offered, null, 2));

			return 0;
		}

		if (offered.length === 0) {
			info(`${manifest.name} has nothing optional`);

			return 0;
		}

		for (const item of offered) {
			info(
				`${item.on ? paint.green('on ') : paint.dim('off')} ${item.key}${item.kind === 'mods' ? '' : paint.dim(` (${item.kind})`)}${item.description ? paint.dim(`  ${item.description}`) : ''}`,
			);
		}

		return 0;
	}

	if (!['on', 'off'].includes(action) || names.length === 0) throw new Error('ender optional [on|off <mod> [mod...]]');

	const matched = names.map(name => {
		const found = offered.filter(item => item.key === name || item.key.split(':').slice(1).join(':') === name);

		if (found.length !== 1) {
			throw new Error(
				found.length === 0
					? `${name} is not optional in ${manifest.name}; "ender optional" lists what is`
					: `${name} names more than one optional entry: ${found.map(item => item.key).join(', ')}`,
			);
		}

		return found[0].key;
	});
	const chosen = new Set(manifest.chosen ?? []);

	for (const key of matched) {
		if (action === 'on') chosen.add(key);
		else chosen.delete(key);
	}

	manifest.chosen = [...chosen];
	await instances.write(manifest);
	done(`${action === 'on' ? 'Turned on' : 'Turned off'} ${matched.join(', ')} in ${manifest.name}`);

	const { failures } = await syncInstance(manifest, config, { flags });

	return failures.length > 0 ? 1 : 0;
};

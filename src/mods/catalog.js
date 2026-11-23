import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { fetchWithRetry } from '../download';
import { readJson, writeJson, writeText } from '../json';
import { warn } from '../out';
import { paths } from '../paths';

export { ESTABLISHED, claimantsOf, fit, fromProviders, loaderFits, providerOf, requiredIds } from './rank';

/** The published ender-index. `ender config index` points elsewhere: another URL, or a local checkout's data directory. */
export const DEFAULT_INDEX = 'https://raw.githubusercontent.com/fatlard1993/ender-index/data';

const loaded = new Map();

/** Index files are read once per process; this forgets them, as a new process would. */
export const forgetLoaded = () => {
	loaded.clear();
	warnedShapes.clear();
	bases.clear();
	unplacedSeen = undefined;
};

const copyOf = url => join(paths.cache, 'index', `${new Bun.CryptoHasher('sha1').update(url).digest('hex')}.json`);

const tagOf = url => copyOf(url).replace(/\.json$/, '.tag.json');

/**
 * What the kept copy of an index file was fetched as, read without the copy itself: the listing runs to tens of
 * megabytes, and a changed one is never read back. A copy kept before tags were is read whole for it.
 */
const keptTag = async url => {
	const tag = await readJson(tagOf(url), {});

	if (tag.etag !== undefined && (await Bun.file(copyOf(url)).exists()))
		return { ...tag, body: async () => (await readJson(copyOf(url), {})).body };

	const kept = await readJson(copyOf(url), {});

	return { etag: kept.etag, fetched: kept.fetched, body: async () => kept.body };
};

/**
 * Keep a fetched index file as it came, with `asOf`, the time by the index's change file it is known current at. The
 * tag goes first and returns last, so it never names a copy it is not.
 */
const keep = async (url, etag, text, asOf) => {
	const fetched = new Date().toISOString();

	await unlink(tagOf(url)).catch(() => {});
	await writeText(copyOf(url), `{"etag":${JSON.stringify(etag)},"fetched":"${fetched}","body":${text}}\n`);
	await writeJson(tagOf(url), { etag, fetched, ...(asOf ? { asOf } : {}) });
};

/** A file the index no longer has: its kept copy is not kept. */
const forget = async url => {
	await unlink(tagOf(url)).catch(() => {});
	await unlink(copyOf(url)).catch(() => {});
};

/**
 * Fetch an index file, keeping a copy to ask about with If-None-Match, so an unchanged index costs
 * one small answer rather than the whole file. Unreachable, the copy is used and that is said.
 */
const fetchKept = async (url, { within = 0, now = Date.now(), current, asOf } = {}) => {
	const kept = await keptTag(url);

	// A copy the index's change file says is as the index has it now is taken without asking
	if (current !== undefined && kept.etag !== undefined && current(kept)) {
		const body = await kept.body();

		if (body !== undefined) return body;
	}

	// A copy fetched within the window is taken as it is, asking nothing: the listing a dependency is placed by
	// changes every crawl, but which repository provides a mod id hardly ever does
	if (within > 0 && kept.etag !== undefined && now - Date.parse(kept.fetched) < within) {
		const body = await kept.body();

		if (body !== undefined) return body;
	}

	try {
		const response = await fetchWithRetry(url, kept.etag ? { headers: { 'if-none-match': kept.etag } } : {});
		const text = await response.text();
		const body = JSON.parse(text);
		const etag = response.headers.get('etag');

		if (etag) await keep(url, etag, text, asOf);

		return body;
	} catch (error) {
		if (error.status === 404) {
			await forget(url);

			return undefined;
		}

		const body = await kept.body();

		if (error.status === 304 && body !== undefined) {
			if (asOf) await writeJson(tagOf(url), { etag: kept.etag, fetched: kept.fetched, asOf });

			return body;
		}

		const transient = error.status === undefined || error.status === 429 || error.status >= 500;

		if (!transient || body === undefined) throw error;

		warn(`The index could not be reached (${error.message}); using the copy from ${kept.fetched}`);

		return body;
	}
};

/** Where each published index last said its data is served, for a run that cannot read its manifest at all. */
const movedPath = () => join(paths.cache, 'index', 'moved.json');

/** The address a manifest names in `data`, without a trailing slash, when it is one ender follows: https only. */
const servedAt = manifest => {
	if (typeof manifest?.data !== 'string') return undefined;

	try {
		return new URL(manifest.data).protocol === 'https:' ? manifest.data.replace(/\/+$/, '') : undefined;
	} catch {
		return undefined;
	}
};

const bases = new Map();

/**
 * Where the index's data is read from. An address the player set with `ender config index` is read as it is.
 * Otherwise the manifest at the address ender was built with is asked each run, and the address it names in `data` is
 * where everything else is read, so the data can move, and move back, with no release. That address is remembered for
 * a run that cannot read the manifest at all, as when the repository serving it is gone.
 */
export const indexBase = async context => {
	if (context?.index !== undefined) return context.index;

	// The address ender was built with; a test stands in its own
	const published = context?.published ?? DEFAULT_INDEX;

	if (!bases.has(published)) {
		bases.set(
			published,
			(async () => {
				const remembered = await readJson(movedPath(), {});
				const manifest = await load(published, 'index.json').catch(() => undefined);

				if (manifest === undefined) return remembered[published] ?? published;

				const moved = servedAt(manifest);

				if (moved !== remembered[published]) {
					const kept = { ...remembered };

					if (moved) kept[published] = moved;
					else delete kept[published];

					await writeJson(movedPath(), kept);
				}

				return moved ?? published;
			})(),
		);
	}

	return bases.get(published);
};

const load = (base, path, { within = 0, current, asOf } = {}) => {
	const key = `${base}/${path}`;
	const held = loaded.get(key);

	// Fetched once a run; a run that took a kept copy and then wants a newer one asks again
	if (!held || held.within > within) {
		loaded.set(key, {
			within,
			body: (async () => {
				if (/^https?:\/\//.test(base)) return fetchKept(key, { within, current, asOf });

				const file = Bun.file(join(base, path));

				return (await file.exists()) ? file.json() : undefined;
			})(),
		});
	}

	return loaded.get(key).body;
};

/** How old a kept listing may be when it only places dependencies: a day, as the crawl rewrites it every hour. */
export const LISTING_KEPT = 24 * 60 * 60 * 1000;

/** The version of the index's data shape this ender reads: data/index.json says which one an index publishes. */
export const KNOWN_SCHEMA = 1;

const warnedShapes = new Set();

/**
 * Whether the index publishes a shape this ender knows. A newer one is said once, and read anyway: the index adds fields
 * without raising it, so a raise means something ender relies on may have changed. An index from before it named a
 * version, or one that cannot say, is read as it is.
 */
export const checkShape = async context => {
	const base = await indexBase(context);
	const schema = (await load(base, 'index.json').catch(() => undefined))?.schema;

	if (!Number.isInteger(schema) || schema <= KNOWN_SCHEMA || warnedShapes.has(base)) return schema;

	warnedShapes.add(base);
	warn(
		`The mod index at ${base} publishes data shape ${schema}, and this ender reads shape ${KNOWN_SCHEMA}: some of what it shows or installs may be wrong until ender is upgraded (ender upgrade)`,
	);

	return schema;
};

/**
 * How old a kept providers.json may be when it places a dependency: a week, as which repository provides a mod id
 * hardly ever changes. An id a kept copy cannot place is asked of one a day old at most, as a claimant may have been
 * listed or released for the instance's version since; never of the newest, as many required ids cannot be placed at
 * all, and each run would fetch it.
 */
export const PROVIDERS_KEPT = 7 * 24 * 60 * 60 * 1000;

/**
 * Each mod id's claimants, as the index works them out for placing dependencies, from a copy up to `within` old;
 * undefined from an index that publishes none, which the listing then answers for.
 */
/**
 * Mod ids a providers.json a day old at most could not place, by the index and the loader and game version they were
 * wanted for, with when: one is not asked about again until a week on, as the table itself is not, or an instance with
 * a requirement nothing can place would fetch the table every day.
 */
const unplacedPath = () => join(paths.cache, 'index', 'unplaced.json');

let unplacedSeen;

const readUnplaced = async () => {
	unplacedSeen ??= readJson(unplacedPath(), {});

	return unplacedSeen;
};

const unplacedKey = (modId, { loader, minecraft }) => `${modId}@${loader ?? '*'}/${minecraft ?? '*'}`;

export const knownUnplaced = async (modId, context, now = Date.now()) => {
	const at = (await readUnplaced())[await indexBase(context)]?.[unplacedKey(modId, context)];

	return at !== undefined && now - Date.parse(at) < PROVIDERS_KEPT;
};

export const rememberUnplaced = async (modId, context, now = Date.now()) => {
	const all = await readUnplaced();
	const base = await indexBase(context);
	const kept = Object.fromEntries(
		Object.entries(all[base] ?? {}).filter(([, at]) => now - Date.parse(at) < PROVIDERS_KEPT),
	);

	all[base] = { ...kept, [unplacedKey(modId, context)]: new Date(now).toISOString() };
	await writeJson(unplacedPath(), all);
};

export const providers = async (context, { within = PROVIDERS_KEPT } = {}) =>
	load(await indexBase(context), 'providers.json', { within }).catch(() => undefined);

/**
 * The index's listing. By default a kept copy up to LISTING_KEPT old is used as it is, which is all placing a mod's
 * dependencies needs; `fresh` asks for the newest, as a search or a mod named by its id alone wants new mods.
 */
export const listing = async (context, { fresh = false } = {}) => {
	const base = await indexBase(context);
	const [entries] = await Promise.all([
		load(base, 'search.json', { within: fresh ? 0 : LISTING_KEPT }),
		checkShape(context),
	]);

	if (entries === undefined) throw new Error(`No mod index at ${base}`);

	return entries;
};

/**
 * The jars the index lists as confirmed to do harm, by sha256 with the reason: what ender refuses to install from any
 * source. None when the index cannot be read for it, as an index from before it published one could not say.
 */
export const knownBad = async context => {
	const listed = await load(await indexBase(context), 'known-bad.json').catch(() => undefined);

	return new Map(
		(Array.isArray(listed) ? listed : []).map(entry => [String(entry.sha256).toLowerCase(), entry.reason]),
	);
};

/** The explanations mods' authors gave of their findings, by the index's key for each mod and then by finding. */
export const explanations = async context => (await load(await indexBase(context), 'explanations.json')) ?? {};

/** Where a host's records live in the index; a dotted directory cannot collide with a GitHub owner. */
const DIRECTORIES = { github: '', codeberg: 'codeberg.org/', gitlab: 'gitlab.com/' };

/**
 * How much earlier than the change file's own time a record read beside it is taken as current: raw.githubusercontent.com
 * serves a file up to five minutes old, so a record read just after a change may be the copy before it, and is asked
 * for once more.
 */
const SERVED_STALE = 10 * 60 * 1000;

const readable = time => typeof time === 'string' && !Number.isNaN(Date.parse(time));

/** The index's change file, read once a run; undefined from an index without one, or with one this ender cannot read. */
const changeList = async base => {
	const list = await load(base, 'changes.json').catch(() => undefined);

	return readable(list?.since) && readable(list?.generated) && list.records && typeof list.records === 'object'
		? list
		: undefined;
};

/**
 * A repository's record. From an index publishing changes.json, a kept copy is asked for only when the file lists the
 * record as changed after the copy was known current, or the copy is older than the file reaches back; otherwise each
 * is asked whether it changed, as before.
 */
export const record = async (fullName, context, host = 'github') => {
	const base = await indexBase(context);
	const path = `mods/${DIRECTORIES[host]}${fullName}.json`;
	const list = /^https?:\/\//.test(base) ? await changeList(base) : undefined;

	if (list === undefined) return load(base, path);

	const changed = list.records[path];
	const current = ({ asOf }) =>
		readable(asOf) &&
		Date.parse(asOf) >= Date.parse(list.since) &&
		!(readable(changed) && Date.parse(changed) > Date.parse(asOf));

	return load(base, path, { current, asOf: new Date(Date.parse(list.generated) - SERVED_STALE).toISOString() });
};

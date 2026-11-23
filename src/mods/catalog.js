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

/** Keep a fetched index file as it came. The tag goes first and returns last, so it never names a copy it is not. */
const keep = async (url, etag, text) => {
	const fetched = new Date().toISOString();

	await unlink(tagOf(url)).catch(() => {});
	await writeText(copyOf(url), `{"etag":${JSON.stringify(etag)},"fetched":"${fetched}","body":${text}}\n`);
	await writeJson(tagOf(url), { etag, fetched });
};

/**
 * Fetch an index file, keeping a copy to ask about with If-None-Match, so an unchanged index costs
 * one small answer rather than the whole file. Unreachable, the copy is used and that is said.
 */
const fetchKept = async (url, { within = 0, now = Date.now() } = {}) => {
	const kept = await keptTag(url);

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

		if (etag) await keep(url, etag, text);

		return body;
	} catch (error) {
		const body = error.status === 404 ? undefined : await kept.body();

		if (error.status === 304 && body !== undefined) return body;
		if (error.status === 404) return undefined;
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

const load = (base, path, { within = 0 } = {}) => {
	const key = `${base}/${path}`;
	const held = loaded.get(key);

	// Fetched once a run; a run that took a kept copy and then wants the newest asks again
	if (!held || (within === 0 && held.within > 0)) {
		loaded.set(key, {
			within,
			body: (async () => {
				if (/^https?:\/\//.test(base)) return fetchKept(key, { within });

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
 * Each mod id's claimants, as the index works them out for placing dependencies, kept like the listing for up to a
 * day; undefined from an index that publishes none, which the listing then answers for.
 */
export const providers = async context =>
	load(await indexBase(context), 'providers.json', { within: LISTING_KEPT }).catch(() => undefined);

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

export const record = async (fullName, context, host = 'github') =>
	load(await indexBase(context), `mods/${DIRECTORIES[host]}${fullName}.json`);

import { join } from 'node:path';

import { fetchWithRetry } from '../download';
import { readJson, writeJson } from '../json';
import { warn } from '../out';
import { paths } from '../paths';
import { ESTABLISHED } from './rank';

export { ESTABLISHED, fit, loaderFits } from './rank';

/** The published ender-index. `ender config index` points elsewhere: another URL, or a local checkout's data directory. */
export const DEFAULT_INDEX = 'https://raw.githubusercontent.com/fatlard1993/ender-index/main/data';

/** What every mod runs on rather than a mod anyone installs. */
const PLATFORM = new Set([
	'minecraft',
	'java',
	'fabricloader',
	'fabric-loader',
	'quilt_loader',
	'forge',
	'neoforge',
	'javafml',
]);

const loaded = new Map();

/** Index files are read once per process; this forgets them, as a new process would. */
export const forgetLoaded = () => loaded.clear();

const copyOf = url => join(paths.cache, 'index', `${new Bun.CryptoHasher('sha1').update(url).digest('hex')}.json`);

/**
 * Fetch an index file, keeping a copy to ask about with If-None-Match, so an unchanged index costs
 * one small answer rather than the whole file. Unreachable, the copy is used and that is said.
 */
const fetchKept = async url => {
	const kept = await readJson(copyOf(url), {});

	try {
		const response = await fetchWithRetry(url, kept.etag ? { headers: { 'if-none-match': kept.etag } } : {});
		const body = await response.json();
		const etag = response.headers.get('etag');

		if (etag) await writeJson(copyOf(url), { etag, fetched: new Date().toISOString(), body });

		return body;
	} catch (error) {
		if (error.status === 304 && kept.body !== undefined) return kept.body;
		if (error.status === 404) return undefined;
		const transient = error.status === undefined || error.status === 429 || error.status >= 500;

		if (!transient || kept.body === undefined) throw error;

		warn(`The index could not be reached (${error.message}); using the copy from ${kept.fetched}`);

		return kept.body;
	}
};

export const indexBase = context => context?.index ?? DEFAULT_INDEX;

const load = (base, path) => {
	const key = `${base}/${path}`;

	if (!loaded.has(key)) {
		loaded.set(
			key,
			(async () => {
				if (/^https?:\/\//.test(base)) return fetchKept(key);

				const file = Bun.file(join(base, path));

				return (await file.exists()) ? file.json() : undefined;
			})(),
		);
	}

	return loaded.get(key);
};

export const listing = async context => {
	const entries = await load(indexBase(context), 'search.json');

	if (entries === undefined) throw new Error(`No mod index at ${indexBase(context)}`);

	return entries;
};

/** Where a host's records live in the index; a dotted directory cannot collide with a GitHub owner. */
const DIRECTORIES = { github: '', codeberg: 'codeberg.org/', gitlab: 'gitlab.com/' };

export const record = (fullName, context, host = 'github') =>
	load(indexBase(context), `mods/${DIRECTORIES[host]}${fullName}.json`);

/** Quilt loads Fabric mods as its own. */
/**
 * Every index entry claiming a mod id, most likely first: those whose own mod has the id, by stars,
 * then those that provide it, by how much they provide. A library is often bundled inside the mods
 * that use it, so the release providing the most is the library's own rather than a partial copy.
 */
export const claimantsOf = (id, entries) => {
	const byStars = (a, b) => (b.stars ?? 0) - (a.stars ?? 0);
	const own = entries.filter(entry => entry.latest?.mods.some(mod => mod.id === id)).sort(byStars);
	const providers = entries
		.filter(entry => !own.includes(entry) && entry.latest?.provides?.includes(id))
		.sort((a, b) => b.latest.provides.length - a.latest.provides.length || byStars(a, b));

	return [...own, ...providers];
};

const ownerOf = ({ host, repo }) => `${host ?? 'github'}:${repo.split('/')[0].toLowerCase()}`;

/**
 * The entry a mod id can be trusted to name: the likeliest claimant that is established, or that shares
 * an owner with the repository requiring it. Any jar can declare any mod id, so a claim alone would
 * let a new repository answer for a mod the index does not have.
 */
export const providerOf = (id, entries, requiring) =>
	claimantsOf(id, entries).find(
		entry => (entry.stars ?? 0) >= ESTABLISHED || (requiring !== undefined && ownerOf(entry) === ownerOf(requiring)),
	);

/** The ids a jar's mods require from elsewhere: not the platform, and not what the jar already carries. */
export const requiredIds = mods => {
	const carried = new Set(mods.flatMap(mod => [mod.id, ...(mod.provides ?? [])]));

	return [...new Set(mods.flatMap(mod => mod.depends ?? []))].filter(id => !PLATFORM.has(id) && !carried.has(id));
};

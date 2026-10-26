import { join } from 'node:path';

import { fetchWithRetry } from '../download';
import { readJson, writeJson } from '../json';
import { warn } from '../out';
import { paths } from '../paths';

export { ESTABLISHED, claimantsOf, fit, loaderFits, providerOf, requiredIds } from './rank';

/** The published ender-index. `ender config index` points elsewhere: another URL, or a local checkout's data directory. */
export const DEFAULT_INDEX = 'https://raw.githubusercontent.com/fatlard1993/ender-index/main/data';

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

import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { fetchWithRetry } from '../download';
import { readJson, writeJson, writeText } from '../json';
import { warn } from '../out';
import { paths } from '../paths';

export { ESTABLISHED, claimantsOf, fit, loaderFits, providerOf, requiredIds } from './rank';

/** The published ender-index. `ender config index` points elsewhere: another URL, or a local checkout's data directory. */
export const DEFAULT_INDEX = 'https://raw.githubusercontent.com/fatlard1993/ender-index/main/data';

const loaded = new Map();

/** Index files are read once per process; this forgets them, as a new process would. */
export const forgetLoaded = () => loaded.clear();

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
const fetchKept = async url => {
	const kept = await keptTag(url);

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

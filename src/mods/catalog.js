import { join } from 'node:path';

import { fetchJson } from '../download';
import { satisfies } from './range';

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

export const indexBase = context => context?.index ?? DEFAULT_INDEX;

const load = (base, path) => {
	const key = `${base}/${path}`;

	if (!loaded.has(key)) {
		loaded.set(
			key,
			(async () => {
				if (/^https?:\/\//.test(base)) {
					try {
						return await fetchJson(key);
					} catch (error) {
						if (error.status === 404) return undefined;

						throw error;
					}
				}

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

export const record = (fullName, context) => load(indexBase(context), `mods/${fullName}.json`);

/** Quilt loads Fabric mods as its own. */
export const loaderFits = (declared, loader) =>
	!loader || declared === loader || (loader === 'quilt' && declared === 'fabric');

/** 2 when a mod declares the instance's loader and game version, 1 when its range cannot be read, 0 when it does not fit. */
export const fit = (mods, { minecraft, loader } = {}) =>
	Math.max(
		0,
		...(mods ?? []).map(mod => {
			if (!loaderFits(mod.loader, loader)) return 0;
			if (minecraft === undefined) return 2;

			return { true: 2, undefined: 1, false: 0 }[satisfies(minecraft, mod.minecraft)];
		}),
	);

/**
 * The repository that satisfies a dependency on a mod id: one whose own mod has that id, or else one
 * that provides it. A library is often bundled inside the mods that use it, so among providers the
 * one providing the most is taken, which is the library's own release rather than a mod carrying a
 * copy of part of it.
 */
export const providerOf = (id, entries) => {
	const byStars = (a, b) => (b.stars ?? 0) - (a.stars ?? 0);
	const own = entries.filter(entry => entry.latest?.mods.some(mod => mod.id === id)).sort(byStars);

	if (own.length > 0) return own[0].repo;

	const providers = entries
		.filter(entry => entry.latest?.provides?.includes(id))
		.sort((a, b) => b.latest.provides.length - a.latest.provides.length || byStars(a, b));

	return providers[0]?.repo;
};

/** The ids a jar's mods require from elsewhere: not the platform, and not what the jar already carries. */
export const requiredIds = mods => {
	const carried = new Set(mods.flatMap(mod => [mod.id, ...(mod.provides ?? [])]));

	return [...new Set(mods.flatMap(mod => mod.depends ?? []))].filter(id => !PLATFORM.has(id) && !carried.has(id));
};

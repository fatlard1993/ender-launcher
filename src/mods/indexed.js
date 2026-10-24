import { checksumOf } from '../download';
import { detail, warn } from '../out';
import * as catalog from './catalog';
import { chooseAsset, pickBuild } from './pick';

export const id = 'index';

export const label = 'Index';

/** The hosts the index crawls, each a mod source of the same name. */
export const HOSTS = { github: 'GitHub', codeberg: 'Codeberg', gitlab: 'GitLab' };

const live = asset => asset.error === undefined && asset.gone === undefined;

/** The repositories a jar's required mods come from, by the index, on whichever host; what it cannot place is said, not dropped. */
const dependenciesOf = async (entry, mods, context) => {
	const required = catalog.requiredIds(mods);

	if (required.length === 0) return [];

	const entries = await catalog.listing(context);
	const found = new Map();

	for (const modId of required) {
		const provider = catalog.providerOf(modId, entries);

		if (provider === undefined) {
			warn(`${entry.source}:${entry.id} requires "${modId}", which the index does not know; declare it yourself`);
		} else {
			const host = provider.host ?? 'github';

			if (host !== entry.source || provider.repo !== entry.id) {
				found.set(`${host}:${provider.repo}`, { source: host, id: provider.repo });
			}
		}
	}

	return [...found.values()];
};

/**
 * Pick a build from the index's record of a repository: the release whose jar declares the instance's
 * loader and game version, read from the jar itself rather than guessed from its name. Undefined when
 * the record has nothing that fits, so the caller decides what that means.
 */
export const resolveFromRecord = async (record, entry, context) => {
	const { minecraft, loader, allowPrerelease } = context;
	const pattern = entry.asset && new RegExp(entry.asset, 'i');
	const candidates = record.releases
		.filter(release => entry.version === undefined || release.tag === entry.version)
		.map(release => {
			const assets = release.assets.filter(asset => live(asset) && (!pattern || pattern.test(asset.name)));
			const best = Math.max(0, ...assets.map(asset => catalog.fit(asset.mods, { minecraft, loader })));

			return {
				...release,
				best,
				fitting: assets.filter(asset => best > 0 && catalog.fit(asset.mods, { minecraft, loader }) === best),
				channel: release.prerelease ? 'beta' : 'release',
				published: Date.parse(release.published),
			};
		})
		.filter(release => release.fitting.length > 0);

	if (candidates.length === 0) return undefined;

	const strongest = Math.max(...candidates.map(release => release.best));
	const release = pickBuild(
		candidates.filter(candidate => candidate.best === strongest),
		{ allowPrerelease },
	);
	const asset = chooseAsset(release.fitting, { minecraft, loader });

	if (asset.knownBad)
		throw new Error(
			`${entry.source}:${entry.id} ${release.tag} ${asset.name} is listed as known bad: ${asset.knownBad}`,
		);

	for (const replaced of asset.replaced ?? []) {
		warn(
			`${entry.source}:${entry.id} ${release.tag} ${asset.name} was replaced after it was published; the earlier jar was seen until ${replaced.until}`,
		);
	}

	detail(entry.source, `${entry.id} ${release.tag} -> ${asset.name} (from the index)`);

	return {
		source: entry.source,
		id: entry.id,
		name: `${entry.id} ${release.tag}`,
		version: release.tag,
		file: { filename: asset.name, url: asset.url, checksum: checksumOf(`sha256:${asset.sha256}`), size: asset.size },
		dependencies: await dependenciesOf(
			entry,
			(asset.mods ?? []).filter(mod => catalog.loaderFits(mod.loader, loader)),
			context,
		),
	};
};

const words = text => (text ?? '').toLowerCase();

/** How well an index entry answers a query: every word must appear somewhere, and an id or name outranks a description. */
const relevance = (entry, terms) => {
	const ids = [entry.repo, ...(entry.latest?.mods ?? []).map(mod => mod.id)].map(words);
	const names = (entry.latest?.mods ?? []).map(mod => words(mod.name));
	const description = words(entry.description);
	let score = 0;

	for (const term of terms) {
		if (ids.some(candidate => candidate === term || candidate.endsWith(`/${term}`))) score += 100;
		else if (ids.some(candidate => candidate.includes(term)) || names.some(name => name.includes(term))) score += 10;
		else if (description.includes(term)) score += 1;
		else return 0;
	}

	return score;
};

/** Search the index: repositories whose own jars declare a loader and game version the instance can use. */
export const search = async (query, { minecraft, loader, limit = 10, index } = {}) => {
	const terms = words(query).split(/\s+/).filter(Boolean);
	const entries = await catalog.listing({ index });

	return entries
		.filter(entry => !entry.archived)
		.filter(entry => catalog.fit(entry.targets, { minecraft, loader }) > 0)
		.map(entry => ({ entry, score: relevance(entry, terms) }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || (b.entry.stars ?? 0) - (a.entry.stars ?? 0))
		.slice(0, limit)
		.map(({ entry }) => ({
			source: entry.host ?? 'github',
			id: entry.repo,
			name: [...new Set(entry.latest.mods.map(mod => mod.name ?? mod.id))].join(', ') || entry.repo,
			description: entry.description,
			downloads: entry.stars ?? 0,
			stars: true,
			note: [
				[...new Set(entry.latest.mods.map(mod => mod.loader))].join('/'),
				entry.latest.capabilities.length > 0 ? `reaches ${entry.latest.capabilities.join(', ')}` : '',
				entry.replaced ? 'a release was changed after publishing' : '',
			]
				.filter(Boolean)
				.join(' · '),
		}));
};

/**
 * A source for a host the index crawls but ender has no API for: it resolves from the index record
 * or not at all, and says which.
 */
export const hosted = host => ({
	id: host,
	label: HOSTS[host],
	resolve: async (entry, context = {}) => {
		const record = await catalog.record(entry.id, context, host);

		if (record === undefined) {
			throw new Error(`${host}:${entry.id} is not in the index; add "${host}:${entry.id}" to ender-index's repos.txt`);
		}

		const resolved = await resolveFromRecord(record, entry, context);

		if (resolved === undefined) {
			throw new Error(
				`${host}:${entry.id} has no release in the index for Minecraft ${context.minecraft ?? 'any version'} on ${context.loader ?? 'any loader'}`,
			);
		}

		return resolved;
	},
});

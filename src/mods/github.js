import { checksumOf, fetchJson } from '../download';
import { detail, warn } from '../out';
import * as catalog from './catalog';
import { pickBuild } from './pick';

const API = 'https://api.github.com';

/** Gradle publishes these beside the real artifact; none of them is a mod. */
const NOT_A_MOD = /-(sources|javadoc|dev|api|slim|shadow)\.jar$/i;

export const id = 'github';

export const label = 'GitHub';

let cachedToken;

/**
 * Unauthenticated GitHub allows sixty requests an hour, which a sync can exhaust. A configured
 * token is used when there is one, and otherwise the `gh` CLI is asked for its own.
 */
const token = async configured => {
	if (configured) return configured;
	if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
	if (cachedToken !== undefined) return cachedToken || undefined;

	try {
		const process_ = Bun.spawn(['gh', 'auth', 'token'], { stdout: 'pipe', stderr: 'ignore' });
		const output = (await new Response(process_.stdout).text()).trim();

		cachedToken = (await process_.exited) === 0 ? output : '';
	} catch {
		cachedToken = '';
	}

	return cachedToken || undefined;
};

const request = async (path, configuredToken) => {
	const authorization = await token(configuredToken);

	return fetchJson(`${API}${path}`, {
		headers: {
			accept: 'application/vnd.github+json',
			...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
		},
	});
};

export const parseRepository = reference => {
	const [owner, repository] = reference.split('/');

	if (!owner || !repository) throw new Error(`A GitHub mod is written owner/repo, not "${reference}"`);

	return { owner, repository };
};

/**
 * Pick the jar a release actually ships. A release carrying several is usually one artifact plus
 * its sources and javadoc, so those go first; what remains is preferred by game version, then by
 * the shortest name, which is the plain artifact rather than a variant of it.
 */
export const chooseAsset = (assets, { minecraft, loader, pattern } = {}) => {
	let candidates = assets.filter(asset => asset.name.endsWith('.jar') && !NOT_A_MOD.test(asset.name));

	if (candidates.length === 0) return undefined;

	if (pattern) {
		const matcher = new RegExp(pattern, 'i');

		candidates = candidates.filter(asset => matcher.test(asset.name));

		if (candidates.length === 0) return undefined;
	}

	// A multiloader release ships fabric and forge jars side by side under equal-length names, and
	// a sort alone would hand back whichever the listing happened to put first.
	const narrow = (list, term) => {
		const matched = term ? list.filter(asset => asset.name.toLowerCase().includes(term.toLowerCase())) : [];

		return matched.length > 0 ? matched : list;
	};

	const pool = narrow(narrow(candidates, loader), minecraft);

	return [...pool].sort((a, b) => a.name.length - b.name.length)[0];
};

const releaseFor = async (entry, configuredToken, allowPrerelease) => {
	const { owner, repository } = parseRepository(entry.id);

	if (entry.version) return request(`/repos/${owner}/${repository}/releases/tags/${entry.version}`, configuredToken);

	// Not /releases/latest: mod authors publish prereleases constantly, and the newest release that
	// actually carries a jar is the one wanted.
	const releases = await request(`/repos/${owner}/${repository}/releases?per_page=30`, configuredToken);
	const usable = releases
		.filter(release => !release.draft && release.assets?.some(asset => asset.name.endsWith('.jar')))
		.map(release => ({
			...release,
			channel: release.prerelease ? 'beta' : 'release',
			published: Date.parse(release.published_at ?? 0),
		}));

	return pickBuild(usable, { allowPrerelease });
};

const resolveFromApi = async (entry, { minecraft, loader, githubToken, allowPrerelease } = {}) => {
	const release = await releaseFor(entry, githubToken, allowPrerelease);

	if (release === undefined) throw new Error(`github:${entry.id} has no release carrying a jar`);

	const asset = chooseAsset(release.assets ?? [], { minecraft, loader, pattern: entry.asset });

	if (asset === undefined) {
		const names = (release.assets ?? []).map(candidate => candidate.name).join(', ') || 'nothing';

		throw new Error(
			`github:${entry.id} release ${release.tag_name} has no mod jar. It ships: ${names}. Narrow it with an "asset" pattern.`,
		);
	}

	detail('github', `${entry.id} ${release.tag_name} -> ${asset.name}`);

	return {
		source: id,
		id: entry.id,
		name: `${entry.id} ${release.tag_name}`,
		version: release.tag_name,
		file: {
			filename: asset.name,
			url: asset.browser_download_url,
			// Releases expose a digest as `sha256:...`, which checksumOf reads as-is.
			checksum: checksumOf(asset.digest),
			size: asset.size,
		},
		dependencies: [],
	};
};

const live = asset => asset.error === undefined && asset.gone === undefined;

/** The repositories a jar's required mods come from, by the index; what it cannot place is said, not dropped. */
const dependenciesOf = async (entry, mods, context) => {
	const required = catalog.requiredIds(mods);

	if (required.length === 0) return [];

	const entries = await catalog.listing(context);
	const repos = new Set();

	for (const modId of required) {
		const repo = catalog.providerOf(modId, entries);

		if (repo === undefined)
			warn(`github:${entry.id} requires "${modId}", which the index does not know; declare it yourself`);
		else if (repo !== entry.id) repos.add(repo);
	}

	return [...repos].map(repo => ({ source: id, id: repo }));
};

/**
 * Pick a build from the index's record of a repository: the release whose jar declares the instance's
 * loader and game version, read from the jar itself rather than guessed from its name. Undefined when
 * the record has nothing that fits, so the GitHub API can look past the releases the index watches.
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
		throw new Error(`github:${entry.id} ${release.tag} ${asset.name} is listed as known bad: ${asset.knownBad}`);

	for (const replaced of asset.replaced ?? []) {
		warn(
			`github:${entry.id} ${release.tag} ${asset.name} was replaced after it was published; the earlier jar was seen until ${replaced.until}`,
		);
	}

	detail('github', `${entry.id} ${release.tag} -> ${asset.name} (from the index)`);

	return {
		source: id,
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

/**
 * A repository the index has crawled resolves from its record: the build fits by what its jar
 * declares, carries the hash the index computed, and brings its dependencies. One the index has not
 * crawled, or whose watched releases do not fit, resolves from the GitHub API by asset name.
 */
export const resolve = async (entry, context = {}) => {
	let indexed;

	try {
		indexed = await catalog.record(entry.id, context);
	} catch (error) {
		detail('github', `the index could not be read (${error.message}); asking GitHub directly`);
	}

	return (indexed && (await resolveFromRecord(indexed, entry, context))) ?? resolveFromApi(entry, context);
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
			source: id,
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

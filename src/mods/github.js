import { checksumOf, fetchJson } from '../download';
import { detail } from '../out';

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
export const chooseAsset = (assets, { minecraft, pattern } = {}) => {
	let candidates = assets.filter(asset => asset.name.endsWith('.jar') && !NOT_A_MOD.test(asset.name));

	if (candidates.length === 0) return undefined;

	if (pattern) {
		const matcher = new RegExp(pattern, 'i');

		candidates = candidates.filter(asset => matcher.test(asset.name));

		if (candidates.length === 0) return undefined;
	}

	const versioned = minecraft ? candidates.filter(asset => asset.name.includes(minecraft)) : [];
	const pool = versioned.length > 0 ? versioned : candidates;

	return [...pool].sort((a, b) => a.name.length - b.name.length)[0];
};

const releaseFor = async (entry, configuredToken) => {
	const { owner, repository } = parseRepository(entry.id);

	if (entry.version) return request(`/repos/${owner}/${repository}/releases/tags/${entry.version}`, configuredToken);

	// Not /releases/latest: mod authors publish prereleases constantly, and the newest release that
	// actually carries a jar is the one wanted.
	const releases = await request(`/repos/${owner}/${repository}/releases?per_page=30`, configuredToken);

	return releases.find(release => !release.draft && release.assets?.some(asset => asset.name.endsWith('.jar')));
};

export const resolve = async (entry, { minecraft, githubToken } = {}) => {
	const release = await releaseFor(entry, githubToken);

	if (release === undefined) throw new Error(`github:${entry.id} has no release carrying a jar`);

	const asset = chooseAsset(release.assets ?? [], { minecraft, pattern: entry.asset });

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

export const search = async (query, { limit = 10, githubToken } = {}) => {
	const parameters = new URLSearchParams({
		q: `${query} minecraft fabric mod in:name,description`,
		sort: 'stars',
		per_page: String(limit),
	});

	const { items = [] } = await request(`/search/repositories?${parameters}`, githubToken);

	return items.map(item => ({
		source: id,
		id: item.full_name,
		name: item.full_name,
		description: item.description,
		downloads: item.stargazers_count,
		stars: true,
	}));
};

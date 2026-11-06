import { checksumOf, fetchJson } from '../download';
import { detail } from '../out';
import * as catalog from './catalog';
import { resolveFromRecord, resolveFromSource } from './indexed';
import { chooseAsset, nameFits, pickBuild } from './pick';

export { chooseAsset } from './pick';

const API = 'https://api.github.com';

export const id = 'github';

export const label = 'GitHub';

let asking;

const askGh = async () => {
	try {
		const process_ = Bun.spawn(['gh', 'auth', 'token'], { stdout: 'pipe', stderr: 'ignore' });
		const output = (await new Response(process_.stdout).text()).trim();

		if ((await process_.exited) === 0 && output) return output;
	} catch {
		// No gh on PATH: asked again next time, as a sign-in since may have put one there
	}

	return undefined;
};

/**
 * Unauthenticated GitHub allows sixty requests an hour, which a sync can exhaust. A configured
 * token is used when there is one, and otherwise the `gh` CLI is asked for its own: once, however
 * many requests wait on the answer.
 */
export const token = async configured => {
	if (configured) return configured;
	if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

	asking ??= askGh();

	const found = await asking;

	if (found === undefined) asking = undefined;

	return found;
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

/** The newest full release's file whose name ends in this, or undefined when none of the last thirty carries one. */
export const newestAsset = async (reference, suffix, configuredToken) => {
	const { owner, repository } = parseRepository(reference);
	const releases = await request(`/repos/${owner}/${repository}/releases?per_page=30`, configuredToken);

	return releases
		.filter(release => !release.draft && !release.prerelease)
		.flatMap(release => release.assets ?? [])
		.find(asset => asset.name.endsWith(suffix));
};

const releaseFor = async (entry, configuredToken, allowPrerelease, judged) => {
	const { owner, repository } = parseRepository(entry.id);

	if (entry.version) {
		return request(`/repos/${owner}/${repository}/releases/tags/${encodeURIComponent(entry.version)}`, configuredToken);
	}

	// Not /releases/latest: mod authors publish prereleases constantly, and the newest release that
	// actually carries a jar is the one wanted.
	const releases = await request(`/repos/${owner}/${repository}/releases?per_page=30`, configuredToken);
	const usable = releases
		.filter(release => !release.draft && !judged.has(release.tag_name))
		.filter(release => release.assets?.some(asset => asset.name.endsWith('.jar')))
		.map(release => ({
			...release,
			channel: release.prerelease ? 'beta' : 'release',
			published: Date.parse(release.published_at ?? 0),
		}));

	return pickBuild(usable, { allowPrerelease });
};

/** The way to the same mod elsewhere, for a repository whose own releases have nothing for this instance. */
const elsewhere = entry => {
	const slug = parseRepository(entry.id).repository.toLowerCase();

	return `For Modrinth write mr:${slug}, for CurseForge cf:${slug}.`;
};

const resolveFromApi = async (entry, { minecraft, loader, githubToken, allowPrerelease, judged = new Set() } = {}) => {
	const release = await releaseFor(entry, githubToken, allowPrerelease, judged);

	if (release === undefined && judged.size > 0) {
		throw new Error(
			`github:${entry.id} has no release for Minecraft ${minecraft ?? 'any version'} on ${loader ?? 'any loader'}; the index read the jars of each one. ${elsewhere(entry)}`,
		);
	}

	if (release === undefined) throw new Error(`github:${entry.id} has no release carrying a jar`);

	const asset = chooseAsset(release.assets ?? [], { minecraft, loader, pattern: entry.asset });

	if (asset === undefined) {
		const names = (release.assets ?? []).map(candidate => candidate.name).join(', ') || 'nothing';

		throw new Error(
			`github:${entry.id} release ${release.tag_name} has no mod jar. It ships: ${names}. Narrow it with an "asset" pattern.`,
		);
	}

	if (entry.version === undefined && nameFits(asset.name, minecraft) === false) {
		throw new Error(
			`github:${entry.id} ${release.tag_name} ships ${asset.name}, which its name says is for another Minecraft than ${minecraft}. ${elsewhere(entry)}`,
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

	const named = { ...entry, source: id };

	return (
		(indexed && (await resolveFromRecord(indexed, named, context))) ??
		(indexed && (await resolveFromSource(indexed, named, context))) ??
		resolveFromApi(entry, {
			...context,
			judged: new Set(entry.version ? [] : (indexed?.releases ?? []).map(release => release.tag)),
		})
	);
};

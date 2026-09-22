import { checksumOf, fetchJson, fetchWithRetry } from '../download';
import { detail } from '../out';
import { pickBuild } from './pick';

const API = 'https://api.curseforge.com/v1';

/** CurseForge's own site API. It answers without a key, but only for a project's file list. */
const SITE = 'https://www.curseforge.com/api/v1';

/** A public mirror of CurseForge project data, used to turn a slug into an id without a key. */
const WIDGET = 'https://api.cfwidget.com';

const CDN = 'https://mediafilez.forgecdn.net/files';

const MINECRAFT_GAME = 432;

const MOD_CLASS = 6;

const LOADER_TYPES = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };

const RELEASE_TYPES = { 1: 'release', 2: 'beta', 3: 'alpha' };

const LOADER_TAGS = { forge: 'Forge', fabric: 'Fabric', quilt: 'Quilt', neoforge: 'NeoForge' };

export const id = 'curseforge';

export const label = 'CurseForge';

/**
 * A file's download url is not published anywhere, but it is derivable: the id splits into
 * thousands and remainder.
 *
 * The remainder is not padded. Id 8880075 lives under `8880/75`, and `8880/075` is refused, so a
 * tidy-looking three digits breaks every file whose id ends in under a hundred. The name must be
 * escaped for the same reason: a literal `+` is refused where `%2B` is served, and `+` is ordinary
 * in a Fabric jar name.
 */
export const downloadUrl = (fileId, fileName) =>
	`${CDN}/${Math.floor(fileId / 1000)}/${fileId % 1000}/${encodeURIComponent(fileName)}`;

const keyed = async (path, key) => fetchJson(`${API}${path}`, { headers: { 'x-api-key': key } });

/** The mirror builds a project on first request and answers 202 until it is ready. */
const widget = async path => {
	for (let attempt = 0; attempt < 4; ++attempt) {
		const response = await fetchWithRetry(`${WIDGET}${path}`);

		if (response.status !== 202) return response.json();

		detail('curseforge', 'mirror is building the project, waiting');

		await Bun.sleep(1500 * (attempt + 1));
	}

	throw new Error(`CurseForge mirror did not answer for ${path}`);
};

const widgetProject = async reference =>
	widget(/^\d+$/.test(String(reference)) ? `/${reference}` : `/minecraft/mc-mods/${reference}`);

/** The site API carries fresher files than the mirror, so it is preferred once the id is known. */
const siteFiles = async projectId => {
	try {
		const { data } = await fetchJson(`${SITE}/mods/${projectId}/files?pageIndex=0&pageSize=50`);

		return data.map(file => ({
			id: file.id,
			name: file.fileName,
			display: file.displayName,
			size: file.fileLength,
			versions: file.gameVersions ?? [],
			channel: RELEASE_TYPES[file.releaseType],
			published: Date.parse(file.dateCreated ?? file.dateModified ?? 0),
		}));
	} catch {
		return undefined;
	}
};

const matchesInstance = (versions, minecraft, loader) => {
	if (minecraft && !versions.includes(minecraft)) return false;

	const tag = LOADER_TAGS[loader];

	// Older uploads predate loader tagging; a version match alone has to do for those.
	return !tag || !versions.some(entry => Object.values(LOADER_TAGS).includes(entry)) || versions.includes(tag);
};

const resolveKeyless = async (entry, { minecraft, loader, allowPrerelease }) => {
	const project = await widgetProject(entry.id);
	const files = (await siteFiles(project.id)) ?? project.files.map(file => ({ ...file, versions: file.versions }));

	const usable = files.filter(file => matchesInstance(file.versions, minecraft, loader));

	if (usable.length === 0) {
		throw new Error(`curseforge:${entry.id} has no build for Minecraft ${minecraft} on ${loader}`);
	}

	const picked = entry.version
		? usable.find(file => file.display === entry.version || String(file.id) === String(entry.version))
		: pickBuild(usable, { allowPrerelease });

	if (picked === undefined) throw new Error(`curseforge:${entry.id} has no version "${entry.version}"`);

	return {
		source: id,
		id: entry.id,
		name: project.title,
		version: picked.display ?? String(picked.id),
		file: {
			filename: picked.name,
			url: downloadUrl(picked.id, picked.name),
			// The keyless route publishes no checksum, so size is all there is to check against.
			size: picked.size,
		},
		dependencies: [],
	};
};

const findProject = async (entry, key) => {
	if (/^\d+$/.test(String(entry.id))) return { id: Number(entry.id), name: String(entry.id) };

	const parameters = new URLSearchParams({
		gameId: String(MINECRAFT_GAME),
		classId: String(MOD_CLASS),
		slug: String(entry.id),
	});
	const { data } = await keyed(`/mods/search?${parameters}`, key);

	if (data.length === 0) throw new Error(`CurseForge has no mod with slug "${entry.id}"`);

	return data[0];
};

const resolveKeyed = async (entry, { minecraft, loader, key, allowPrerelease }) => {
	const project = await findProject(entry, key);

	const parameters = new URLSearchParams({ pageSize: '50' });

	if (minecraft) parameters.set('gameVersion', minecraft);
	if (LOADER_TYPES[loader]) parameters.set('modLoaderType', String(LOADER_TYPES[loader]));

	const { data } = await keyed(`/mods/${project.id}/files?${parameters}`, key);

	if (data.length === 0) {
		throw new Error(`curseforge:${entry.id} has no build for Minecraft ${minecraft} on ${loader}`);
	}

	const picked = entry.version
		? data.find(file => file.displayName === entry.version || String(file.id) === String(entry.version))
		: pickBuild(
				data.map(file => ({
					...file,
					channel: RELEASE_TYPES[file.releaseType],
					published: Date.parse(file.fileDate ?? 0),
				})),
				{ allowPrerelease },
			);

	if (picked === undefined) throw new Error(`curseforge:${entry.id} has no version "${entry.version}"`);

	return {
		source: id,
		id: entry.id,
		name: project.name,
		version: picked.displayName ?? String(picked.id),
		file: {
			filename: picked.fileName,
			// Authors may opt out of third-party downloads, which empties the url the API returns.
			url: picked.downloadUrl ?? downloadUrl(picked.id, picked.fileName),
			checksum: checksumOf(picked.hashes?.find(hash => hash.algo === 1)?.value),
			size: picked.fileLength,
		},
		dependencies: (picked.dependencies ?? [])
			.filter(dependency => dependency.relationType === 3)
			.map(dependency => ({ source: id, id: String(dependency.modId) })),
	};
};

export const resolve = async (entry, context) =>
	context.key ? resolveKeyed(entry, context) : resolveKeyless(entry, context);

export const search = async (query, { minecraft, loader, limit = 10, key } = {}) => {
	if (key) {
		const parameters = new URLSearchParams({
			gameId: String(MINECRAFT_GAME),
			classId: String(MOD_CLASS),
			searchFilter: query,
			pageSize: String(limit),
			sortField: '2',
			sortOrder: 'desc',
		});

		if (minecraft) parameters.set('gameVersion', minecraft);
		if (LOADER_TYPES[loader]) parameters.set('modLoaderType', String(LOADER_TYPES[loader]));

		const { data } = await keyed(`/mods/search?${parameters}`, key);

		return data.map(mod => ({
			source: id,
			id: mod.slug,
			name: mod.name,
			description: mod.summary,
			downloads: mod.downloadCount,
		}));
	}

	// Without a key CurseForge publishes no search. A slug still resolves, so an exact name is
	// looked up rather than nothing being offered at all.
	try {
		const project = await widgetProject(query.trim().toLowerCase().replaceAll(' ', '-'));

		return [
			{
				source: id,
				id: project.urls?.curseforge?.split('/').pop() ?? String(project.id),
				name: project.title,
				description: project.summary,
				downloads: project.downloads?.total ?? 0,
				exact: true,
			},
		];
	} catch {
		return [];
	}
};

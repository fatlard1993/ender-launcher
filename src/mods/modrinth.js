import { checksumOf, fetchJson } from '../download';
import { pickBuild } from './pick';

const API = 'https://api.modrinth.com/v2';

export const id = 'modrinth';

export const label = 'Modrinth';

const facets = ({ minecraft, loader }) => {
	const built = [['project_type:mod']];

	if (loader) built.push([`categories:${loader}`]);
	if (minecraft) built.push([`versions:${minecraft}`]);

	return encodeURIComponent(JSON.stringify(built));
};

export const search = async (query, { minecraft, loader, limit = 10 } = {}) => {
	const url = `${API}/search?query=${encodeURIComponent(query)}&limit=${limit}&facets=${facets({ minecraft, loader })}`;
	const { hits } = await fetchJson(url);

	return hits.map(hit => ({
		source: id,
		id: hit.slug,
		name: hit.title,
		description: hit.description,
		downloads: hit.downloads,
		sides: { client: hit.client_side, server: hit.server_side },
	}));
};

/** Newest release of a project that matches the instance, or a named version when one is pinned. */
export const resolve = async (entry, { minecraft, loader, allowPrerelease }) => {
	const query = new URLSearchParams();

	if (loader) query.set('loaders', JSON.stringify([loader]));
	if (minecraft) query.set('game_versions', JSON.stringify([minecraft]));

	const versions = await fetchJson(`${API}/project/${entry.id}/version?${query}`);

	if (versions.length === 0) {
		throw new Error(`modrinth:${entry.id} has no build for Minecraft ${minecraft} on ${loader}`);
	}

	const picked = entry.version
		? versions.find(version => version.version_number === entry.version || version.id === entry.version)
		: pickBuild(
				versions.map(version => ({
					...version,
					channel: version.version_type,
					published: Date.parse(version.date_published),
				})),
				{ allowPrerelease },
			);

	if (picked === undefined) throw new Error(`modrinth:${entry.id} has no version "${entry.version}"`);

	const file = picked.files.find(candidate => candidate.primary) ?? picked.files[0];

	return {
		source: id,
		id: entry.id,
		name: picked.name,
		version: picked.version_number,
		file: {
			filename: file.filename,
			url: file.url,
			checksum: checksumOf(file.hashes?.sha1),
			size: file.size,
		},
		dependencies: (picked.dependencies ?? [])
			.filter(dependency => dependency.dependency_type === 'required' && dependency.project_id)
			.map(dependency => ({ source: id, id: dependency.project_id })),
	};
};

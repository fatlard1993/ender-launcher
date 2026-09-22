import { join } from 'node:path';

import { checksumOf, ensureFile, fetchJson } from '../download';
import { paths } from '../paths';
import { allowed } from './rules';

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const RESOURCES = 'https://resources.download.minecraft.net';

let manifestCache;

export const versionManifest = async () => (manifestCache ??= await fetchJson(MANIFEST));

export const resolveVersionId = async wanted => {
	const manifest = await versionManifest();

	if (wanted === undefined || wanted === 'release') return manifest.latest.release;
	if (wanted === 'snapshot') return manifest.latest.snapshot;

	return wanted;
};

/** The version's own metadata, cached on disk so repeat launches do not re-ask Mojang. */
export const versionMeta = async wanted => {
	const id = await resolveVersionId(wanted);
	const manifest = await versionManifest();
	const entry = manifest.versions.find(version => version.id === id);

	if (entry === undefined) throw new Error(`Mojang publishes no version "${id}"`);

	const path = join(paths.versions, id, `${id}.json`);

	await ensureFile({ url: entry.url, path, checksum: checksumOf(entry.sha1) });

	return { entry, meta: await Bun.file(path).json() };
};

export const clientJarPath = id => join(paths.versions, id, `${id}.jar`);

export const serverJarPath = id => join(paths.versions, id, `${id}-server.jar`);

/** Every library entry whose rules hold on this machine, as download jobs. */
export const libraryJobs = (meta, donorRoots = []) =>
	meta.libraries
		.filter(library => allowed(library.rules))
		.filter(library => library.downloads?.artifact)
		.map(({ name, downloads: { artifact } }) => ({
			name,
			url: artifact.url,
			checksum: checksumOf(artifact.sha1),
			size: artifact.size,
			path: join(paths.libraries, artifact.path),
			donors: donorRoots.map(root => join(root, artifact.path)),
		}));

export const assetIndexPath = id => join(paths.assets, 'indexes', `${id}.json`);

export const fetchAssetIndex = async (meta, donorRoots = []) => {
	const { id, url, sha1, size } = meta.assetIndex;
	const path = assetIndexPath(id);

	await ensureFile({
		url,
		path,
		checksum: checksumOf(sha1),
		size,
		donors: donorRoots.map(root => join(root, 'indexes', `${id}.json`)),
	});

	return { id, index: await Bun.file(path).json() };
};

export const assetJobs = (index, donorRoots = []) =>
	Object.values(index.objects).map(({ hash, size }) => {
		const relative = join('objects', hash.slice(0, 2), hash);

		return {
			url: `${RESOURCES}/${hash.slice(0, 2)}/${hash}`,
			checksum: checksumOf(hash),
			size,
			path: join(paths.assets, relative),
			donors: donorRoots.map(root => join(root, relative)),
		};
	});

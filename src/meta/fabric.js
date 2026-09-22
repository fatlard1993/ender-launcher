import { join } from 'node:path';

import { checksumOf, ensureFile, fetchJson } from '../download';
import { paths } from '../paths';
import { coordinateToPath, coordinateToUrl } from './maven';

const META = 'https://meta.fabricmc.net/v2';

const DEFAULT_REPOSITORY = 'https://maven.fabricmc.net/';

export const loaderVersions = async minecraft => fetchJson(`${META}/versions/loader/${minecraft}`);

export const installerVersions = async () => fetchJson(`${META}/versions/installer`);

/** The newest loader Fabric marks stable for this game version, falling back to the newest of any kind. */
export const latestLoader = async minecraft => {
	const versions = await loaderVersions(minecraft);

	if (versions.length === 0) throw new Error(`Fabric publishes no loader for Minecraft ${minecraft}`);

	return (versions.find(({ loader }) => loader.stable) ?? versions[0]).loader.version;
};

/**
 * Fabric's launcher profile for a pairing: its own main class, its own libraries, and the
 * arguments it needs layered over the vanilla ones.
 */
export const profile = async (minecraft, loader, side = 'client') =>
	fetchJson(`${META}/versions/loader/${minecraft}/${loader}/profile/json${side === 'server' ? '?server=true' : ''}`);

/** Fabric libraries carry maven coordinates rather than resolved download blocks. */
export const libraryJobs = (fabricProfile, donorRoots = []) =>
	fabricProfile.libraries.map(({ name, url = DEFAULT_REPOSITORY, sha1, size }) => {
		const relative = coordinateToPath(name);

		return {
			name,
			url: coordinateToUrl(name, url),
			checksum: checksumOf(sha1),
			size,
			path: join(paths.libraries, relative),
			donors: donorRoots.map(root => join(root, relative)),
		};
	});

export const serverLauncherUrl = (minecraft, loader, installer) =>
	`${META}/versions/loader/${minecraft}/${loader}/${installer}/server/jar`;

export const fetchServerLauncher = async (minecraft, loader, path) => {
	const [installer] = await installerVersions();

	await ensureFile({ url: serverLauncherUrl(minecraft, loader, installer.version), path });

	return installer.version;
};

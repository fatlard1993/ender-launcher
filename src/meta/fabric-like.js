import { join } from 'node:path';

import { checksumOf, ensureFile, fetchJson } from '../download';
import { paths } from '../paths';
import { coordinateToPath, coordinateToUrl } from './maven';

/**
 * Fabric and Quilt publish the same service under different names: a loader list per game version,
 * and a launcher profile naming the main class and the libraries to put in front of the game's.
 * One implementation serves both, because the difference really is only the address.
 */
export const fabricLike = ({ name, meta, defaultRepository }) => {
	const loaderVersions = async minecraft => {
		try {
			return await fetchJson(`${meta}/versions/loader/${encodeURIComponent(minecraft)}`);
		} catch (error) {
			// These services answer 400, not an empty list, for a game version not ingested yet.
			// On a release-day snapshot that is the expected answer and has to read like one.
			if (error.status === 400 || error.status === 404) {
				throw new Error(`${name} has no loader for Minecraft ${minecraft} yet`);
			}

			throw error;
		}
	};

	const latestLoader = async minecraft => {
		const versions = await loaderVersions(minecraft);

		if (versions.length === 0) throw new Error(`${name} publishes no loader for Minecraft ${minecraft}`);

		return (versions.find(({ loader }) => loader.stable) ?? versions[0]).loader.version;
	};

	const profile = async (minecraft, loader, side = 'client') =>
		fetchJson(
			`${meta}/versions/loader/${encodeURIComponent(minecraft)}/${encodeURIComponent(loader)}/profile/json${
				side === 'server' ? '?server=true' : ''
			}`,
		);

	/** These profiles carry maven coordinates rather than resolved download blocks. */
	const libraryJobs = (loaderProfile, donorRoots = []) =>
		loaderProfile.libraries.map(({ name: coordinate, url = defaultRepository, sha1, size }) => {
			const relative = coordinateToPath(coordinate);

			return {
				name: coordinate,
				url: coordinateToUrl(coordinate, url),
				checksum: checksumOf(sha1),
				size,
				path: join(paths.libraries, relative),
				donors: donorRoots.map(root => join(root, relative)),
			};
		});

	const installerVersions = async () => fetchJson(`${meta}/versions/installer`);

	const fetchServerLauncher = async (minecraft, loader, path) => {
		const [installer] = await installerVersions();

		await ensureFile({
			url: `${meta}/versions/loader/${minecraft}/${loader}/${installer.version}/server/jar`,
			path,
		});

		return installer.version;
	};

	return {
		name,
		source: meta.replace(/^https?:\/\//, '').replace(/\/v\d+$/, ''),
		loaderVersions,
		latestLoader,
		profile,
		libraryJobs,
		installerVersions,
		fetchServerLauncher,
	};
};

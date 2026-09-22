import { fabricLike } from './fabric-like';

export const fabric = fabricLike({
	name: 'Fabric',
	meta: 'https://meta.fabricmc.net/v2',
	defaultRepository: 'https://maven.fabricmc.net/',
});

export const { loaderVersions, latestLoader, profile, libraryJobs, installerVersions, fetchServerLauncher } = fabric;

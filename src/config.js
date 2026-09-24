import { paths } from './paths';
import { readJson, writeJson } from './json';

const defaults = {
	activeInstance: undefined,
	username: 'Player',
	curseforgeKey: undefined,
	githubToken: undefined,
	javaPath: undefined,
	memory: { min: 512, max: 4096 },
	manageJava: true,
	prerelease: false,
	clientId: undefined,
};

export const readConfig = async () => ({ ...defaults, ...(await readJson(paths.config, {})) });

const writeConfig = async config => {
	await writeJson(paths.config, config);

	return config;
};

export const updateConfig = async changes => writeConfig({ ...(await readConfig()), ...changes });

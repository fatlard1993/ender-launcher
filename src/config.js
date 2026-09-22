import { paths } from './paths';
import { readJson, writeJson } from './json';

const defaults = {
	activeInstance: undefined,
	username: 'Player',
	curseforgeKey: undefined,
	githubToken: undefined,
	javaPath: undefined,
	memory: { min: 512, max: 4096 },
};

export const readConfig = async () => ({ ...defaults, ...(await readJson(paths.config, {})) });

export const writeConfig = async config => {
	await writeJson(paths.config, config);

	return config;
};

export const updateConfig = async changes => writeConfig({ ...(await readConfig()), ...changes });

import { sayIfNewer } from './format';
import { paths } from './paths';
import { readJson, writeJson } from './json';

/**
 * The version of config.json's shape, kept in it. Fields are added without raising it; it goes up only for a change an
 * older ender would misread. A config that names none is from ender 0.3 or before.
 */
export const CONFIG_FORMAT = 1;

const defaults = {
	format: CONFIG_FORMAT,
	activeInstance: undefined,
	curseforgeKey: undefined,
	githubToken: undefined,
	index: undefined,
	javaPath: undefined,
	memory: { min: 512, max: 4096 },
	manageJava: true,
	prerelease: false,
};

/** A config from ender 0.3 or before, as this ender keeps one: the repositories allowed to build were a list. */
const upgraded = saved =>
	saved.format === undefined && Array.isArray(saved.builds)
		? { ...saved, builds: Object.fromEntries(saved.builds.map(key => [key, {}])) }
		: saved;

export const readConfig = async () => {
	const { clientId, ...saved } = await readJson(paths.config, {});

	sayIfNewer({ file: 'config.json', kind: 'config', format: saved.format, reads: CONFIG_FORMAT });

	return { ...defaults, ...upgraded(saved) };
};

const writeConfig = async config => {
	await writeJson(paths.config, config);

	return config;
};

export const updateConfig = async changes => writeConfig({ ...(await readConfig()), ...changes });

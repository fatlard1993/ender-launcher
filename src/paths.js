import { homedir } from 'node:os';
import { join } from 'node:path';

const xdg = (variable, fallback) => process.env[variable] || join(homedir(), fallback);

export const dataRoot = process.env.MCM_HOME || join(xdg('XDG_DATA_HOME', '.local/share'), 'minecraft-manager');

export const configRoot = process.env.MCM_HOME || join(xdg('XDG_CONFIG_HOME', '.config'), 'minecraft-manager');

export const paths = {
	config: join(configRoot, 'config.json'),
	instances: join(dataRoot, 'instances'),
	assets: join(dataRoot, 'assets'),
	libraries: join(dataRoot, 'libraries'),
	versions: join(dataRoot, 'versions'),
	natives: join(dataRoot, 'natives'),
	java: join(dataRoot, 'java'),
	cache: join(dataRoot, 'cache'),
};

export const instanceDir = name => join(paths.instances, name);

export const manifestPath = name => join(instanceDir(name), 'instance.json');

export const lockPath = name => join(instanceDir(name), 'instance.lock.json');

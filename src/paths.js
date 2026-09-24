import { homedir } from 'node:os';
import { join } from 'node:path';

const xdg = (variable, fallback) => process.env[variable] || join(homedir(), fallback);

export const dataRoot = () => process.env.ENDER_HOME || join(xdg('XDG_DATA_HOME', '.local/share'), 'ender-launcher');

export const configRoot = () => process.env.ENDER_HOME || join(xdg('XDG_CONFIG_HOME', '.config'), 'ender-launcher');

/**
 * Read when asked rather than when imported, so the environment that decides where everything
 * lives is the one in force at the time, not the one that happened to exist at module load.
 */
export const paths = {
	get config() {
		return join(configRoot(), 'config.json');
	},
	get accounts() {
		return join(configRoot(), 'accounts.json');
	},
	get instances() {
		return join(dataRoot(), 'instances');
	},
	get assets() {
		return join(dataRoot(), 'assets');
	},
	get libraries() {
		return join(dataRoot(), 'libraries');
	},
	get versions() {
		return join(dataRoot(), 'versions');
	},
	get natives() {
		return join(dataRoot(), 'natives');
	},
	get java() {
		return join(dataRoot(), 'java');
	},
	get cache() {
		return join(dataRoot(), 'cache');
	},
};

export const instanceDir = name => join(paths.instances, name);

export const manifestPath = name => join(instanceDir(name), 'instance.json');

export const lockPath = name => join(instanceDir(name), 'instance.lock.json');

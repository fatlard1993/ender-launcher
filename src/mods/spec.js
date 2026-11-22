/** `sodium`, `modrinth:sodium@0.5.8`, `cf:jei`, `./build/libs/mod.jar`, or a url. */
const PREFIXES = { github: 'gh:', codeberg: 'cb:', gitlab: 'gl:', modrinth: 'mr:', curseforge: 'cf:' };

/**
 * Whether an id names something on a host and nothing a path could climb out of: no empty, `.` or `..` part, and no
 * backslash. Ids become paths in the index and in ender's cache, and a pack from anywhere can name one.
 */
export const safeId = id =>
	typeof id === 'string' &&
	id !== '' &&
	!id.includes('\\') &&
	id.split('/').every(part => part !== '' && part !== '.' && part !== '..');

/** Whether a spec names a jar or a project on this machine, rather than where a mod is published. */
export const namesThisMachine = spec =>
	/^(\.{0,2}\/|~|[A-Za-z]:[\\/]|\\)/.test(spec) ||
	spec.startsWith('gradle:') ||
	(spec.endsWith('.jar') && !/^https?:\/\//.test(spec));

/** How a mod found by search is written so that parseModSpec reads it back to the source it came from. */
export const specFor = (source, id) => `${PREFIXES[source]}${id}`;

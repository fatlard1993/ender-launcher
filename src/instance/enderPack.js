import { specFor } from '../mods/spec';

/** The file a pack is: at the root of a repository or a zip, or anywhere by itself. */
export const ENDER_PACK = 'ender.pack.json';

const LOADERS = new Set(['fabric', 'quilt', 'forge', 'neoforge', 'vanilla']);

/** The parts of a game directory a pack may carry beside its file; anything else there is the repository's own. */
export const GAME_FILES = [
	'config/',
	'defaultconfigs/',
	'kubejs/',
	'scripts/',
	'resourcepacks/',
	'shaderpacks/',
	'options.txt',
	'servers.dat',
];

/**
 * A pack as its file says it, checked: its name, game version and loader, and the mods it chose, each a spec as
 * `ender add` takes and a version only when one is pinned. What the mods need is not listed; it is resolved on install.
 */
export const parseEnderPack = (json, { file = ENDER_PACK } = {}) => {
	const pack = typeof json === 'string' ? JSON.parse(json) : json;
	const problems = [];

	if (typeof pack?.minecraft !== 'string' || pack.minecraft.trim() === '')
		problems.push('names no "minecraft" version');
	if (!LOADERS.has(pack?.loader)) problems.push(`names no "loader" of ${[...LOADERS].join(', ')}`);
	if (!Array.isArray(pack?.mods)) problems.push('has no "mods" list');

	const mods = (Array.isArray(pack?.mods) ? pack.mods : []).map((mod, at) => {
		const spec = typeof mod === 'string' ? mod : mod?.spec;

		if (typeof spec !== 'string' || spec.trim() === '') {
			problems.push(`mods[${at}] is neither a spec nor { "spec": ... }`);

			return undefined;
		}

		return { spec: spec.trim(), ...(typeof mod?.version === 'string' ? { version: mod.version } : {}) };
	});

	if (problems.length > 0) throw new Error(`${file} ${problems.join('; ')}`);

	return {
		...(typeof pack.name === 'string' ? { name: pack.name } : {}),
		...(typeof pack.summary === 'string' ? { summary: pack.summary } : {}),
		minecraft: pack.minecraft.trim(),
		loader: pack.loader,
		mods,
	};
};

const SHAREABLE = new Set(['github', 'codeberg', 'gitlab', 'modrinth', 'curseforge']);

/**
 * An instance's chosen mods as a pack, and those that cannot be in one: a jar on this disk, a link, or a gradle build
 * mean nothing on another machine. Only what was chosen is listed; what it needs is resolved where it is installed.
 */
export const packFrom = manifest => {
	const shareable = manifest.mods.filter(entry => SHAREABLE.has(entry.source));

	return {
		pack: {
			name: manifest.name,
			minecraft: manifest.minecraft,
			loader: manifest.loader?.type ?? 'vanilla',
			mods: shareable.map(entry => {
				const spec = specFor(entry.source, entry.id);

				return entry.version ? { spec, version: entry.version } : spec;
			}),
		},
		left: manifest.mods.filter(entry => !SHAREABLE.has(entry.source)),
	};
};

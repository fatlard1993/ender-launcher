import { namesThisMachine, specFor } from '../mods/spec';
import { serversOf } from './servers';

/** The key an instance knows an entry by, as mods/index writes it; kept here so a pack reads without the resolvers. */
const entryKey = entry => `${entry.source}:${entry.id ?? entry.path ?? entry.url}`;

/** The file a pack is: at the root of a repository or a zip, or anywhere by itself. */
export const ENDER_PACK = 'ender.pack.json';

/**
 * The version of the pack format this ender writes and reads. Fields are added without changing it; it goes up only
 * for a change an older ender would misread. A pack that names none is format 1, as every pack before it was.
 */
export const PACK_FORMAT = 1;

const LOADERS = new Set(['fabric', 'quilt', 'forge', 'neoforge', 'vanilla']);

/**
 * The parts of a game directory a pack may carry beside its file; anything else there is the repository's own.
 * `datapacks/` and `global_packs/` hold data packs that apply to every world, as Global Packs, Data Loader, Global
 * Datapacks and Paxi read them; Paxi's own folder and Open Loader's are under `config/`.
 */
export const GAME_FILES = [
	'config/',
	'defaultconfigs/',
	'kubejs/',
	'scripts/',
	'resourcepacks/',
	'shaderpacks/',
	'datapacks/',
	'global_packs/',
	// What mods read from the game directory itself: menus, maps, defaults, gun packs, schematics, skins, loaded resources
	'fancymenu_data/',
	'journeymap/',
	'configureddefaults/',
	'tacz/',
	'schematics/',
	'CustomSkinLoader/',
	'resources/',
	'local/',
	'options.txt',
	'servers.dat',
	'server.properties',
	'server-icon.png',
];

/**
 * How a pack offers an entry a player may leave out: `optional`, with a line saying what it adds, and `default` to have
 * it on until they turn it off. Nothing for an entry every player gets.
 */
const offering = item =>
	item?.optional === true
		? {
				optional: true,
				...(typeof item.description === 'string' && item.description.trim() !== ''
					? { description: item.description.trim() }
					: {}),
				...(item.default === true ? { chosen: true } : {}),
			}
		: {};

/** An entry's offering as a pack writes it, from the instance that keeps it and the choices made there. */
const offeredAs = (entry, chosen) =>
	entry.optional
		? {
				optional: true,
				...(entry.description ? { description: entry.description } : {}),
				...(chosen.has(entryKey(entry)) ? { default: true } : {}),
			}
		: {};

/** What a pack names a resource or shader pack by: a Modrinth or CurseForge project, or a link. */
const ASSET_SPEC = /^(mr|modrinth|cf|curseforge):([\w.-]+)$/;
const ASSET_HOSTS = { mr: 'modrinth', modrinth: 'modrinth', cf: 'curseforge', curseforge: 'curseforge' };

/** A resource or shader pack's spec as the entry an instance keeps, or undefined when it names none of those. */
export const assetEntry = (spec, version) => {
	if (/^https:\/\/\S+$/.test(spec)) return { source: 'url', url: spec };

	const [, host, id] = spec.match(ASSET_SPEC) ?? [];

	if (!host || id === '.' || id === '..') return undefined;

	return { source: ASSET_HOSTS[host], id, ...(version ? { version } : {}) };
};

/** The spec a resource or shader pack entry is written as in a pack. */
export const assetSpec = entry =>
	entry.source === 'url' ? entry.url : `${{ modrinth: 'mr', curseforge: 'cf' }[entry.source]}:${entry.id}`;

/** Each resource or shader pack a pack lists, as entries, with what is wrong in the list said in `problems`. */
const assetsIn = (pack, kind, problems) => {
	if (pack?.[kind] === undefined) return [];
	if (!Array.isArray(pack[kind])) {
		problems.push(`"${kind}" is not a list`);

		return [];
	}

	return pack[kind].flatMap((item, at) => {
		const spec = typeof item === 'string' ? item.trim() : item?.spec?.trim?.();
		const entry = spec && assetEntry(spec, typeof item?.version === 'string' ? item.version : undefined);

		if (!entry) {
			problems.push(`${kind}[${at}] is not mr:<project>, cf:<project> or an https link`);

			return [];
		}

		return [{ ...entry, ...offering(item) }];
	});
};

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

		if (namesThisMachine(spec.trim())) {
			problems.push(
				`mods[${at}] names a jar or project on this machine (${spec.trim()}); a pack names mods where they are published`,
			);

			return undefined;
		}

		return {
			spec: spec.trim(),
			...(typeof mod?.version === 'string' ? { version: mod.version } : {}),
			...offering(mod),
		};
	});

	const text = key => (typeof pack?.[key] === 'string' && pack[key].trim() !== '' ? pack[key].trim() : undefined);

	if (pack?.format !== undefined && !(Number.isInteger(pack.format) && pack.format >= 1))
		problems.push('"format" is not a whole number from 1');

	if (pack?.loaderVersion !== undefined && text('loaderVersion') === undefined)
		problems.push('"loaderVersion" is not a version');
	if (pack?.loaderVersion !== undefined && pack?.loader === 'vanilla')
		problems.push('pins a "loaderVersion" with no loader');
	if (pack?.memory !== undefined && !(Number.isInteger(pack.memory) && pack.memory >= 1024 && pack.memory <= 65_536))
		problems.push('"memory" is not megabytes between 1024 and 65536');

	const servers = serversOf(pack, problems);
	const resourcepacks = assetsIn(pack, 'resourcepacks', problems);
	const shaderpacks = assetsIn(pack, 'shaderpacks', problems);

	if (problems.length > 0) throw new Error(`${file} ${problems.join('; ')}`);

	return {
		format: pack.format ?? 1,
		...(typeof pack.name === 'string' ? { name: pack.name } : {}),
		...(typeof pack.summary === 'string' ? { summary: pack.summary } : {}),
		...(text('version') ? { version: text('version') } : {}),
		...(text('author') ? { author: text('author') } : {}),
		...(pack.memory !== undefined ? { memory: pack.memory } : {}),
		minecraft: pack.minecraft.trim(),
		loader: pack.loader,
		...(text('loaderVersion') ? { loaderVersion: text('loaderVersion') } : {}),
		mods,
		...(resourcepacks.length > 0 ? { resourcepacks } : {}),
		...(shaderpacks.length > 0 ? { shaderpacks } : {}),
		...(servers.length > 0 ? { servers } : {}),
	};
};

/** An entry as a pack lists it: its spec alone when nothing more is said of it. */
const written = (spec, entry, chosen) => {
	const more = { ...(entry.version ? { version: entry.version } : {}), ...offeredAs(entry, chosen) };

	return Object.keys(more).length > 0 ? { spec, ...more } : spec;
};

const SHAREABLE = new Set(['github', 'codeberg', 'gitlab', 'modrinth', 'curseforge']);

/**
 * An instance's chosen mods as a pack, and those that cannot be in one: a jar on this disk, a link, or a gradle build
 * mean nothing on another machine. Only what was chosen is listed; what it needs is resolved where it is installed.
 * An optional entry stays optional, on by default where this instance has it on.
 */
export const packFrom = (manifest, { pinLoader = false, version, author, servers = [] } = {}) => {
	const chosen = new Set(manifest.chosen ?? []);
	const shareable = manifest.mods.filter(entry => SHAREABLE.has(entry.source));
	const assets = Object.fromEntries(
		['resourcepacks', 'shaderpacks']
			.map(kind => [kind, (manifest[kind] ?? []).map(entry => written(assetSpec(entry), entry, chosen))])
			.filter(([, listed]) => listed.length > 0),
	);

	return {
		pack: {
			format: PACK_FORMAT,
			name: manifest.name,
			...((version ?? manifest.pack?.version) ? { version: version ?? manifest.pack.version } : {}),
			...((author ?? manifest.pack?.author) ? { author: author ?? manifest.pack.author } : {}),
			minecraft: manifest.minecraft,
			loader: manifest.loader?.type ?? 'vanilla',
			...(pinLoader && manifest.loader?.version ? { loaderVersion: manifest.loader.version } : {}),
			...(manifest.memory?.max ? { memory: manifest.memory.max } : {}),
			mods: shareable.map(entry => written(specFor(entry.source, entry.id), entry, chosen)),
			...assets,
			...(servers.length > 0 ? { servers } : {}),
		},
		left: manifest.mods.filter(entry => !SHAREABLE.has(entry.source)),
	};
};

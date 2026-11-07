import { basename } from 'node:path';

/** How a packwiz pack.toml names each loader in its `[versions]`. */
const LOADERS = { fabric: 'fabric', quilt: 'quilt', forge: 'forge', neoforge: 'neoforge' };

/** The hashes a link's file can be checked by here; CurseForge's murmur2 is not one. */
const CHECKABLE = new Set(['sha1', 'sha256', 'sha512', 'md5']);

/** The game version, loader and name a pack.toml states, or what it lacks. */
export const packwizPack = (source, { file = 'pack.toml' } = {}) => {
	const pack = Bun.TOML.parse(source);
	const versions = pack.versions ?? {};

	if (typeof versions.minecraft !== 'string') throw new Error(`${file} names no [versions] minecraft`);

	const loader = Object.keys(LOADERS).find(key => versions[key]);

	return {
		name: pack.name,
		minecraft: versions.minecraft,
		loader: loader ? { type: LOADERS[loader], version: versions[loader] } : { type: 'vanilla' },
		index: pack.index?.file ?? 'index.toml',
	};
};

/** The mod files an index.toml lists, by path from the pack's folder: each a .pw.toml describing one mod. */
export const packwizMetafiles = source =>
	(Bun.TOML.parse(source).files ?? []).filter(entry => entry.metafile).map(entry => entry.file);

/**
 * One packwiz mod as `{ entry }`, the entry ender keeps for it, or as `{ leftOut }` naming why there is none: `side`
 * when it is not for this side, `optional` when its `[option]` is an opt-in whose default is off, which
 * packwiz-installer installs only when a player chooses it. A Modrinth or CurseForge mod stays one, so it can be
 * updated; any other is its link, checked by its hash where that can be.
 */
export const packwizMod = (source, { side = 'client' } = {}) => {
	const mod = Bun.TOML.parse(source);

	if (mod.side && mod.side !== 'both' && mod.side !== side) return { leftOut: 'side' };
	if (mod.option?.optional === true && mod.option.default !== true) return { leftOut: 'optional' };

	const modrinth = mod.update?.modrinth;
	const curseforge = mod.update?.curseforge;

	if (modrinth?.['mod-id']) {
		return { entry: { source: 'modrinth', id: modrinth['mod-id'], version: modrinth.version } };
	}

	const { url, hash, 'hash-format': format } = mod.download ?? {};

	if (curseforge?.['project-id']) {
		return {
			entry: {
				source: 'curseforge',
				id: String(curseforge['project-id']),
				version: String(curseforge['file-id']),
				...(hash && format === 'sha1' ? { checksum: `sha1:${hash.toLowerCase()}` } : {}),
			},
		};
	}

	if (!url) throw new Error(`${mod.name ?? 'a mod'} has neither a link nor a Modrinth or CurseForge id`);

	return {
		entry: {
			source: 'url',
			url,
			file: mod.filename ?? basename(new URL(url).pathname),
			...(hash && CHECKABLE.has(format) ? { checksum: `${format}:${hash}` } : {}),
		},
	};
};

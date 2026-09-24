import { mkdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { extractArchive, listEntries, readEntryJson } from '../archive';
import { detail, plural, step } from '../out';

const MRPACK_INDEX = 'modrinth.index.json';

const CURSEFORGE_MANIFEST = 'manifest.json';

/** How a Modrinth index names a loader in its `dependencies`. */
const MODRINTH_LOADERS = {
	'fabric-loader': 'fabric',
	'quilt-loader': 'quilt',
	forge: 'forge',
	neoforge: 'neoforge',
};

/** How a CurseForge manifest names one in `modLoaders[].id`, which is `<loader>-<version>`. */
const CURSEFORGE_LOADERS = { fabric: 'fabric', quilt: 'quilt', forge: 'forge', neoforge: 'neoforge' };

const nameFrom = path => basename(path, extname(path));

/** What kind of thing was handed to `import`, decided by looking inside rather than by extension. */
export const detectPack = async path => {
	const entries = await listEntries(path);

	if (entries.includes(MRPACK_INDEX)) return 'mrpack';
	if (entries.includes(CURSEFORGE_MANIFEST)) return 'curseforge';
	if (entries.some(entry => entry.endsWith('.jar'))) return 'mods';

	throw new Error(`Not a modpack: ${path}`);
};

const unpackOverrides = async (path, gameDir, prefix) => {
	const written = await extractArchive(path, gameDir, { prefix });

	if (written.length > 0) detail('overrides', `${plural(written.length, 'file')} from ${prefix}`);

	return written;
};

/**
 * A Modrinth pack states its game version and loader, lists the files it expects to be fetched,
 * and carries everything else as overrides. The listed files are verifiable, so they become mod
 * entries; the overrides are just files, and are laid down as they are.
 */
const fromMrpack = async (path, { name, side = 'client' }) => {
	const index = await readEntryJson(path, MRPACK_INDEX);
	const dependencies = index.dependencies ?? {};
	const loaderKey = Object.keys(MODRINTH_LOADERS).find(key => dependencies[key]);

	const minecraft = dependencies.minecraft;

	if (minecraft === undefined) throw new Error(`${basename(path)} names no Minecraft version`);

	const wanted = (index.files ?? []).filter(file => (file.env?.[side] ?? 'required') !== 'unsupported');

	return {
		manifest: {
			name: name ?? index.name ?? nameFrom(path),
			minecraft,
			loader: loaderKey ? { type: MODRINTH_LOADERS[loaderKey], version: dependencies[loaderKey] } : { type: 'vanilla' },
			mods: wanted.map(file => ({
				source: 'url',
				url: file.downloads[0],
				file: basename(file.path),
				checksum: file.hashes?.sha1 ? `sha1:${file.hashes.sha1}` : undefined,
			})),
		},
		summary: index.summary,
		overridePrefixes: ['overrides/', `${side}-overrides/`],
	};
};

/**
 * A CurseForge pack names its mods by project and file id rather than by url, which is exactly
 * what the curseforge source already resolves.
 */
const fromCurseForge = async (path, { name }) => {
	const manifest = await readEntryJson(path, CURSEFORGE_MANIFEST);
	const minecraft = manifest.minecraft?.version;

	if (minecraft === undefined) throw new Error(`${basename(path)} names no Minecraft version`);

	const primary =
		(manifest.minecraft.modLoaders ?? []).find(entry => entry.primary) ?? manifest.minecraft.modLoaders?.[0];
	// `fabric-0.19.5`: the loader name runs up to the first dash, the rest is its version, which
	// may contain dashes of its own.
	const identifier = primary?.id ?? '';
	const split = identifier.indexOf('-');
	const loaderName = split === -1 ? identifier : identifier.slice(0, split);
	const loaderVersion = split === -1 ? undefined : identifier.slice(split + 1);

	return {
		manifest: {
			name: name ?? manifest.name ?? nameFrom(path),
			minecraft,
			loader: CURSEFORGE_LOADERS[loaderName]
				? { type: CURSEFORGE_LOADERS[loaderName], version: loaderVersion }
				: { type: 'vanilla' },
			mods: (manifest.files ?? []).map(file => ({
				source: 'curseforge',
				id: String(file.projectID),
				version: String(file.fileID),
			})),
		},
		overridePrefixes: [`${manifest.overrides ?? 'overrides'}/`],
	};
};

/**
 * A bare zip of jars carries no version, no loader and no provenance. It is laid into the mods
 * directory and left unmanaged, because nothing in it says what it is.
 */
const fromModsZip = async (path, { name, minecraft, loader }) => {
	if (minecraft === undefined) {
		throw new Error(`${basename(path)} is a plain zip of jars and names no version. Pass --minecraft.`);
	}

	return {
		manifest: {
			name: name ?? nameFrom(path),
			minecraft,
			loader: loader ?? { type: 'fabric' },
			mods: [],
		},
		// Every jar goes to mods/, wherever it sat in the zip.
		flattenJarsTo: 'mods',
	};
};

const READERS = { mrpack: fromMrpack, curseforge: fromCurseForge, mods: fromModsZip };

export const readPack = async (path, options = {}) => {
	const kind = await detectPack(path);

	step(`Reading ${kind === 'mods' ? 'mods archive' : `${kind} pack`} ${basename(path)}`);

	return { kind, ...(await READERS[kind](path, options)) };
};

/** Lay a pack's own files into the game directory, after the instance has been created. */
export const unpackInto = async (path, pack, gameDir) => {
	await mkdir(gameDir, { recursive: true });

	if (pack.flattenJarsTo) {
		const target = join(gameDir, pack.flattenJarsTo);

		await mkdir(target, { recursive: true });

		const jars = (await listEntries(path)).filter(entry => entry.endsWith('.jar'));

		for (const jar of jars) await extractArchive(path, target, { prefix: jar.replace(/[^/]+$/, '') });

		return jars.map(jar => basename(jar));
	}

	const written = [];

	for (const prefix of pack.overridePrefixes ?? []) written.push(...(await unpackOverrides(path, gameDir, prefix)));

	return written;
};


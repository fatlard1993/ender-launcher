import { mkdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { extractArchive, listEntries, readEntry, readEntryJson } from '../archive';
import { detail, plural, step } from '../out';
import { ENDER_PACK, GAME_FILES, parseEnderPack } from './enderPack';
import { packwizMetafiles, packwizMod, packwizPack } from './packwiz';

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

/** Where an archive keeps a file named this: at its root, or in the one folder a repository's zip unpacks to. */
const atTop = (entries, name) =>
	entries.find(entry => entry === name || (entry.split('/').length === 2 && entry.endsWith(`/${name}`)));

const enderPackIn = entries => atTop(entries, ENDER_PACK);

/** What kind of thing was handed to `import`, decided by looking inside rather than by extension. */
export const detectPack = async path => {
	if (path.endsWith('.json')) return 'ender';

	const entries = await listEntries(path);

	if (enderPackIn(entries)) return 'ender';
	if (atTop(entries, 'pack.toml')) return 'packwiz';

	if (entries.includes(MRPACK_INDEX)) return 'mrpack';
	if (entries.includes(CURSEFORGE_MANIFEST)) return 'curseforge';
	if (entries.some(entry => entry.endsWith('.jar'))) return 'mods';

	throw new Error(`Not a modpack: ${path}`);
};

const unpackOverrides = async (path, gameDir, prefix, keep) => {
	const written = await extractArchive(path, gameDir, { prefix, keep });

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

const isGameFile = relative =>
	GAME_FILES.some(file => (file.endsWith('/') ? relative.startsWith(file) : relative === file));

/**
 * An ender pack lists the mods it chose by spec, which the caller resolves against the index; what they need is
 * resolved on sync. In a zip, the game's own files beside the pack file are its overrides, and nothing else there.
 */
const fromEnder = async (path, { name }) => {
	const alone = path.endsWith('.json');
	const file = alone ? undefined : enderPackIn(await listEntries(path));
	const source = alone ? await Bun.file(path).text() : (await readEntry(path, file)).toString('utf8');
	const pack = parseEnderPack(source, { file: alone ? basename(path) : `${basename(path)}!${file}` });

	return {
		manifest: {
			name: name ?? pack.name ?? nameFrom(path),
			minecraft: pack.minecraft,
			loader: { type: pack.loader },
			mods: [],
		},
		specs: pack.mods,
		summary: pack.summary,
		overridePrefixes: alone ? [] : [file.slice(0, -ENDER_PACK.length)],
		keepOverride: isGameFile,
	};
};

/**
 * A packwiz pack keeps a file per mod beside its pack.toml, listed by its index: each becomes an entry, a Modrinth or
 * CurseForge one where it names one. As for an ender pack, the game's own files beside it are its overrides.
 */
const fromPackwiz = async (path, { name, side = 'client' }) => {
	const file = atTop(await listEntries(path), 'pack.toml');
	const folder = file.slice(0, -'pack.toml'.length);
	const text = async inside => (await readEntry(path, `${folder}${inside}`))?.toString('utf8');
	const pack = packwizPack(await text('pack.toml'), { file: `${basename(path)}!${file}` });
	const index = await text(pack.index);

	if (index === undefined) throw new Error(`${basename(path)} has no ${pack.index}, which its pack.toml names`);

	const entries = await listEntries(path);
	const listed = packwizMetafiles(index);
	const metafiles =
		listed.length > 0
			? listed
			: entries
					.filter(entry => entry.startsWith(folder) && entry.endsWith('.pw.toml'))
					.map(entry => entry.slice(folder.length));

	if (listed.length === 0 && metafiles.length > 0)
		detail(
			'index',
			`${pack.index} lists no mods, so every .pw.toml beside it is read, as packwiz refresh would list them`,
		);

	const mods = [];

	for (const metafile of metafiles) {
		const source = await text(metafile);

		if (source === undefined) throw new Error(`${basename(path)} has no ${metafile}, which its index lists`);

		const entry = packwizMod(source, { side });

		if (entry) mods.push(entry);
	}

	return {
		manifest: { name: name ?? pack.name ?? nameFrom(path), minecraft: pack.minecraft, loader: pack.loader, mods },
		overridePrefixes: [folder],
		keepOverride: isGameFile,
	};
};

const READERS = {
	mrpack: fromMrpack,
	curseforge: fromCurseForge,
	mods: fromModsZip,
	ender: fromEnder,
	packwiz: fromPackwiz,
};

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

	for (const prefix of pack.overridePrefixes ?? [])
		written.push(...(await unpackOverrides(path, gameDir, prefix, pack.keepOverride)));

	return written;
};

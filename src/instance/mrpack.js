import { join } from 'node:path';

import { KINDS } from '../mods/assets';
import { readMods } from '../mods/metadata';
import { writeZip } from '../zipWriter';

/** Where a Modrinth pack may send a launcher for a file; Modrinth hosts no pack that points anywhere else. */
export const MRPACK_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];

/** How a Modrinth pack names each loader among its dependencies. */
const LOADER_KEYS = { fabric: 'fabric-loader', quilt: 'quilt-loader', forge: 'forge', neoforge: 'neoforge' };

const hashed = (algorithm, bytes) => new Bun.CryptoHasher(algorithm).update(bytes).digest('hex');

/** The sides a jar's own metadata says it runs on, as a Modrinth pack's env says them. */
const sidesOf = async path => {
	const mods = await readMods(path).catch(() => []);
	const all = side => mods.length > 0 && mods.every(mod => mod.environment === side);

	if (all('client')) return { client: 'required', server: 'unsupported' };
	if (all('server')) return { client: 'unsupported', server: 'required' };

	return { client: 'required', server: 'required' };
};

/**
 * An instance as a Modrinth pack, from what it has installed: each mod, resource pack and shader pack by the link it
 * came from, with the sha1 and sha512 of the file on disk, and on the sides its jar says; an optional one a player
 * turned on stays optional. The files a pack laid down beside its list go in overrides. Answers the archive, what
 * could not be listed, and the links outside where a Modrinth pack may point.
 */
export const mrpackFrom = async ({ manifest, lock, version, summary }) => {
	const optional = new Set(
		['mods', ...KINDS].flatMap(kind =>
			(manifest[kind] ?? []).filter(entry => entry.optional).map(entry => `${entry.source}:${entry.id ?? entry.url}`),
		),
	);
	const files = [];
	const left = [];
	const outside = [];
	const list = async (folder, item, env) => {
		if (!/^https:\/\//.test(item.url ?? '')) {
			left.push(item.filename);

			return;
		}

		const path = join(manifest.gameDir, folder, item.filename);
		const file = Bun.file(path);

		if (!(await file.exists())) {
			left.push(item.filename);

			return;
		}

		const bytes = new Uint8Array(await file.arrayBuffer());
		const sides = optional.has(item.key)
			? Object.fromEntries(Object.entries(env).map(([side, need]) => [side, need === 'required' ? 'optional' : need]))
			: env;

		if (!MRPACK_HOSTS.includes(new URL(item.url).hostname)) outside.push(item.filename);

		files.push({
			path: `${folder}/${item.filename}`,
			hashes: { sha1: hashed('sha1', bytes), sha512: hashed('sha512', bytes) },
			env: sides,
			downloads: [item.url],
			fileSize: bytes.length,
		});
	};

	for (const mod of lock.mods ?? [])
		await list('mods', mod, await sidesOf(join(manifest.gameDir, 'mods', mod.filename)));

	for (const kind of KINDS) {
		for (const item of lock.assets?.[kind] ?? []) await list(kind, item, { client: 'required', server: 'unsupported' });
	}

	const overrides = [];

	for (const inner of Object.keys(lock.overrides ?? {})) {
		const file = Bun.file(join(manifest.gameDir, inner));

		if (await file.exists())
			overrides.push({ name: `overrides/${inner}`, bytes: new Uint8Array(await file.arrayBuffer()) });
	}

	const loader = LOADER_KEYS[manifest.loader?.type];
	const index = {
		formatVersion: 1,
		game: 'minecraft',
		versionId: version ?? manifest.pack?.version ?? '1.0.0',
		name: manifest.name,
		...(summary ? { summary } : {}),
		files,
		dependencies: {
			minecraft: manifest.minecraft,
			...(loader && manifest.loader.version ? { [loader]: manifest.loader.version } : {}),
		},
	};

	return {
		archive: writeZip([
			{ name: 'modrinth.index.json', bytes: new TextEncoder().encode(`${JSON.stringify(index, null, '\t')}\n`) },
			...overrides,
		]),
		index,
		left,
		outside,
	};
};

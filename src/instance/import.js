import { readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { fetchWithRetry, sha1 } from '../download';
import { assertKnownLoader } from '../meta/resolve';
import { readJson } from '../json';

const LOADER_UIDS = {
	'net.fabricmc.fabric-loader': 'fabric',
	'org.quiltmc.quilt-loader': 'quilt',
	'net.minecraftforge': 'forge',
	'net.neoforged': 'neoforge',
};

/** Prism's instance.cfg is a flat INI; only the [General] keys carry settings worth adopting. */
const parseConfig = text => {
	const values = {};

	for (const line of text.split('\n')) {
		const trimmed = line.trim();

		if (trimmed === '' || trimmed.startsWith('[') || trimmed.startsWith('#')) continue;

		const index = trimmed.indexOf('=');

		if (index === -1) continue;

		values[trimmed.slice(0, index)] = trimmed.slice(index + 1).replace(/^"|"$/g, '');
	}

	return values;
};

/** Ask Modrinth what these jars are, so an existing mods folder becomes a declared list. */
export const identifyMods = async modsDirectory => {
	const files = (await readdir(modsDirectory).catch(() => [])).filter(file => file.endsWith('.jar'));

	if (files.length === 0) return { entries: [], unmatched: [] };

	const hashes = await Promise.all(files.map(async file => [file, await sha1(join(modsDirectory, file))]));

	const response = await fetchWithRetry('https://api.modrinth.com/v2/version_files', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ hashes: hashes.map(([, hash]) => hash), algorithm: 'sha1' }),
	});

	const matches = await response.json();
	const entries = [];
	const unmatched = [];

	for (const [file, hash] of hashes) {
		const match = matches[hash];

		if (match === undefined) unmatched.push(file);
		else entries.push({ source: 'modrinth', id: match.project_id, version: match.version_number });
	}

	return { entries, unmatched };
};

/**
 * Read a Prism instance into our own shape.
 *
 * The game directory is followed to its real location, because an instance whose `.minecraft` is a
 * symlink into a working tree is pointing at the truth, not at itself.
 */
export const fromPrism = async (directory, { name } = {}) => {
	const pack = await readJson(join(directory, 'mmc-pack.json'), undefined).catch(() => undefined);

	if (pack === undefined) throw new Error(`Not a Prism instance (no mmc-pack.json): ${directory}`);

	const config = parseConfig(
		await Bun.file(join(directory, 'instance.cfg'))
			.text()
			.catch(() => ''),
	);

	const components = Object.fromEntries(pack.components.map(component => [component.uid, component.version]));
	const minecraft = components['net.minecraft'];

	if (minecraft === undefined) throw new Error(`No Minecraft component in ${directory}`);

	const loaderUid = Object.keys(LOADER_UIDS).find(uid => components[uid]);

	const loader = loaderUid ? { type: LOADER_UIDS[loaderUid], version: components[loaderUid] } : { type: 'vanilla' };

	assertKnownLoader(loader);

	const gameDir = await realpath(join(directory, '.minecraft')).catch(() => join(directory, '.minecraft'));

	const { entries, unmatched } = await identifyMods(join(gameDir, 'mods'));

	return {
		manifest: {
			name: name ?? config.name ?? basename(directory),
			type: 'client',
			minecraft,
			loader,
			gameDir,
			memory:
				config.OverrideMemory === 'true'
					? { min: Number(config.MinMemAlloc), max: Number(config.MaxMemAlloc) }
					: undefined,
			jvmArgs: config.OverrideJavaArgs === 'true' && config.JvmArgs ? config.JvmArgs.split(/\s+/) : [],
			env: {},
			mods: entries,
		},
		unmatched,
	};
};

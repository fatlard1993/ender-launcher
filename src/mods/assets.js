import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureFile } from '../download';
import { detail, plural, step, warn } from '../out';
import { entryKey, resolveEntry } from './index';

/**
 * What an instance holds beside its mods, by the folder of the game directory each goes in. Neither is tied to a
 * loader, so each is resolved for the game version alone.
 */
export const KINDS = ['resourcepacks', 'shaderpacks'];

/** The sources a resource or shader pack comes from: the index lists mods alone. */
export const ASSET_SOURCES = new Set(['modrinth', 'curseforge', 'url']);

/** The kind a pack's file is by the folder its path names, or undefined for a mod or anything else. */
export const kindOfPath = path => KINDS.find(kind => path.startsWith(`${kind}/`));

const OPTIONS_PACKS = /^resourcePacks:(.*)$/m;

/**
 * Turn on resource packs the instance just gained, after those already on, as the game's own options list them. Packs
 * a player turned off stay off: only ones new to the instance are added. Absent, options.txt is begun with the list,
 * and the game fills in the rest on its first start.
 */
export const enableResourcePacks = async (gameDir, filenames) => {
	if (filenames.length === 0) return;

	const file = Bun.file(join(gameDir, 'options.txt'));
	const text = (await file.exists()) ? await file.text() : '';
	const listed = (() => {
		try {
			return JSON.parse(text.match(OPTIONS_PACKS)?.[1] ?? '["vanilla"]');
		} catch {
			return ['vanilla'];
		}
	})();
	const wanted = [...listed, ...filenames.map(name => `file/${name}`).filter(name => !listed.includes(name))];
	const line = `resourcePacks:${JSON.stringify(wanted)}`;

	await Bun.write(
		file,
		OPTIONS_PACKS.test(text)
			? text.replace(OPTIONS_PACKS, line)
			: `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`,
	);
};

/**
 * Choose a shader pack the instance just gained for Iris, only when Iris has no settings yet: a player who picked
 * another, or turned shaders off, keeps that.
 */
export const chooseShaderPack = async (gameDir, filename) => {
	const file = Bun.file(join(gameDir, 'config', 'iris.properties'));

	if (filename === undefined || (await file.exists())) return;

	await Bun.write(file, `shaderPack=${filename}\nenableShaders=true\n`);
};

/**
 * Bring an instance's resource and shader packs to what it declares: each resolved for its game version, fetched and
 * checked into its folder. A file ender put there for an entry no longer declared is removed; a player's own files
 * there are never touched. Packs new to the instance are turned on. Answers the lock to keep, and what happened.
 */
export const syncAssets = async ({ manifest, lock, context, resolve = resolveEntry, fetchFile = ensureFile }) => {
	const kept = {};
	const failures = [];
	const installed = [];
	const removed = [];

	for (const kind of KINDS) {
		const directory = join(manifest.gameDir, kind);
		const previous = lock?.assets?.[kind] ?? [];
		const known = new Set(previous.map(item => item.filename));
		const now = [];

		for (const entry of manifest[kind] ?? []) {
			try {
				const resolution = await resolve(entry, { ...context, loader: undefined });
				const { filename, url, checksum, size } = resolution.file;

				await fetchFile({ url, path: join(directory, filename), checksum, size });
				now.push({ key: entryKey(entry), filename, version: resolution.version });

				if (!known.has(filename)) installed.push({ kind, filename });
			} catch (error) {
				const held = previous.find(item => item.key === entryKey(entry));

				failures.push({ kind, key: entryKey(entry), error: error.message });

				// Kept as it was: a pack that cannot be reached now is not taken away
				if (held) now.push(held);
			}
		}

		const wanted = new Set(now.map(item => item.filename));

		for (const stale of previous.filter(item => !wanted.has(item.filename))) {
			await unlink(join(directory, stale.filename)).catch(() => {});
			removed.push({ kind, filename: stale.filename });
		}

		if (now.length > 0 || previous.length > 0) kept[kind] = now;
	}

	await enableResourcePacks(
		manifest.gameDir,
		installed.filter(item => item.kind === 'resourcepacks').map(item => item.filename),
	);
	await chooseShaderPack(manifest.gameDir, installed.find(item => item.kind === 'shaderpacks')?.filename);

	return { assets: kept, installed, removed, failures };
};

const NAMES = { resourcepacks: 'resource pack', shaderpacks: 'shader pack' };

/** Say what an asset sync did, in the words a mod sync uses: how many of each are in place, then each change. */
export const reportAssets = ({ assets, installed, removed, failures }) => {
	const counts = KINDS.filter(kind => assets?.[kind]?.length > 0).map(kind => plural(assets[kind].length, NAMES[kind]));

	if (counts.length > 0) step(`${counts.join(', ')} in place`);

	for (const { kind, filename } of installed) detail(kind, `${filename} installed`);
	for (const { kind, filename } of removed) detail(kind, `${filename} removed`);
	for (const { kind, key, error } of failures) warn(`${kind}: ${key} could not be installed: ${error}`);
};

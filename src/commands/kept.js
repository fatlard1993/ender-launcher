import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { done, info, paint, warn } from '../out';
import { paths } from '../paths';

const sizeOf = async path => {
	const found = await stat(path).catch(() => undefined);

	if (!found?.isDirectory()) return found?.size ?? 0;

	let total = 0;

	for (const entry of await readdir(path)) total += await sizeOf(join(path, entry));

	return total;
};

const readable = bytes => {
	const units = ['B', 'KB', 'MB', 'GB'];
	let size = bytes;
	let unit = 0;

	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit++;
	}

	return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

/** The game directories deleted instances left behind, oldest first. */
export const keptFolders = async () => (await readdir(paths.kept).catch(() => [])).toSorted();

export const list = async ({ flags = {} } = {}) => {
	const folders = await keptFolders();

	if (flags.names) {
		for (const folder of folders) info(folder);

		return 0;
	}

	if (folders.length === 0) {
		info('Nothing kept: a deleted instance leaves its game directory here, worlds included.');

		return 0;
	}

	for (const folder of folders) {
		info(`${paint.bold(folder.padEnd(48))} ${readable(await sizeOf(join(paths.kept, folder)))}`);
	}

	info(paint.dim(`  in ${paths.kept}`));
	info(paint.dim('  ender kept remove <folder> removes one, worlds and all; --all removes every one'));

	return 0;
};

export const remove = async ({ positionals, flags }) => {
	const folders = await keptFolders();
	const chosen = flags.all ? folders : positionals.filter(folder => folders.includes(folder));
	const unknown = positionals.filter(folder => !folders.includes(folder));

	if (unknown.length > 0) throw new Error(`Nothing kept as ${unknown.join(', ')}; ender kept lists what is`);
	if (chosen.length === 0) throw new Error('ender kept remove <folder>... or --all');

	if (!flags.yes) {
		warn(`This deletes ${chosen.length === 1 ? chosen[0] : `${chosen.length} kept game directories`}, worlds and all.`);
		info('  Pass --yes to go ahead.');

		return 1;
	}

	for (const folder of chosen) await rm(join(paths.kept, folder), { recursive: true, force: true });

	done(`Removed ${chosen.length === 1 ? chosen[0] : `${chosen.length} kept game directories`}`);

	return 0;
};

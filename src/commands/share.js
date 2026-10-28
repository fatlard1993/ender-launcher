import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { modsDir } from '../instance';
import { readMods } from '../mods/metadata';
import { done, info, paint, warn } from '../out';
import { parseModSpec, targetInstance } from './context';

export const SHARE_PAGE = 'https://fatlard1993.github.io/ender-index/';

const REPOSITORY_SOURCES = new Set(['github', 'codeberg', 'gitlab']);

/** A mod as the share page takes it: a repository by the index's key for it, anything else by its id. */
export const shareKey = spec => {
	const { source, id } = parseModSpec(spec);

	return REPOSITORY_SOURCES.has(source) ? `${source}:${id}` : id;
};

/** The share page, with the mods a shot shows already chosen and the rest of the instance's offered. */
export const shareUrl = (chosen, offered) => {
	const params = new URLSearchParams();

	for (const mod of chosen) params.append('mod', mod);
	for (const mod of offered.filter(mod => !chosen.includes(mod))) params.append('from', mod);

	return `${SHARE_PAGE}?${params}#/share`;
};

/** The ids of the mods in a mods folder's jars, and the repositories the manifest installs from by key. */
const instanceMods = async manifest => {
	const folder = modsDir(manifest);
	const jars = (await readdir(folder).catch(() => [])).filter(file => file.endsWith('.jar'));
	const ids = (await Promise.all(jars.map(jar => readMods(join(folder, jar)).catch(() => []))))
		.flat()
		.map(mod => mod.id);
	const repositories = (manifest.mods ?? [])
		.filter(mod => REPOSITORY_SOURCES.has(mod.source))
		.map(mod => `${mod.source}:${mod.id}`);

	return [...new Set([...repositories, ...ids.filter(Boolean)])];
};

/** The newest picture in the instance's screenshots folder, which F2 saves to. */
const newestScreenshot = async manifest => {
	const folder = join(manifest.gameDir, 'screenshots');
	const files = (await readdir(folder).catch(() => [])).filter(file => /\.(png|jpe?g|webp)$/i.test(file));
	const dated = await Promise.all(files.map(async file => ({ file, at: (await stat(join(folder, file))).mtimeMs })));

	const [newest] = dated.toSorted((a, b) => b.at - a.at);

	return newest && join(folder, newest.file);
};

const OPENERS = { darwin: ['open'], win32: ['cmd', '/c', 'start', ''] };

const openInBrowser = async url => {
	try {
		const opened = Bun.spawn([...(OPENERS[process.platform] ?? ['xdg-open']), url], {
			stdout: 'ignore',
			stderr: 'ignore',
		});

		return (await opened.exited) === 0;
	} catch {
		return false;
	}
};

/** Open the index's share page for a shot of this instance: the mods named chosen, the rest offered. */
export const share = async ({ positionals, flags }) => {
	const { manifest } = await targetInstance(flags.instance);
	const chosen = positionals.map(shareKey);
	const url = shareUrl(chosen, await instanceMods(manifest));
	const screenshot = await newestScreenshot(manifest);

	if (screenshot) info(`Newest screenshot  ${screenshot}`);
	else info(paint.dim(`No screenshots in ${manifest.name} yet: F2 in game saves one`));

	if (flags.print || !(await openInBrowser(url))) {
		if (!flags.print) warn('No browser opened; the page is at');
		process.stdout.write(`${url}\n`);

		return 0;
	}

	done(`Opened the share page for ${manifest.name}`);

	return 0;
};

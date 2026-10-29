import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { openInBrowser } from '../browser';
import { done, info, paint, warn } from '../out';
import { parseModSpec, targetInstance } from './context';

/** The index's issue forms, for a shot or a pack, which a player fills in with their GitHub account. */
export const SHARE_FORM = 'https://github.com/fatlard1993/ender-index/issues/new';

const REPOSITORY_SOURCES = new Set(['github', 'codeberg', 'gitlab']);

/** A mod as the share form takes it: a repository by the index's key for it, anything else by its id. */
export const shareKey = spec => {
	const { source, id } = parseModSpec(spec);

	return REPOSITORY_SOURCES.has(source) ? `${source}:${id}` : id;
};

/** The share form, with the mods a shot shows filled in. */
export const shareUrl = mods => `${SHARE_FORM}?${new URLSearchParams({ template: 'shot.yml', mods: mods.join('\n') })}`;

/** The form that asks the index to list a published pack, which it cannot find in a gist on its own. */
export const listPackUrl = link => `${SHARE_FORM}?${new URLSearchParams({ template: 'pack.yml', pack: link })}`;

/** The newest picture in the instance's screenshots folder, which F2 saves to. */
const newestScreenshot = async manifest => {
	const folder = join(manifest.gameDir, 'screenshots');
	const files = (await readdir(folder).catch(() => [])).filter(file => /\.(png|jpe?g|webp)$/i.test(file));
	const dated = await Promise.all(files.map(async file => ({ file, at: (await stat(join(folder, file))).mtimeMs })));

	const [newest] = dated.toSorted((a, b) => b.at - a.at);

	return newest && join(folder, newest.file);
};

/** Open the index's form for sharing a shot of this instance, with the mods named filled in. */
export const share = async ({ positionals, flags }) => {
	const { manifest } = await targetInstance(flags.instance);
	const url = shareUrl(positionals.map(shareKey));
	const screenshot = await newestScreenshot(manifest);

	if (screenshot) info(`Newest screenshot  ${screenshot}`);
	else info(paint.dim(`No screenshots in ${manifest.name} yet: F2 in game saves one`));

	if (flags.print || !(await openInBrowser(url))) {
		if (!flags.print) warn('No browser opened; the share form is at');
		process.stdout.write(`${url}\n`);

		return 0;
	}

	done('Opened the share form: drag the screenshot in, and tell its story');

	return 0;
};

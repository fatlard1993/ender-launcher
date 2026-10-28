import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { readConfig } from '../config';
import { fetchJson, fetchWithRetry } from '../download';
import * as instances from '../instance';
import { ENDER_PACK } from '../instance/enderPack';
import { detectPack, readPack } from '../instance/pack';
import { LOADER_SERVICES } from '../meta/resolve';
import { entryKey } from '../mods';
import { newestAsset } from '../mods/github';
import { step } from '../out';
import { paths } from '../paths';
import { parseModSpec, refineModSpec } from './context';

/** A repository named as `gh:owner/repo`. */
export const REPOSITORY = /^(?:gh:|github:)([\w.-]+\/[\w.-]+)$/;

/** A gist by `gist:id`, `gist:owner/id`, or any of its links: its page, or a raw file at any revision. */
const GIST =
	/^(?:gist:(?:[\w-]+\/)?|https:\/\/gist\.github(?:usercontent)?\.com\/(?:[\w-]+\/)?)([\da-f]{20,40})(?:[/?#].*)?$/i;

export const gistOf = target => target.match(GIST)?.[1]?.toLowerCase();

/**
 * Where a pack is read from again to update an instance made from it: a gist by its id, whose newest revision is read
 * whichever link was given, a repository by name, a link as it is, and a file by its full path.
 */
export const sourceOf = target => {
	const gist = gistOf(target);

	if (gist) return `gist:${gist}`;
	if (REPOSITORY.test(target) || /^https?:\/\//.test(target)) return target;

	return resolve(target);
};

/** Whether import fetches this rather than reading it from disk. */
export const isRemote = target => Boolean(gistOf(target)) || REPOSITORY.test(target) || /^https?:\/\//.test(target);

const download = async (url, name) => {
	const path = join(paths.cache, 'packs', name);

	step(`Downloading ${url}`);

	const response = await fetchWithRetry(url);

	await mkdir(join(paths.cache, 'packs'), { recursive: true });
	await Bun.write(path, response);

	return path;
};

/**
 * A repository's pack: the ender pack or packwiz pack at the head of its default branch, as GitHub zips it, and
 * otherwise the newest release's .mrpack.
 */
const repositoryPack = async repository => {
	const head = await download(
		`https://github.com/${repository}/archive/HEAD.zip`,
		`${repository.replace('/', '-')}.zip`,
	);

	if (['ender', 'packwiz'].includes(await detectPack(head).catch(() => undefined))) return head;

	const asset = await newestAsset(repository, '.mrpack', (await readConfig()).githubToken);

	if (asset === undefined) {
		throw new Error(
			`${repository} has no ${ENDER_PACK} or pack.toml at its root, and none of its releases carries a .mrpack`,
		);
	}

	return download(asset.browser_download_url, asset.name);
};

/**
 * A gist's ender pack, read through GitHub's API: a raw link is cached for minutes after an edit, and the API answers
 * with the newest revision. The pack is the gist's ender.pack.json, or its only JSON file.
 */
const gistPack = async id => {
	const { githubToken } = await readConfig();

	step(`Reading gist ${id}`);

	const gist = await fetchJson(`https://api.github.com/gists/${id}`, {
		headers: {
			accept: 'application/vnd.github+json',
			...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
		},
	});
	const files = Object.values(gist.files ?? {});
	const json = files.filter(file => file.filename.endsWith('.json'));
	const file = files.find(found => found.filename === ENDER_PACK) ?? (json.length === 1 ? json[0] : undefined);

	if (file === undefined) throw new Error(`Gist ${id} has no ${ENDER_PACK}, nor one JSON file to take for it`);

	const content = file.truncated ? await (await fetchWithRetry(file.raw_url)).text() : file.content;
	const path = join(paths.cache, 'packs', `gist-${id}.json`);

	await mkdir(join(paths.cache, 'packs'), { recursive: true });
	await Bun.write(path, content);

	return path;
};

/** A pack named by a gist, a link or a GitHub repository, downloaded where import reads files from. */
export const fetchPack = target => {
	const gist = gistOf(target);
	const repository = target.match(REPOSITORY)?.[1];

	if (gist) return gistPack(gist);
	if (repository) return repositoryPack(repository);

	return download(target, basename(new URL(target).pathname) || 'pack.zip');
};

/**
 * An ender pack's specs as the entries `ender add` would make of them, every one or none: a pack whose mods cannot
 * all be placed is refused with each that could not, rather than made into an instance missing them.
 */
export const resolveSpecs = async (specs, config) => {
	const entries = [];
	const failed = [];

	for (const { spec, version } of specs) {
		try {
			entries.push(await refineModSpec(parseModSpec(version ? `${spec}@${version}` : spec), { index: config.index }));
		} catch (error) {
			failed.push(`  ${spec}: ${error.message}`);
		}
	}

	if (failed.length > 0) throw new Error(`The pack names mods that cannot be placed:\n${failed.join('\n')}`);

	return entries;
};

/**
 * The instance's mods after its pack's newest word: what the pack names now, as it pins it, and the mods added beside
 * it kept. A mod the pack dropped goes; one added beside the pack that the pack now names becomes the pack's. A new
 * game version or loader in the pack moves the instance to it. Files the pack carries beside its list are laid down
 * on import alone, so a setting changed in game is not undone at every update.
 */
export const refreshFromPack = async (manifest, config) => {
	const local = !isRemote(manifest.pack.source);
	const pack = await readPack(local ? manifest.pack.source : await fetchPack(manifest.pack.source), {
		name: manifest.name,
	});

	if (pack.kind !== 'ender') throw new Error(`${manifest.pack.source} is no longer an ender pack, but ${pack.kind}`);

	const entries = await resolveSpecs(pack.specs, config);
	const before = new Set(manifest.pack.mods);
	const named = new Map(entries.map(entry => [entryKey(entry), entry]));
	const beside = manifest.mods.filter(entry => !before.has(entryKey(entry)) && !named.has(entryKey(entry)));
	const changes = {
		added: [...named.keys()].filter(key => !before.has(key)),
		dropped: [...before].filter(key => !named.has(key)),
	};
	const { minecraft, loader } = pack.manifest;

	if (minecraft !== manifest.minecraft || loader.type !== manifest.loader?.type) {
		changes.moved = `Minecraft ${minecraft}, ${loader.type}`;
		manifest.minecraft = minecraft;
		manifest.loader = {
			type: loader.type,
			...(LOADER_SERVICES[loader.type] ? { version: await LOADER_SERVICES[loader.type].latestLoader(minecraft) } : {}),
		};
	}

	manifest.mods = [...entries, ...beside];
	manifest.pack = { ...manifest.pack, mods: [...named.keys()] };

	await instances.write(manifest);

	return changes;
};

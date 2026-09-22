import { chmod, mkdir, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureFile, fetchJson, pool } from './download';
import { checksumOf } from './download';
import { detail, plural, progress, step } from './out';
import { paths } from './paths';

const ALL_RUNTIMES =
	'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

const PLATFORMS = {
	'linux-x64': 'linux',
	'linux-ia32': 'linux-i386',
	'darwin-x64': 'mac-os',
	'darwin-arm64': 'mac-os-arm64',
	'win32-x64': 'windows-x64',
	'win32-ia32': 'windows-x86',
	'win32-arm64': 'windows-arm64',
};

export const platformKey = () => PLATFORMS[`${process.platform}-${process.arch}`];

let catalogue;

const allRuntimes = async () => (catalogue ??= await fetchJson(ALL_RUNTIMES));

/** Which runtimes Mojang publishes for this machine, newest version of each component. */
export const publishedRuntimes = async () => {
	const platform = platformKey();

	if (platform === undefined) return {};

	const entries = Object.entries((await allRuntimes())[platform] ?? {});

	return Object.fromEntries(
		entries.filter(([, builds]) => builds.length > 0).map(([component, [build]]) => [component, build]),
	);
};

export const runtimeHome = component => join(paths.java, component);

export const runtimeBinary = component =>
	join(runtimeHome(component), process.platform === 'darwin' ? 'jre.bundle/Contents/Home/bin/java' : 'bin/java');

export const isInstalled = async component => Bun.file(runtimeBinary(component)).exists();

/**
 * Fetch one of Mojang's own Java runtimes into our own directory.
 *
 * The manifest offers each file both raw and lzma-compressed; raw is taken so nothing here needs a
 * decompressor. Directories, symlinks and the executable bit all come from the manifest rather
 * than from guessing at the layout.
 */
export const installRuntime = async component => {
	const published = await publishedRuntimes();
	const build = published[component];

	if (build === undefined) {
		throw new Error(`Mojang publishes no "${component}" runtime for ${platformKey() ?? process.platform}`);
	}

	step(`Installing Java runtime ${component} (${build.version.name})`);

	const home = runtimeHome(component);
	const { files } = await fetchJson(build.manifest.url);
	const entries = Object.entries(files);

	for (const [relative, entry] of entries) {
		if (entry.type === 'directory') await mkdir(join(home, relative), { recursive: true });
	}

	const downloads = entries.filter(([, entry]) => entry.type === 'file' && entry.downloads?.raw);
	const bar = progress();

	await pool(
		downloads,
		async ([relative, entry]) => {
			const path = join(home, relative);

			await ensureFile({
				url: entry.downloads.raw.url,
				path,
				checksum: checksumOf(entry.downloads.raw.sha1),
				size: entry.downloads.raw.size,
			});

			if (entry.executable) await chmod(path, 0o755);
		},
		{ concurrency: 12, onProgress: (finished, total) => bar.update(`   java ${finished}/${total}`) },
	);

	bar.clear();

	for (const [relative, entry] of entries) {
		if (entry.type !== 'link') continue;

		const path = join(home, relative);

		await unlink(path).catch(() => {});
		await symlink(entry.target, path);
	}

	detail('java runtime', `${plural(downloads.length, 'file')} into ${home}`);

	return runtimeBinary(component);
};

/** The managed runtime for a component, installing it first if it is not already here. */
export const provideRuntime = async component => {
	if (await isInstalled(component)) return runtimeBinary(component);

	return installRuntime(component);
};

export const installedRuntimes = async () => {
	const found = [];

	for (const component of Object.keys(await publishedRuntimes().catch(() => ({})))) {
		if (await isInstalled(component)) found.push({ component, path: runtimeBinary(component) });
	}

	return found;
};

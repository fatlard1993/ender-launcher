import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { extractArchive } from './archive';
import { checksumOf, ensureFile, fetchJson } from './download';
import { step } from './out';
import { paths } from './paths';

const ADOPTIUM = 'https://api.adoptium.net/v3/assets/latest';

const SYSTEMS = { linux: 'linux', darwin: 'mac', win32: 'windows' };

const ARCHITECTURES = { x64: 'x64', arm64: 'aarch64' };

/** Adoptium's query for the newest Temurin JDK of a major, for a system and architecture as Node names them. */
export const adoptiumQuery = (major, platform = process.platform, arch = process.arch) => {
	if (SYSTEMS[platform] === undefined || ARCHITECTURES[arch] === undefined) {
		throw new Error(`Adoptium publishes no JDK ender knows how to fetch for ${platform}-${arch}`);
	}

	return `${ADOPTIUM}/${major}/hotspot?architecture=${ARCHITECTURES[arch]}&image_type=jdk&os=${SYSTEMS[platform]}&vendor=eclipse`;
};

/** Where a JDK unpacked into a directory keeps bin/: a macOS JDK is a bundle. */
export const jdkHomeIn = (directory, platform = process.platform) =>
	platform === 'darwin' ? join(directory, 'Contents', 'Home') : directory;

const jdkDirectory = major => join(paths.java, `jdk-${major}`);

const javac = home => join(home, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');

const unpack = async (archive, into) => {
	if (archive.endsWith('.zip')) {
		const [top] = (await extractArchive(archive, into)).map(path => path.split('/')[0]);

		return join(into, top);
	}

	const tar = Bun.spawn(['tar', '-xzf', archive, '-C', into], { stdout: 'ignore', stderr: 'pipe' });
	const said = await new Response(tar.stderr).text();

	if ((await tar.exited) !== 0) throw new Error(`tar could not unpack ${archive}: ${said.trim()}`);

	const [top] = await readdir(into);

	return join(into, top);
};

/**
 * A JDK of this major, fetched from Adoptium the first time one is wanted. The game runs on Mojang's own runtimes,
 * which have no compiler; building a mod from its source needs one.
 */
export const provideJdk = async major => {
	const home = jdkHomeIn(jdkDirectory(major));

	if (await Bun.file(javac(home)).exists()) return home;

	const [found] = await fetchJson(adoptiumQuery(major));

	if (found === undefined) throw new Error(`Adoptium lists no Java ${major} JDK for this system`);

	const { link, checksum, name, size } = found.binary.package;
	const archive = join(paths.cache, 'jdk', name);

	step(`Fetching a Java ${major} JDK from Adoptium, ${Math.round(size / 1024 / 1024)} MB, to build with`);
	await ensureFile({ url: link, path: archive, checksum: checksumOf(checksum, 'sha256'), size });

	const scratch = `${jdkDirectory(major)}.part`;

	await rm(scratch, { recursive: true, force: true });
	await mkdir(scratch, { recursive: true });
	await rm(jdkDirectory(major), { recursive: true, force: true });
	await rename(await unpack(archive, scratch), jdkDirectory(major));
	await rm(scratch, { recursive: true, force: true });

	if (!(await Bun.file(javac(home)).exists())) throw new Error(`The JDK from ${link} has no javac where one belongs`);

	return home;
};

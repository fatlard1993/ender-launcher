import { chmod, copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { extractArchive } from '../archive';
import { readConfig, updateConfig } from '../config';
import { ensureFile } from '../download';
import { provideJdk } from '../jdk';
import { versionMeta } from '../meta/mojang';
import { step } from '../out';
import { paths } from '../paths';
import { builtJar, readProperties } from './gradle';

/** Where each host serves a repository's files at one commit, as a zip. */
export const SOURCE_ZIPS = {
	github: (name, commit) => `https://codeload.github.com/${name}/zip/${commit}`,
	codeberg: (name, commit) => `https://codeberg.org/${name}/archive/${commit}.zip`,
	gitlab: (name, commit) => `https://gitlab.com/${name}/-/archive/${commit}/${name.split('/').at(-1)}-${commit}.zip`,
};

/** The Java a project builds with when the game version it names says nothing: what current Minecraft runs on. */
const DEFAULT_JAVA = 21;

const VARIANTS = /-(sources|testsupport|dev|javadoc|api|slim|shadow)\.jar$/i;

/** The jar a build left: the one its declared version names, or else the largest that is not a by-product. */
export const pickBuiltJar = async (directory, version) => {
	const named = version && (await builtJar(directory, version));

	if (named) return named;

	const libs = join(directory, 'build', 'libs');
	const jars = (await readdir(libs).catch(() => [])).filter(file => file.endsWith('.jar') && !VARIANTS.test(file));
	const sized = await Promise.all(jars.map(async file => ({ file, size: (await stat(join(libs, file))).size })));

	return sized.length > 0 ? join(libs, sized.toSorted((a, b) => b.size - a.size)[0].file) : undefined;
};

/**
 * Whether the player allowed building this repository: once allowed, its later commits build without asking again.
 * Building runs the project's own gradle scripts on this machine with the player's permissions, before the game runs
 * anything of it, so that is the player's to say, by name.
 */
export const allowBuilding = async (key, allowing) => {
	const { builds = [] } = await readConfig();

	if (builds.includes(key)) return true;
	if (!allowing) return false;

	await updateConfig({ builds: [...builds, key] });

	return true;
};

const javaFor = async minecraft =>
	minecraft ? ((await versionMeta(minecraft).catch(() => undefined))?.meta.javaVersion?.majorVersion ?? DEFAULT_JAVA) : DEFAULT_JAVA;

const fetchSource = async (host, name, commit, directory) => {
	const archive = join(paths.cache, 'sources', `${host}-${name.replaceAll('/', '-')}-${commit}.zip`);
	const unpacked = `${directory}.part`;

	await ensureFile({ url: SOURCE_ZIPS[host](name, commit), path: archive });
	await rm(unpacked, { recursive: true, force: true });

	const [first] = await extractArchive(archive, unpacked);

	await rm(directory, { recursive: true, force: true });
	await mkdir(dirname(directory), { recursive: true });
	await rename(join(unpacked, first.split('/')[0]), directory);
	await rm(unpacked, { recursive: true, force: true });
	await rm(archive, { force: true });
};

const runGradle = async (directory, javaHome, label) => {
	const windows = process.platform === 'win32';

	if (!windows) await chmod(join(directory, 'gradlew'), 0o755);

	const child = Bun.spawn(
		[...(windows ? ['cmd', '/c', 'gradlew.bat'] : ['./gradlew']), 'build', '-x', 'test', '--quiet', '--console=plain'],
		{ cwd: directory, env: { ...process.env, JAVA_HOME: javaHome }, stdout: 'pipe', stderr: 'pipe' },
	);
	const [out, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);

	if ((await child.exited) !== 0) {
		throw new Error(`${label} did not build:\n${(error || out).trim().split('\n').slice(-12).join('\n')}`);
	}
};

/**
 * A jar built from a repository's source at one commit, built once and kept: the zip of that commit from its host,
 * built by its own gradle wrapper with a JDK of the Java its game version runs on.
 */
export const buildFromSource = async ({ host, name, commit, minecraft }) => {
	const label = `${host}:${name}`;
	const built = join(paths.cache, 'builds', host, name, `${commit}.jar`);

	if (await Bun.file(built).exists()) return built;

	const directory = join(paths.cache, 'sources', host, name, commit);

	if (!(await Bun.file(join(directory, 'gradlew')).exists())) await fetchSource(host, name, commit, directory);

	const javaHome = await provideJdk(await javaFor(minecraft));

	step(
		`Building ${label} at ${commit.slice(0, 7)}; a first build fetches gradle and the game's code, and takes minutes`,
	);
	await runGradle(directory, javaHome, label);

	const jar = await pickBuiltJar(directory, (await readProperties(directory))?.mod_version);

	if (jar === undefined) throw new Error(`${label} built, but left no jar in build/libs`);

	await mkdir(dirname(built), { recursive: true });
	await copyFile(jar, built);

	return built;
};

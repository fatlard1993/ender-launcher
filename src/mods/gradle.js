import { chmod, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { detail, step } from '../out';

export const id = 'gradle';

export const label = 'Gradle project';

const VARIANTS = /-(sources|testsupport|dev|javadoc|slim|shadow)\.jar$/i;

/** A gradle.properties is a flat key=value file, with or without spaces around the sign. */
export const readProperties = async directory => {
	const text = await Bun.file(join(directory, 'gradle.properties'))
		.text()
		.catch(() => undefined);

	if (text === undefined) return undefined;

	const values = {};

	for (const line of text.split('\n')) {
		const trimmed = line.trim();

		if (trimmed === '' || trimmed.startsWith('#')) continue;

		const index = trimmed.indexOf('=');

		if (index !== -1) values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
	}

	return values;
};

export const isProject = async directory => (await readProperties(directory)) !== undefined;

/**
 * Find the jar a project's declared version corresponds to.
 *
 * The file name cannot be derived from the properties: some projects set `archives_base_name`,
 * others compute it from `mod_id` in a `base` block, and some append the author. What is reliable
 * is that a jar ends with its version, and that sources and testsupport jars put their classifier
 * after the version rather than before it. So the version identifies the build and nothing else
 * has to be assumed.
 */
export const builtJar = async (directory, version) => {
	const libs = join(directory, 'build', 'libs');
	const files = await readdir(libs).catch(() => []);
	const wanted = files.filter(file => file.endsWith(`-${version}.jar`) && !VARIANTS.test(file));

	if (wanted.length === 0) return undefined;

	return join(libs, wanted[0]);
};

/**
 * Run a project's own gradle wrapper, so it builds the way it does when built by hand: `gradlew.bat` through cmd on
 * Windows, `./gradlew` made executable elsewhere, with the JDK given as JAVA_HOME when one is.
 */
const runNow = async (directory, { javaHome, label, skipTests }) => {
	const windows = process.platform === 'win32';

	if (!windows) await chmod(join(directory, 'gradlew'), 0o755).catch(() => {});

	const child = Bun.spawn(
		[
			...(windows ? ['cmd', '/c', 'gradlew.bat'] : ['./gradlew']),
			'build',
			...(skipTests ? ['-x', 'test'] : []),
			'--quiet',
			'--console=plain',
		],
		{
			cwd: directory,
			env: javaHome ? { ...process.env, JAVA_HOME: javaHome } : process.env,
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const [out, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);

	if ((await child.exited) !== 0) {
		throw new Error(`${label} did not build:\n${(error || out).trim().split('\n').slice(-12).join('\n')}`);
	}
};

let building = Promise.resolve();

/**
 * One gradle run at a time, for a project on disk or a repository's source alike: mods resolve together, and a gradle
 * daemon apiece for each would take the machine.
 */
export const runGradle = (directory, { javaHome, label = basename(directory), skipTests = false } = {}) => {
	const turn = building.then(() => runNow(directory, { javaHome, label, skipTests }));

	building = turn.catch(() => {});

	return turn;
};

export const build = async directory => {
	step(`Building ${basename(directory)}`);

	await runGradle(directory);
};

export const resolve = async (entry, { minecraft, loader, buildMissing = false, rebuild = false } = {}) => {
	const directory = entry.path;
	const properties = await readProperties(directory);

	if (properties === undefined) throw new Error(`No gradle.properties in ${directory}`);

	const version = properties.mod_version;

	if (version === undefined) throw new Error(`${directory} declares no mod_version`);

	// The project states which game it is built against; disagreeing with the instance means the
	// jar would load into a version it was never compiled for.
	if (minecraft && properties.minecraft_version && properties.minecraft_version !== minecraft) {
		throw new Error(
			`${basename(directory)} is built for Minecraft ${properties.minecraft_version}, not ${minecraft}. Rebuild it or move the instance.`,
		);
	}

	if (loader && properties.loader_version === undefined && loader !== 'fabric') {
		detail('gradle', `${basename(directory)} names no loader; assuming it suits ${loader}`);
	}

	let jar = rebuild ? undefined : await builtJar(directory, version);

	if (jar === undefined && (buildMissing || rebuild)) {
		await build(directory);

		jar = await builtJar(directory, version);
	}

	if (jar === undefined) {
		throw new Error(`${basename(directory)} has no built jar for version ${version}. Run its gradlew build.`);
	}

	return {
		source: id,
		id: directory,
		name: `${basename(directory)} ${version}`,
		version,
		file: { filename: basename(jar), localPath: jar },
		dependencies: [],
	};
};

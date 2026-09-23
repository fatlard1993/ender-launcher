import { readdir } from 'node:fs/promises';
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

/** Run the project's own wrapper, so it builds the way it does when built by hand. */
export const build = async directory => {
	step(`Building ${basename(directory)}`);

	const process_ = Bun.spawn(['./gradlew', 'build', '--quiet', '--console=plain'], {
		cwd: directory,
		stdout: 'pipe',
		stderr: 'pipe',
	});

	const [out, error] = await Promise.all([new Response(process_.stdout).text(), new Response(process_.stderr).text()]);

	if ((await process_.exited) !== 0) {
		const said = (error || out).trim().split('\n').slice(-12).join('\n');

		throw new Error(`gradle build failed in ${directory}:\n${said}`);
	}
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

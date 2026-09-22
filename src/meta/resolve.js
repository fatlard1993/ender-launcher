import { join } from 'node:path';

import { checksumOf } from '../download';
import { paths } from '../paths';
import { fabric } from './fabric';
import { quilt } from './quilt';
import { forge, neoforge } from './forge-like';
import * as mojang from './mojang';
import { applicableArguments } from './rules';

/** Loaders mcm understands well enough to hold an instance and manage its mods. */
export const KNOWN_LOADERS = new Set(['fabric', 'quilt', 'forge', 'neoforge', 'vanilla']);

/**
 * The service that answers for each loader: what versions exist, and what a launch of one looks
 * like. Vanilla needs none, which is why it is not here and is still launchable.
 */
export const LOADER_SERVICES = { fabric, quilt, forge, neoforge };

export const LAUNCHABLE_LOADERS = new Set(['fabric', 'quilt', 'forge', 'neoforge', 'vanilla']);

export const isLaunchable = type => LAUNCHABLE_LOADERS.has(type ?? 'vanilla');

export const assertKnownLoader = loader => {
	const type = loader?.type ?? 'vanilla';

	if (KNOWN_LOADERS.has(type)) return type;

	throw new Error(`"${type}" is not a Minecraft loader mcm knows. It knows: ${[...KNOWN_LOADERS].join(', ')}.`);
};

export const assertLaunchableLoader = loader => {
	const type = assertKnownLoader(loader);

	if (isLaunchable(type)) return type;

	throw new Error(`mcm cannot build a ${type} launch. It builds: ${[...LAUNCHABLE_LOADERS].join(', ')}.`);
};

/** Arguments older manifests assume rather than state. */
const LEGACY_JVM_ARGUMENTS = ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'];

/**
 * Keep the first jar seen for a `group:artifact:classifier`, so the loader's own versions win over
 * the game's. The classifier stays in the key because `lwjgl` and `lwjgl:natives-linux` are
 * different jars that both belong on the classpath.
 */
const dedupeLibraries = jobs => {
	const seen = new Set();

	return jobs.filter(({ name }) => {
		if (name === undefined) return true;

		const [group, artifact, , classifier] = name.split(':');
		const key = `${group}:${artifact}${classifier ? `:${classifier}` : ''}`;

		if (seen.has(key)) return false;

		seen.add(key);

		return true;
	});
};

/** Everything needed to install and launch a pairing of game version and loader. */
export const resolvePlan = async ({ minecraft, loader, side = 'client', donors = {} }) => {
	assertLaunchableLoader(loader);

	const libraryDonors = donors.libraries ?? [];
	const { meta } = await mojang.versionMeta(minecraft);
	const id = meta.id;

	const plan = {
		id,
		minecraft: id,
		side,
		// LWJGL, JNA and netty each unpack their own natives out of the classpath jars at startup;
		// nothing is extracted ahead of time, the directory just has to exist.
		nativesDirectory: join(paths.natives, id),
		loader: undefined,
		mainClass: meta.mainClass,
		javaMajor: meta.javaVersion?.majorVersion ?? 8,
		javaComponent: meta.javaVersion?.component,
		assetIndexId: meta.assetIndex.id,
		assetsLegacy: meta.assets === 'legacy' || meta.assets === 'pre-1.6',
		versionType: meta.type,
		meta,
		libraries: mojang.libraryJobs(meta, libraryDonors),
		jvmArguments: meta.arguments ? applicableArguments(meta.arguments.jvm) : [...LEGACY_JVM_ARGUMENTS],
		gameArguments: meta.arguments
			? applicableArguments(meta.arguments.game)
			: (meta.minecraftArguments ?? '').split(/\s+/).filter(Boolean),
	};

	// Other launchers keep the game jar as a maven artifact rather than beside the version json,
	// so it is looked for under that name before being fetched again.
	const gameJarDonors = side =>
		libraryDonors.map(root => join(root, 'com/mojang/minecraft', id, `minecraft-${id}-${side}.jar`));

	plan.clientJar = {
		name: 'com.mojang:minecraft:client',
		url: meta.downloads.client.url,
		checksum: checksumOf(meta.downloads.client.sha1),
		size: meta.downloads.client.size,
		path: mojang.clientJarPath(id),
		donors: gameJarDonors('client'),
	};

	if (meta.downloads.server) {
		plan.serverJar = {
			url: meta.downloads.server.url,
			checksum: checksumOf(meta.downloads.server.sha1),
			size: meta.downloads.server.size,
			path: mojang.serverJarPath(id),
			donors: gameJarDonors('server'),
		};
	}

	if (meta.logging?.client) {
		const { argument, file } = meta.logging.client;

		plan.logging = {
			argument,
			job: {
				url: file.url,
				checksum: checksumOf(file.sha1),
				size: file.size,
				path: join(paths.assets, 'log_configs', file.id),
			},
		};
	}

	const service = LOADER_SERVICES[loader?.type];

	if (service) {
		const version = loader.version ?? (await service.latestLoader(id));
		const loaderProfile = await service.profile(id, version, side);

		plan.loader = { type: loader.type, version, source: service.source };
		plan.mainClass = loaderProfile.mainClass;
		plan.libraries = [...service.libraryJobs(loaderProfile, libraryDonors), ...plan.libraries];
		plan.jvmArguments = [...plan.jvmArguments, ...applicableArguments(loaderProfile.arguments?.jvm)];
		plan.gameArguments = [...plan.gameArguments, ...applicableArguments(loaderProfile.arguments?.game)];
	}

	plan.libraries = dedupeLibraries(plan.libraries);

	return plan;
};

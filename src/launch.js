import { delimiter } from 'node:path';

import { offlineProfile } from './auth';
import { selectJava } from './java';
import { paths } from './paths';
import { detail, step } from './out';

const substitute = (argument, values) =>
	argument.replaceAll(/\$\{(\w+)}/g, (whole, key) => (key in values ? values[key] : whole));

/** The exact command Prism would build, assembled from Mojang's own manifest instead of a mirror. */
export const buildCommand = async (plan, instance, { javaPath, username, memory, extraJvmArgs = [] } = {}) => {
	const java = await selectJava(plan.javaMajor, javaPath);
	const profile = offlineProfile(username);

	const classpath = [...plan.libraries.map(({ path }) => path), plan.clientJar.path].join(delimiter);

	const values = {
		natives_directory: plan.nativesDirectory,
		library_directory: paths.libraries,
		classpath_separator: delimiter,
		classpath,
		launcher_name: 'minecraft-manager',
		launcher_version: '0.1.0',
		version_name: plan.id,
		version_type: plan.versionType,
		game_directory: instance.gameDir,
		assets_root: paths.assets,
		assets_index_name: plan.assetIndexId,
		auth_player_name: profile.name,
		auth_uuid: profile.uuid,
		auth_access_token: profile.accessToken,
		auth_xuid: profile.xuid,
		clientid: profile.clientId,
		user_type: profile.userType,
	};

	const memoryArgs = [`-Xms${memory.min}M`, `-Xmx${memory.max}M`];

	const loggingArgs = plan.logging ? [substitute(plan.logging.argument, { path: plan.logging.job.path })] : [];

	const command = [
		java.path,
		...memoryArgs,
		...plan.jvmArguments.map(argument => substitute(argument, values)),
		...loggingArgs,
		...extraJvmArgs,
		plan.mainClass,
		...plan.gameArguments.map(argument => substitute(argument, values)),
	];

	return { command, java, profile };
};

export const launch = async (plan, instance, options) => {
	const { command, java, profile } = await buildCommand(plan, instance, options);

	step(`Launching ${instance.name} as ${profile.name} (offline)`);

	detail('java', java.path);
	detail('cwd', instance.gameDir);

	if (options.dryRun) {
		console.log(command.map(part => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' '));

		return 0;
	}

	const child = Bun.spawn(command, {
		cwd: instance.gameDir,
		stdio: ['inherit', 'inherit', 'inherit'],
		env: { ...process.env, ...instance.env },
	});

	return await child.exited;
};

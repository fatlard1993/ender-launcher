import { delimiter } from 'node:path';

import { version } from '../package.json';
import { profileFor } from './auth';
import { selectJava } from './java';
import { paths } from './paths';
import { detail, step, warn } from './out';

/**
 * Flags the JVM treats as instructions rather than settings. An argv array closes shell injection,
 * but the JVM is its own argument interpreter: HotSpot hands -XX:OnError and -XX:OnOutOfMemoryError
 * to a shell, and the agent and bootclasspath flags load code before the game starts. None of these
 * appears in a Mojang or Fabric manifest, so anything carrying one is not a manifest we should run.
 */
const REFUSED = /^(?:@|-javaagent|-agentlib|-agentpath|-Xbootclasspath)|OnError|OnOutOfMemoryError/i;

const vetted = argumentList =>
	argumentList.filter(argument => {
		if (!REFUSED.test(argument)) return true;

		warn(`Refusing JVM argument from remote metadata: ${argument}`);

		return false;
	});

const substitute = (argument, values) =>
	argument.replaceAll(/\$\{(\w+)}/g, (whole, key) => (key in values ? values[key] : whole));

export const buildCommand = async (
	plan,
	instance,
	{ javaPath, username, account, memory, extraJvmArgs = [], manageJava = true } = {},
) => {
	const java = await selectJava(plan.javaMajor, javaPath, { component: plan.javaComponent, manage: manageJava });
	const profile = await profileFor({ account, username });

	const classpath = [...plan.libraries.map(({ path }) => path), plan.clientJar.path].join(delimiter);

	const values = {
		natives_directory: plan.nativesDirectory,
		library_directory: paths.libraries,
		classpath_separator: delimiter,
		classpath,
		launcher_name: 'minecraft-manager',
		launcher_version: version,
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
		...vetted(plan.jvmArguments.map(argument => substitute(argument, values))),
		...loggingArgs,
		// After the manifest's arguments, so a remote -Xmx cannot quietly lower the ceiling set here.
		...memoryArgs,
		...extraJvmArgs,
		plan.mainClass,
		...plan.gameArguments.map(argument => substitute(argument, values)),
	];

	return { command, java, profile };
};

export const launch = async (plan, instance, options) => {
	const { command, java, profile } = await buildCommand(plan, instance, options);

	step(`Launching ${instance.name} as ${profile.name}${profile.online ? '' : ' (offline)'}`);

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

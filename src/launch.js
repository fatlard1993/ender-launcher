import { readdir, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import { version } from '../package.json';
import { profileFor } from './auth';
import { selectJava } from './java';
import { paths } from './paths';
import { detail, done, fail, step, warn } from './out';

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
	{ javaPath, username, account, memory, extraJvmArgs = [], manageJava = true, quickPlay = {}, resolution } = {},
) => {
	const java = await selectJava(plan.javaMajor, javaPath, { component: plan.javaComponent, manage: manageJava });
	const profile = await profileFor({ account, username });

	const classpath = [...plan.libraries.map(({ path }) => path), plan.clientJar.path].join(delimiter);

	const values = {
		natives_directory: plan.nativesDirectory,
		library_directory: paths.libraries,
		classpath_separator: delimiter,
		classpath,
		launcher_name: 'ender-launcher',
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
		quickPlayMultiplayer: quickPlay.server ?? '',
		quickPlaySingleplayer: quickPlay.world ?? '',
		quickPlayPath: quickPlay.logPath ?? '',
		resolution_width: String(resolution?.width ?? ''),
		resolution_height: String(resolution?.height ?? ''),
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

	const started = Date.now();
	const child = Bun.spawn(command, {
		cwd: instance.gameDir,
		stdio: ['inherit', 'inherit', 'inherit'],
		env: { ...process.env, ...instance.env },
	});
	const code = await child.exited;

	await sayHowItEnded(instance, code, started);

	return code;
};

/** The crash report the game wrote since `since`, the newest if several; undefined when it wrote none. */
export const crashReportSince = async (gameDir, since) => {
	const directory = join(gameDir, 'crash-reports');
	const names = await readdir(directory).catch(() => []);
	const reports = await Promise.all(
		names.map(async name => ({ path: join(directory, name), at: (await stat(join(directory, name))).mtimeMs })),
	);

	return reports.filter(report => report.at >= since).sort((a, b) => b.at - a.at)[0]?.path;
};

const sayHowItEnded = async (instance, code, started) => {
	if (code === 0) {
		done(`${instance.name} closed`);

		return;
	}

	const report = await crashReportSince(instance.gameDir, started);

	fail(
		report
			? `${instance.name} crashed (exit ${code}); its crash report is ${report}`
			: `${instance.name} ended with exit ${code}; its log is ${join(instance.gameDir, 'logs', 'latest.log')}`,
	);
};

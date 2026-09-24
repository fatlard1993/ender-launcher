import { mkdir } from 'node:fs/promises';

import { profileFor } from '../auth';
import { readConfig } from '../config';
import * as instances from '../instance';
import { installPlan } from '../install';
import { launch } from '../launch';
import { resolvePlan } from '../meta/resolve';
import { done, info, paint, step, warn } from '../out';
import * as server from '../server';
import { settingsFor, targetInstance } from './context';

const planFor = async (manifest, side, features) =>
	resolvePlan({
		minecraft: manifest.minecraft,
		loader: manifest.loader,
		side,
		features,
		donors: await instances.defaultDonors(),
	});

/**
 * What the game should do once it is up, expressed the way the version manifest gates it.
 *
 * Joining a server straight from the command line is a feature the manifest describes and then
 * hides behind a rule, so asking for it means turning the rule on and supplying the value it
 * names. Without both, the arguments are dropped and the game opens at the title screen.
 */
const intentOf = (manifest, flags) => {
	const server = flags.server ?? manifest.server;
	const world = flags.world;
	const width = flags.width ?? manifest.window?.width;
	const height = flags.height ?? manifest.window?.height;
	const resolution = width && height ? { width, height } : undefined;

	if (server && world) throw new Error('Pick one: --server joins a server, --world opens a save.');

	return {
		quickPlay: { server, world, logPath: flags.quickPlayLog },
		resolution,
		features: {
			// Gates --quickPlayPath, which is where the game writes a quick-play log. Asking for it
			// without a path to write to puts an empty argument on the line.
			has_quick_plays_support: Boolean(flags.quickPlayLog),
			is_quick_play_multiplayer: Boolean(server),
			is_quick_play_singleplayer: Boolean(world),
			has_custom_resolution: Boolean(resolution),
			is_demo_user: Boolean(flags.demo),
		},
	};
};

export const install = async ({ positionals, flags }) => {
	const { manifest } = await targetInstance(flags.instance ?? positionals[0]);

	if (manifest.type === 'server') {
		await server.provision(manifest);

		done(`${manifest.name} is provisioned`);

		return 0;
	}

	const plan = await planFor(manifest, 'client');

	await mkdir(manifest.gameDir, { recursive: true });
	await installPlan(plan, { assets: flags.assets !== false, donors: await instances.defaultDonors() });

	done(`${manifest.name} is ready`);

	return 0;
};

export const play = async ({ positionals, flags }) => {
	const { manifest, config } = await targetInstance(flags.instance ?? positionals[0]);

	if (manifest.type === 'server') return server.run(manifest, settingsFor(manifest, config));

	const settings = settingsFor(manifest, config);

	const { accounts } = await import('../auth');

	if ((await accounts.readAccounts()).active === undefined && !settings.account) {
		if (settings.username === undefined || settings.username === 'Player') {
			warn(
				'Launching as "Player". Set a name with "ender config username <name>", or sign in with "ender account add".',
			);
		}
	}

	const intent = intentOf(manifest, flags);
	const plan = await planFor(manifest, 'client', intent.features);

	await mkdir(manifest.gameDir, { recursive: true });

	if (flags.install !== false) {
		await installPlan(plan, { assets: flags.assets !== false, donors: await instances.defaultDonors() });
	}

	if (intent.quickPlay.server) step(`Joining ${intent.quickPlay.server} on launch`);

	return launch(plan, manifest, {
		...settings,
		quickPlay: intent.quickPlay,
		resolution: intent.resolution,
		username: settings.username ?? 'Player',
		memory: settings.memory ?? (await readConfig()).memory,
		extraJvmArgs: [...(manifest.jvmArgs ?? [])],
		manageJava: config.manageJava !== false,
		dryRun: flags.dryRun,
	});
};

/** What the launcher would run, and where every piece of it came from. */
export const explain = async ({ positionals, flags }) => {
	const { manifest, config } = await targetInstance(flags.instance ?? positionals[0]);
	const plan = await planFor(manifest, manifest.type === 'server' ? 'server' : 'client');
	const settings = settingsFor(manifest, config);

	step(`${manifest.name}`);

	info(`  minecraft   ${plan.id} ${paint.dim('(piston-meta.mojang.com)')}`);
	info(
		`  loader      ${plan.loader ? `${plan.loader.type} ${plan.loader.version} ${paint.dim(`(${plan.loader.source})`)}` : 'vanilla'}`,
	);
	info(`  main class  ${plan.mainClass}`);
	info(`  java        needs ${plan.javaMajor}`);
	info(`  libraries   ${plan.libraries.length}`);
	info(`  asset index ${plan.assetIndexId}`);
	info(`  natives     ${plan.nativesDirectory}`);
	info(`  game dir    ${manifest.gameDir}`);
	const profile = await profileFor({ account: settings.account, username: settings.username ?? 'Player' }).catch(
		() => undefined,
	);

	info(
		`  user        ${profile?.name ?? settings.username ?? 'Player'} ${paint.dim(profile?.online ? '(signed in)' : '(offline)')}`,
	);

	return 0;
};

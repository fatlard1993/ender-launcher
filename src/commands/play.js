import { mkdir } from 'node:fs/promises';

import { readConfig } from '../config';
import * as instances from '../instance';
import { installPlan } from '../install';
import { launch } from '../launch';
import { resolvePlan } from '../meta/resolve';
import { done, info, paint, step, warn } from '../out';
import * as server from '../server';
import { settingsFor, targetInstance } from './context';

const planFor = async (manifest, side) =>
	resolvePlan({
		minecraft: manifest.minecraft,
		loader: manifest.loader,
		side,
		donors: await instances.defaultDonors(),
	});

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

	if (settings.username === undefined || settings.username === 'Player') {
		warn('Launching as "Player". Set a name with "mcm config username <name>".');
	}

	const plan = await planFor(manifest, 'client');

	await mkdir(manifest.gameDir, { recursive: true });

	if (flags.install !== false) {
		await installPlan(plan, { assets: flags.assets !== false, donors: await instances.defaultDonors() });
	}

	return launch(plan, manifest, {
		...settings,
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
	info(`  user        ${settings.username ?? 'Player'} ${paint.dim('(offline)')}`);

	return 0;
};

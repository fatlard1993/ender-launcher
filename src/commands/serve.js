import * as instances from '../instance';
import { done, info, step } from '../out';
import * as server from '../server';
import { settingsFor, targetInstance } from './context';

export const provision = async ({ positionals, flags }) => {
	const { manifest } = await targetInstance(flags.instance ?? positionals[0]);

	await server.acceptEula(manifest);
	await server.provision(manifest);

	done(`${manifest.name} is provisioned`);

	return 0;
};

export const start = async ({ positionals, flags }) => {
	const { manifest, config } = await targetInstance(flags.instance ?? positionals[0]);

	if (manifest.type !== 'server') throw new Error(`${manifest.name} is a client instance`);

	await server.acceptEula(manifest);
	await server.warnIfUnreachableOffline(manifest);

	return server.run(manifest, settingsFor(manifest, config));
};

export const offline = async ({ positionals, flags }) => {
	const { manifest } = await targetInstance(flags.instance ?? positionals[0]);

	const properties = await server.readProperties(manifest);

	properties['online-mode'] = 'false';

	await server.writeProperties(manifest, properties);

	done(`${manifest.name} now runs with online-mode=false`);
	info('  Anyone who can reach the port can join under any name. Use a whitelist if that matters.');

	return 0;
};

export const status = async ({ positionals, flags }) => {
	const { manifest } = await targetInstance(flags.instance ?? positionals[0]);
	const properties = await server.readProperties(manifest);
	const jar = server.launcherJarPath(manifest);

	step(manifest.name);

	info(`  minecraft    ${manifest.minecraft}`);
	info(`  loader       ${manifest.loader?.type ?? 'vanilla'} ${manifest.loader?.version ?? ''}`);
	info(`  game dir     ${manifest.gameDir}`);
	info(`  launcher jar ${(await Bun.file(jar).exists()) ? 'present' : 'missing (run "mcm server provision")'}`);
	info(`  online-mode  ${properties['online-mode'] ?? 'unset'}`);
	info(`  port         ${properties['server-port'] ?? '25565'}`);
	info(`  mods         ${(await instances.readLock(manifest.name)).mods.length} installed`);

	return 0;
};

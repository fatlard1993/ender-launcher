import * as instances from '../instance';
import { done, info, step } from '../out';
import * as server from '../server';
import { settingsFor, targetInstance } from './context';

export const provision = async ({ flags }) => {
	const { manifest } = await targetInstance(flags.instance);

	await server.acceptEula(manifest);
	await server.provision(manifest);

	done(`${manifest.name} is provisioned`);

	return 0;
};

export const start = async ({ flags }) => {
	const { manifest, config } = await targetInstance(flags.instance);

	if (manifest.type !== 'server') throw new Error(`${manifest.name} is a client instance`);

	await server.acceptEula(manifest);
	await server.warnIfUnreachableOffline(manifest);

	return server.run(manifest, settingsFor(manifest, config));
};

/** Offline clients cannot pass Mojang's session check, so a server they are meant to join must skip it. */
export const offline = async ({ flags }) => {
	const { manifest } = await targetInstance(flags.instance);

	const properties = await server.readProperties(manifest);

	properties['online-mode'] = 'false';

	await server.writeProperties(manifest, properties);

	done(`${manifest.name} now runs with online-mode=false`);
	info('  Anyone who can reach the port can join under any name. Use a whitelist if that matters.');

	return 0;
};

export const status = async ({ flags }) => {
	const { manifest } = await targetInstance(flags.instance);
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

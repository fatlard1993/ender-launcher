import * as instances from '../instance';
import { done, info, step } from '../out';
import * as server from '../server';
import { settingsFor, targetInstance } from './context';
import { updateBeforeStart } from './mods';

/** Everything a server instance needs on disk, the EULA accepted as running it would. */
export const provisionServer = async manifest => {
	await server.acceptEula(manifest);
	await server.provision(manifest);
};

export const provision = async ({ positionals, flags }) => {
	const { manifest } = await targetInstance(flags.instance ?? positionals[0]);

	await provisionServer(manifest);

	done(`${manifest.name} is provisioned`);

	return 0;
};

/** Start a server instance, from ender server start or ender launch alike: EULA accepted, warned of online-mode, updated when asked. */
export const startServer = async (manifest, config, flags) => {
	await server.acceptEula(manifest);
	await server.warnIfUnreachableOffline(manifest);

	if (flags.update) await updateBeforeStart(manifest, config, flags);

	return server.run(manifest, settingsFor(manifest, config));
};

export const start = async ({ positionals, flags }) => {
	const { manifest, config } = await targetInstance(flags.instance ?? positionals[0]);

	if (manifest.type !== 'server') throw new Error(`${manifest.name} is a client instance`);

	return startServer(manifest, config, flags);
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
	info(`  launcher jar ${(await Bun.file(jar).exists()) ? 'present' : 'missing (run "ender server provision")'}`);
	info(`  online-mode  ${properties['online-mode'] ?? 'unset'}`);
	info(`  port         ${properties['server-port'] ?? '25565'}`);
	info(`  mods         ${(await instances.readLock(manifest.name)).mods.length} installed`);

	return 0;
};

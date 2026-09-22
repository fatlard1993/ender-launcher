import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { fetchServerLauncher, latestLoader } from './meta/fabric';
import { versionMeta } from './meta/mojang';
import { selectJava } from './java';
import { detail, step, warn } from './out';

export const launcherJarPath = manifest => join(manifest.gameDir, 'fabric-server.jar');

export const propertiesPath = manifest => join(manifest.gameDir, 'server.properties');

export const readProperties = async manifest => {
	const text = await Bun.file(propertiesPath(manifest))
		.text()
		.catch(() => '');
	const values = {};

	for (const line of text.split('\n')) {
		const trimmed = line.trim();

		if (trimmed === '' || trimmed.startsWith('#')) continue;

		const index = trimmed.indexOf('=');

		if (index !== -1) values[trimmed.slice(0, index)] = trimmed.slice(index + 1);
	}

	return values;
};

export const writeProperties = async (manifest, values) => {
	const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);

	await Bun.write(propertiesPath(manifest), `${lines.join('\n')}\n`);
};

export const acceptEula = async manifest => {
	await mkdir(manifest.gameDir, { recursive: true });
	await Bun.write(join(manifest.gameDir, 'eula.txt'), 'eula=true\n');
};

/**
 * Fabric's server launcher is a small bootstrap that pulls the game and its libraries itself,
 * so provisioning is one jar rather than a whole install.
 */
export const provision = async manifest => {
	const loader = manifest.loader?.version ?? (await latestLoader(manifest.minecraft));

	await mkdir(manifest.gameDir, { recursive: true });

	step(`Provisioning Fabric server ${manifest.minecraft} / loader ${loader}`);

	const installer = await fetchServerLauncher(manifest.minecraft, loader, launcherJarPath(manifest));

	detail('installer', installer);

	// Every client this launcher builds is an offline one. A server born rejecting them would be a
	// server that cannot be joined by the only clients around, so the default is set before the
	// game writes its own. An existing properties file is left alone.
	if (!(await Bun.file(propertiesPath(manifest)).exists())) {
		await writeProperties(manifest, { 'online-mode': 'false' });

		detail('server.properties', 'seeded with online-mode=false');
	}

	return { loader, installer };
};

export const warnIfUnreachableOffline = async manifest => {
	const properties = await readProperties(manifest);

	if (properties['online-mode'] === 'false') return false;

	warn(
		`${manifest.name} has online-mode=true, which rejects offline clients. Run "mcm server offline ${manifest.name}" to turn it off.`,
	);

	return true;
};

/** The game says which Java it needs; a server is the same game, so it is asked rather than guessed. */
export const requiredJava = async manifest =>
	(await versionMeta(manifest.minecraft)).meta.javaVersion?.majorVersion ?? 8;

export const run = async (manifest, { javaPath, memory, javaMajor, extraArgs = [] } = {}) => {
	const jar = launcherJarPath(manifest);

	if (!(await Bun.file(jar).exists())) await provision(manifest);

	const java = await selectJava(javaMajor ?? (await requiredJava(manifest)), javaPath);

	const command = [
		java.path,
		`-Xms${memory.min}M`,
		`-Xmx${memory.max}M`,
		...(manifest.jvmArgs ?? []),
		'-jar',
		jar,
		'nogui',
		...extraArgs,
	];

	step(`Starting ${manifest.name}`);
	detail('java', java.path);
	detail('cwd', manifest.gameDir);

	const child = Bun.spawn(command, {
		cwd: manifest.gameDir,
		stdio: ['inherit', 'inherit', 'inherit'],
		env: { ...process.env, ...manifest.env },
	});

	return await child.exited;
};

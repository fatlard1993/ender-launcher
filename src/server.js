import { mkdir, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { ensureFile } from './download';
import { selectJava } from './java';
import { fabric } from './meta/fabric';
import { forge, neoforge } from './meta/forge-like';
import { versionMeta } from './meta/mojang';
import { quilt } from './meta/quilt';
import { detail, step, warn } from './out';

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
 * Fabric and Quilt ship a small bootstrap jar that fetches the game and its libraries itself, so
 * provisioning is one file and starting it is one `-jar`.
 */
const fabricLikeServer = service => ({
	name: service.name,
	jarPath: manifest => join(manifest.gameDir, `${service.name.toLowerCase()}-server.jar`),
	async provision(manifest) {
		const loader = manifest.loader?.version ?? (await service.latestLoader(manifest.minecraft));
		const jar = this.jarPath(manifest);

		step(`Provisioning ${service.name} server ${manifest.minecraft} / loader ${loader}`);

		detail('installer', await service.fetchServerLauncher(manifest.minecraft, loader, jar));
	},
	installed(manifest) {
		return Bun.file(this.jarPath(manifest)).exists();
	},
	command(manifest, java, memoryArgs) {
		return [java.path, ...memoryArgs, ...(manifest.jvmArgs ?? []), '-jar', this.jarPath(manifest), 'nogui'];
	},
});

const ARGFILE = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';

/** Find the argument file the installer wrote, wherever under libraries/ it put it. */
const findArgfile = async directory => {
	const walk = async current => {
		for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
			const path = join(current, entry.name);

			if (entry.isDirectory()) {
				const found = await walk(path);

				if (found) return found;
			} else if (entry.name === ARGFILE) return path;
		}

		return undefined;
	};

	return walk(join(directory, 'libraries'));
};

/**
 * Forge and NeoForge install into the server directory itself, because the argument file they
 * write names its libraries by relative path. Starting one is not `-jar` at all: it is that
 * argument file, read by a JVM whose working directory is the server.
 */
const forgeLikeServer = service => ({
	name: service.name,
	async provision(manifest, { javaPath } = {}) {
		const loader = manifest.loader?.version ?? (await service.latestLoader(manifest.minecraft));

		await mkdir(manifest.gameDir, { recursive: true });

		step(`Provisioning ${service.name} server ${manifest.minecraft} / loader ${loader}`);

		await service.installServer(manifest.minecraft, loader, manifest.gameDir, { javaPath });
	},
	async installed(manifest) {
		return (await findArgfile(manifest.gameDir)) !== undefined;
	},
	async command(manifest, java, memoryArgs) {
		const argfile = await findArgfile(manifest.gameDir);

		if (argfile === undefined) {
			throw new Error(
				`${service.name} wrote no ${ARGFILE}. Versions before 1.17 start differently and are not supported.`,
			);
		}

		const userArgs = join(manifest.gameDir, 'user_jvm_args.txt');
		const hasUserArgs = await Bun.file(userArgs).exists();

		// Both files name their contents relative to the server directory, which is where this runs.
		return [
			java.path,
			...memoryArgs,
			...(manifest.jvmArgs ?? []),
			...(hasUserArgs ? ['@user_jvm_args.txt'] : []),
			`@${relative(manifest.gameDir, argfile)}`,
			'nogui',
		];
	},
});

/** Mojang publishes a server jar per version, and nothing else is needed to run it. */
const vanillaServer = {
	name: 'Vanilla',
	jarPath: manifest => join(manifest.gameDir, 'server.jar'),
	async provision(manifest) {
		const { meta } = await versionMeta(manifest.minecraft);

		if (meta.downloads.server === undefined) {
			throw new Error(`Mojang publishes no server jar for ${manifest.minecraft}`);
		}

		await mkdir(manifest.gameDir, { recursive: true });

		step(`Provisioning vanilla server ${manifest.minecraft}`);

		await ensureFile({
			url: meta.downloads.server.url,
			path: this.jarPath(manifest),
			checksum: { algorithm: 'sha1', value: meta.downloads.server.sha1.toLowerCase() },
			size: meta.downloads.server.size,
		});
	},
	installed(manifest) {
		return Bun.file(this.jarPath(manifest)).exists();
	},
	command(manifest, java, memoryArgs) {
		return [java.path, ...memoryArgs, ...(manifest.jvmArgs ?? []), '-jar', this.jarPath(manifest), 'nogui'];
	},
};

/**
 * Quilt installs a server with its own installer, which writes a launch jar and the libraries
 * beside it. Mojang's server download has been a bundler since 1.18 whose own libraries live
 * inside it, so assembling that classpath by hand reproduces work the installer already does.
 */
const installerServer = service => ({
	name: service.name,
	jarPath: manifest => join(manifest.gameDir, 'quilt-server-launch.jar'),
	async provision(manifest, { javaPath } = {}) {
		const loader = manifest.loader?.version ?? (await service.latestLoader(manifest.minecraft));

		await mkdir(manifest.gameDir, { recursive: true });

		step(`Provisioning ${service.name} server ${manifest.minecraft} / loader ${loader}`);

		await service.installServer(manifest.minecraft, loader, manifest.gameDir, { javaPath });
	},
	installed(manifest) {
		return Bun.file(this.jarPath(manifest)).exists();
	},
	command(manifest, java, memoryArgs) {
		return [java.path, ...memoryArgs, ...(manifest.jvmArgs ?? []), '-jar', this.jarPath(manifest), 'nogui'];
	},
});

const STRATEGIES = {
	fabric: fabricLikeServer(fabric),
	quilt: installerServer(quilt),
	forge: forgeLikeServer(forge),
	neoforge: forgeLikeServer(neoforge),
	vanilla: vanillaServer,
};

export const strategyFor = manifest => {
	const strategy = STRATEGIES[manifest.loader?.type ?? 'vanilla'];

	if (strategy === undefined) throw new Error(`mcm cannot run a ${manifest.loader.type} server`);

	return strategy;
};

export const provision = async (manifest, options) => {
	const strategy = strategyFor(manifest);

	await strategy.provision(manifest, options);

	// Every client this launcher builds is an offline one. A server born rejecting them would be a
	// server that cannot be joined by the only clients around, so the default is set before the
	// game writes its own. An existing properties file is left alone.
	if (!(await Bun.file(propertiesPath(manifest)).exists())) {
		await writeProperties(manifest, { 'online-mode': 'false' });

		detail('server.properties', 'seeded with online-mode=false');
	}

	return strategy;
};

export const warnIfUnreachableOffline = async manifest => {
	const properties = await readProperties(manifest);

	if (properties['online-mode'] === 'false') return false;

	warn(
		`${manifest.name} has online-mode=true, which rejects offline clients. Run "mcm server offline ${manifest.name}" to turn it off.`,
	);

	return true;
};

export const requiredJava = async manifest =>
	(await versionMeta(manifest.minecraft)).meta.javaVersion?.majorVersion ?? 8;

export const javaComponentFor = async manifest => (await versionMeta(manifest.minecraft)).meta.javaVersion?.component;

export const run = async (manifest, { javaPath, memory, javaMajor, extraArgs = [], manageJava = true } = {}) => {
	const strategy = strategyFor(manifest);

	if (!(await strategy.installed(manifest))) await provision(manifest, { javaPath });

	const java = await selectJava(javaMajor ?? (await requiredJava(manifest)), javaPath, {
		component: await javaComponentFor(manifest),
		manage: manageJava,
	});

	const memoryArgs = [`-Xms${memory.min}M`, `-Xmx${memory.max}M`];
	const command = [...(await strategy.command(manifest, java, memoryArgs)), ...extraArgs];

	step(`Starting ${manifest.name} (${strategy.name})`);
	detail('java', java.path);
	detail('cwd', manifest.gameDir);

	const child = Bun.spawn(command, {
		cwd: manifest.gameDir,
		stdio: ['inherit', 'inherit', 'inherit'],
		env: { ...process.env, ...manifest.env },
	});

	return await child.exited;
};

export const launcherJarPath = manifest => strategyFor(manifest).jarPath?.(manifest);

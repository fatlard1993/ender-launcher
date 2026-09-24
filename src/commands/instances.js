import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { readConfig, updateConfig } from '../config';
import * as instances from '../instance';
import { fromPrism, identifyMods } from '../instance/import';
import { readPack, unpackInto } from '../instance/pack';
import { entryKey, resolveAll } from '../mods';
import { LOADER_SERVICES } from '../meta/resolve';
import { resolveVersionId } from '../meta/mojang';
import { assertKnownLoader, isLaunchable } from '../meta/resolve';
import { done, info, paint, plural, step, warn } from '../out';
import { parseModSpec, refineModSpec, syncInstance } from './mods';
import { targetInstance, targetName } from './context';

/** Said once, where the instance is made, rather than left for a failed launch to explain. */
const warnIfUnlaunchable = manifest => {
	if (isLaunchable(manifest.loader?.type)) return;

	warn(`ender cannot start a ${manifest.loader.type} instance yet.`);
	info(paint.dim('  Its mods are managed here as usual; launch it from another launcher.'));
};

export const ls = async () => {
	const [found, config] = await Promise.all([instances.list(), readConfig()]);

	if (found.length === 0) {
		info('No instances yet. Create one with "ender new <name>", or adopt a Prism one with "ender import <path>".');

		return 0;
	}

	for (const manifest of found) {
		const active = manifest.name === config.activeInstance;
		const loader =
			manifest.loader?.type === 'vanilla'
				? 'vanilla'
				: `${manifest.loader.type}${manifest.loader.version ? ` ${manifest.loader.version}` : ''}`;

		info(
			`${active ? paint.green('*') : ' '} ${paint.bold(manifest.name.padEnd(16))} ${manifest.minecraft.padEnd(10)} ${loader.padEnd(18)} ${paint.dim(`${plural(manifest.mods.length, 'mod')}, ${manifest.type}`)}`,
		);
	}

	return 0;
};

export const create = async ({ positionals, flags }) => {
	const [name, ...specs] = positionals;

	if (name === undefined) throw new Error('ender new <name> [mod...]');

	const minecraft = await resolveVersionId(flags.minecraft);
	const loaderType = assertKnownLoader({ type: flags.loader ?? 'fabric' });
	const loader = { type: loaderType };

	if (loaderType !== 'vanilla') {
		loader.version = flags.loaderVersion ?? (await LOADER_SERVICES[loaderType].latestLoader(minecraft));
	}

	const mods = await Promise.all(
		specs.map(async spec => {
			const entry = await refineModSpec(parseModSpec(spec));

			if (entry.path) entry.path = resolve(entry.path);

			return entry;
		}),
	);

	// Resolved before the instance exists, so a typo leaves nothing behind to clean up.
	const config = await readConfig();
	const context = {
		minecraft,
		loader: loaderType === 'vanilla' ? undefined : loaderType,
		key: config.curseforgeKey,
		githubToken: config.githubToken,
		allowPrerelease: flags.pre ?? config.prerelease ?? false,
		buildMissing: flags.build ?? false,
	};

	if (mods.length > 0) await resolveAll(mods, context, { withDependencies: false });

	const manifest = await instances.create(name, {
		type: flags.server ? 'server' : 'client',
		minecraft,
		loader,
		mods,
		...(flags.gameDir ? { gameDir: resolve(flags.gameDir) } : {}),
	});

	done(`Created ${name} :: Minecraft ${minecraft}, ${loader.type}${loader.version ? ` ${loader.version}` : ''}`);
	info(paint.dim(`  ${manifest.gameDir}`));

	warnIfUnlaunchable(manifest);

	await activateIfFirst(name);

	if (mods.length === 0) return 0;

	const { failures } = await syncInstance(manifest, config, { withDependencies: flags.deps !== false, flags });

	return failures.length > 0 ? 1 : 0;
};

export const use = async ({ positionals }) => {
	const [name] = positionals;

	if (name === undefined) throw new Error('ender use <name>');
	if (!(await instances.exists(name))) throw new Error(`No instance named "${name}"`);

	await updateConfig({ activeInstance: name });

	done(`Active instance is now ${name}`);

	return 0;
};

export const info_ = async ({ positionals, flags }) => {
	const { manifest } = await targetInstance(flags.instance ?? positionals[0]);
	const lock = await instances.readLock(manifest.name);

	info(`${paint.bold(manifest.name)} ${paint.dim(`(${manifest.type})`)}`);
	info(`  minecraft  ${manifest.minecraft}`);
	info(`  loader     ${manifest.loader?.type ?? 'vanilla'} ${manifest.loader?.version ?? ''}`);
	info(`  game dir   ${manifest.gameDir}`);
	info(`  mods       ${manifest.mods.length} declared, ${lock.mods.length} installed`);

	for (const mod of lock.mods) {
		info(`    ${mod.requested ? ' ' : paint.dim('+')} ${mod.name} ${paint.dim(mod.version)}`);
	}

	return 0;
};

const NUMERIC = new Set(['memory.min', 'memory.max']);

const SETTABLE = new Set([
	'minecraft',
	'loader',
	'loaderVersion',
	'gameDir',
	'username',
	'memory.min',
	'memory.max',
	'javaPath',
]);

/** Everything about an instance except its mods was fixed at creation until this existed. */
export const set = async ({ positionals, flags }) => {
	const [key, ...rest] = positionals;
	const { manifest } = await targetInstance(flags.instance);

	if (key === undefined) {
		for (const name of SETTABLE) {
			const [head, tail] = name.split('.');
			const value = tail ? manifest[head]?.[tail] : manifest[head];

			info(`  ${name.padEnd(14)} ${value === undefined ? paint.dim('unset') : JSON.stringify(value)}`);
		}

		return 0;
	}

	if (!SETTABLE.has(key)) throw new Error(`"${key}" is not settable. "ender set" lists what is.`);
	if (rest.length === 0) throw new Error(`ender set ${key} <value>`);

	const raw = rest.join(' ');

	if (key === 'minecraft') return bump({ positionals: [raw], flags });

	if (key === 'loader') {
		const type = assertKnownLoader({ type: raw });

		manifest.loader = { type };

		if (LOADER_SERVICES[type]) manifest.loader.version = await LOADER_SERVICES[type].latestLoader(manifest.minecraft);

		warnIfUnlaunchable(manifest);
	} else if (key === 'loaderVersion') {
		manifest.loader = { ...manifest.loader, version: raw };
	} else if (key === 'gameDir') {
		manifest.gameDir = resolve(raw);
	} else if (NUMERIC.has(key)) {
		const [, field] = key.split('.');
		const value = Number(raw);

		if (!Number.isFinite(value)) throw new Error(`${key} needs a number, not "${raw}"`);

		manifest.memory = { ...(manifest.memory ?? { min: 512, max: 4096 }), [field]: value };
	} else manifest[key] = raw;

	await instances.write(manifest);

	done(`${manifest.name}: ${key} = ${raw}`);

	return 0;
};

/** Move an instance to another game version, carrying the loader with it. */
export const bump = async ({ positionals, flags }) => {
	const [wanted] = positionals;

	if (wanted === undefined) throw new Error('ender bump <minecraft-version>');

	const { manifest } = await targetInstance(flags.instance);
	const minecraft = await resolveVersionId(wanted);
	const was = manifest.minecraft;

	manifest.minecraft = minecraft;

	if (LOADER_SERVICES[manifest.loader?.type]) {
		manifest.loader = {
			...manifest.loader,
			version: flags.loaderVersion ?? (await LOADER_SERVICES[manifest.loader.type].latestLoader(minecraft)),
		};
	} else if (flags.loaderVersion) {
		manifest.loader = { ...manifest.loader, version: flags.loaderVersion };
	}

	await instances.write(manifest);

	done(
		`${manifest.name}: ${was} -> ${minecraft}${manifest.loader?.version ? `, loader ${manifest.loader.version}` : ''}`,
	);
	info(paint.dim('  run "ender update" to move the mods, then "ender launch"'));

	return 0;
};

export const clone = async ({ positionals, flags }) => {
	const [source, destination] = positionals;

	if (source === undefined || destination === undefined) throw new Error('ender clone <source> <new-name>');

	const original = await instances.read(source);

	const copy = await instances.create(destination, {
		...original,
		name: destination,
		gameDir: flags.gameDir ? resolve(flags.gameDir) : undefined,
		mods: structuredClone(original.mods),
	});

	done(`Cloned ${source} -> ${destination}`);
	info(paint.dim(`  ${copy.gameDir}`));
	info(paint.dim('  run "ender sync -i ' + destination + '" to install its mods'));

	return 0;
};

export const remove = async ({ positionals, flags }) => {
	const name = await targetName(flags.instance ?? positionals[0]);
	const manifest = await instances.read(name);

	if (!flags.yes) {
		warn(`This removes the instance "${name}".`);
		info(
			flags.purge
				? `  Its game directory ${manifest.gameDir} goes too.`
				: `  Its game directory ${manifest.gameDir} stays.`,
		);
		info('  Pass --yes to go ahead.');

		return 1;
	}

	await instances.remove(name, { purgeGameDir: flags.purge });

	if ((await readConfig()).activeInstance === name) await updateConfig({ activeInstance: undefined });

	done(`Removed ${name}`);

	return 0;
};

const reportUnmanaged = (unmatched, gameDir) => {
	if (unmatched.length === 0) return;

	info('');
	warn(`${plural(unmatched.length, 'jar')} could not be identified and stay unmanaged:`);

	for (const file of unmatched) info(`    ${file}`);

	info(paint.dim('  They keep working. To have ender manage one, add it by path:'));
	info(paint.dim(`    ender add ${join(gameDir, 'mods', unmatched[0])}`));
};

const activateIfFirst = async name => {
	if ((await readConfig()).activeInstance === undefined) await updateConfig({ activeInstance: name });
};

const importPack = async (path, flags) => {
	const pack = await readPack(path, {
		name: flags.name,
		minecraft: flags.minecraft,
		loader: flags.loader ? { type: flags.loader } : undefined,
	});

	assertKnownLoader(pack.manifest.loader);

	if (await instances.exists(pack.manifest.name))
		throw new Error(`An instance named "${pack.manifest.name}" already exists`);

	// A pack may name a loader without pinning it; the instance should still say which one it got.
	if (LOADER_SERVICES[pack.manifest.loader.type] && !pack.manifest.loader.version) {
		pack.manifest.loader.version = await LOADER_SERVICES[pack.manifest.loader.type].latestLoader(
			pack.manifest.minecraft,
		);
	}

	const manifest = await instances.create(pack.manifest.name, {
		...pack.manifest,
		...(flags.gameDir ? { gameDir: resolve(flags.gameDir) } : {}),
	});

	const written = await unpackInto(path, pack, manifest.gameDir);

	// Whatever the pack carried as loose files is asked about by hash, the same way an imported
	// Prism instance is, so a bundled jar that is really a published mod becomes updatable.
	const { entries, unmatched } = await identifyMods(instances.modsDir(manifest));
	const known = new Set(manifest.mods.map(entryKey));

	for (const entry of entries) {
		if (!known.has(entryKey(entry))) manifest.mods.push(entry);
	}

	await instances.write(manifest);

	done(
		`Imported ${manifest.name} :: Minecraft ${manifest.minecraft}, ${manifest.loader.type} ${manifest.loader.version ?? ''}`,
	);

	if (pack.summary) info(paint.dim(`  ${pack.summary}`));

	info(paint.dim(`  game dir  ${manifest.gameDir}`));
	info(paint.dim(`  ${plural(written.length, 'file')} unpacked, ${plural(manifest.mods.length, 'mod')} declared`));

	reportUnmanaged(unmatched, manifest.gameDir);

	warnIfUnlaunchable(manifest);

	info('');
	info(paint.dim(`  ender sync -i ${manifest.name}   to fetch what the pack references`));

	await activateIfFirst(manifest.name);

	return 0;
};

const importPrismInstance = async (directory, flags) => {
	step(`Reading ${directory}`);

	const { manifest, unmatched } = await fromPrism(directory, { name: flags.name });

	if (await instances.exists(manifest.name)) throw new Error(`An instance named "${manifest.name}" already exists`);

	await instances.write(manifest);

	done(
		`Imported ${manifest.name} :: Minecraft ${manifest.minecraft}, ${manifest.loader.type} ${manifest.loader.version ?? ''}`,
	);
	info(paint.dim(`  game dir  ${manifest.gameDir}`));
	info(paint.dim(`  ${plural(manifest.mods.length, 'mod')} identified on Modrinth`));

	reportUnmanaged(unmatched, manifest.gameDir);

	warnIfUnlaunchable(manifest);

	await activateIfFirst(manifest.name);

	return 0;
};

/** A Prism instance directory, or a modpack in any of the shapes people actually hand around. */
export const importAny = async ({ positionals, flags }) => {
	const [target] = positionals;

	if (target === undefined) throw new Error('ender import <prism-instance-directory | pack.mrpack | pack.zip>');

	const path = resolve(target);
	const info_ = await stat(path).catch(() => undefined);

	if (info_ === undefined) throw new Error(`No such file or directory: ${target}`);

	return info_.isDirectory() ? importPrismInstance(path, flags) : importPack(path, flags);
};

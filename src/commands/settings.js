import { readConfig, updateConfig } from '../config';
import { installations, managedRuntimes } from '../java';
import { installRuntime, isInstalled, publishedRuntimes, runtimeBinary } from '../runtime';
import { done, info, paint, warn } from '../out';

const NUMERIC = new Set(['memory.min', 'memory.max']);

const BOOLEAN = new Set(['manageJava']);

export const config = async ({ positionals }) => {
	const [key, ...rest] = positionals;
	const current = await readConfig();

	if (key === undefined) {
		for (const [name, value] of Object.entries(current)) {
			info(`  ${name.padEnd(16)} ${value === undefined ? paint.dim('unset') : JSON.stringify(value)}`);
		}

		return 0;
	}

	const [head, tail] = key.split('.');

	if (!(head in current)) {
		warn(`"${head}" is not a setting. "ender config" lists them.`);

		return 1;
	}

	if (rest.length === 0) {
		const value = tail ? current[head]?.[tail] : current[key];

		info(value === undefined ? paint.dim('unset') : JSON.stringify(value));

		return 0;
	}

	const raw = rest.join(' ');

	if (raw === 'unset') {
		await updateConfig(tail ? { [head]: { ...current[head], [tail]: undefined } } : { [key]: undefined });

		done(`${key} unset`);

		return 0;
	}

	let value = raw;

	if (NUMERIC.has(key)) {
		value = Number(raw);

		// Stored unchecked, this becomes the literal flag -XmxNaNM at the next launch.
		if (!Number.isFinite(value)) throw new Error(`${key} needs a number, not "${raw}"`);
	} else if (BOOLEAN.has(key)) value = raw !== 'false';

	await updateConfig(tail ? { [head]: { ...current[head], [tail]: value } } : { [key]: value });

	done(`${key} = ${value}`);

	return 0;
};

export const javaList = async ({ flags }) => {
	const [found, managed, published] = await Promise.all([
		installations({ refresh: flags.refresh }),
		managedRuntimes(),
		publishedRuntimes().catch(() => ({})),
	]);

	const managedPaths = new Set(managed.map(entry => entry.path));

	info(paint.bold('Managed by ender'));

	if (managed.length === 0) info(paint.dim('  none yet; ender installs one when a version needs it'));

	for (const entry of managed) {
		const probed = found.find(candidate => candidate.path === entry.path);

		info(`  ${paint.green('*')} ${entry.component.padEnd(28)} ${probed ? `Java ${probed.major}` : ''}`);
	}

	const system = found.filter(entry => !managedPaths.has(entry.path));

	if (system.length > 0) {
		info('');
		info(paint.bold('Found on this machine'));

		for (const entry of system) info(`    ${String(entry.major).padStart(3)}  ${entry.path}`);
	}

	const installable = Object.entries(published).filter(([component]) => !managedPaths.has(runtimeBinary(component)));

	if (installable.length > 0) {
		info('');
		info(paint.bold('Available from Mojang'));

		for (const [component, build] of installable) {
			info(`    ${component.padEnd(28)} ${build.version.name}`);
		}

		info('');
		info(paint.dim('  ender java install <component>'));
	}

	return 0;
};

export const javaInstall = async ({ positionals }) => {
	const [component] = positionals;

	if (component === undefined) throw new Error('ender java install <component> :: "ender java" lists them');
	if (await isInstalled(component)) {
		done(`${component} is already installed`);

		return 0;
	}

	const path = await installRuntime(component);

	done(`${component} installed`);
	info(paint.dim(`  ${path}`));

	return 0;
};

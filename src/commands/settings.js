import { readConfig, updateConfig } from '../config';
import { installations } from '../java';
import { done, info, paint } from '../out';

const NUMERIC = new Set(['memory.min', 'memory.max']);

export const config = async ({ positionals }) => {
	const [key, ...rest] = positionals;
	const current = await readConfig();

	if (key === undefined) {
		for (const [name, value] of Object.entries(current)) {
			info(`  ${name.padEnd(16)} ${value === undefined ? paint.dim('unset') : JSON.stringify(value)}`);
		}

		return 0;
	}

	if (rest.length === 0) {
		const [head, tail] = key.split('.');

		info(tail ? JSON.stringify(current[head]?.[tail]) : JSON.stringify(current[key]));

		return 0;
	}

	const raw = rest.join(' ');
	const value = NUMERIC.has(key) ? Number(raw) : raw;
	const [head, tail] = key.split('.');

	await updateConfig(tail ? { [head]: { ...current[head], [tail]: value } } : { [key]: value });

	done(`${key} = ${value}`);

	return 0;
};

export const java = async ({ flags }) => {
	const found = await installations({ refresh: flags.refresh });

	if (found.length === 0) {
		info('No Java installations found.');

		return 1;
	}

	for (const entry of found) info(`  ${String(entry.major).padStart(3)}  ${entry.path}`);

	return 0;
};

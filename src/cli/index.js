import { fail, info, paint, setVerbosity } from '../out';
import { commands } from './commands';
import { commandHelp, usage } from './help';
import { parseArgv } from './parse';

const GLOBAL_FLAGS = {
	verbose: { type: 'boolean', alias: 'v', description: 'Say more about what is happening' },
	help: { type: 'boolean', alias: 'h', description: 'Show usage' },
};

const suggest = wanted => {
	const names = Object.keys(commands);
	const close = names.filter(name => name.startsWith(wanted[0]) || name.includes(wanted));

	return close.length > 0 ? `\n  Did you mean: ${close.join(', ')}?` : '';
};

export const run = async argv => {
	const [name, ...rest] = argv;

	if (name === undefined || name === 'help') {
		usage();

		return name === undefined ? 1 : 0;
	}

	if (name === '--version' || name === '-V') {
		info('0.1.0');

		return 0;
	}

	const command = commands[name];

	if (command === undefined) {
		fail(`Unknown command "${name}".${suggest(name)}`);

		return 1;
	}

	let definition = command;
	let argumentsForCommand = rest;

	if (command.subcommands) {
		const [sub, ...subRest] = rest;

		if (sub !== undefined && command.subcommands[sub]) {
			definition = { ...command, ...command.subcommands[sub] };
			argumentsForCommand = subRest;
		} else if (sub !== undefined && !sub.startsWith('-')) {
			fail(`"${name}" has no subcommand "${sub}"`);
			commandHelp(name, command);

			return 1;
		} else if (!rest.includes('--help') && !rest.includes('-h')) {
			commandHelp(name, command);

			return 1;
		}
	}

	const spec = { ...GLOBAL_FLAGS, ...definition.flags };
	const parsed = parseArgv(argumentsForCommand, spec);

	if (parsed.flags.help) {
		commandHelp(name, definition);

		return 0;
	}

	if (parsed.flags.verbose) setVerbosity(3);

	return (await definition.run(parsed)) ?? 0;
};

export const main = async argv => {
	try {
		return await run(argv);
	} catch (error) {
		fail(error.message);

		if (process.env.MCM_DEBUG) console.error(paint.dim(error.stack));
		if (error instanceof AggregateError) {
			for (const nested of error.errors.slice(0, 5)) info(paint.dim(`  ${nested.message}`));
		}

		return 1;
	}
};

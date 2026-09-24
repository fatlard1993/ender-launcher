import { version } from '../../package.json';
import { fail, info, paint, setVerbosity } from '../out';
import { commands } from './commands';
import { commandHelp, usage } from './help';
import { parseArgv } from './parse';

const GLOBAL_FLAGS = {
	verbose: { type: 'boolean', alias: 'v', description: 'Say more about what is happening' },
	help: { type: 'boolean', alias: 'h', description: 'Show usage' },
};

const suggest = wanted => {
	const bare = wanted.replace(/^-+/, '');
	const close = Object.keys(commands).filter(name => (bare && name.startsWith(bare[0])) || name.includes(bare));

	return close.length > 0 ? `\n  Did you mean: ${close.join(', ')}?` : '';
};

const HELP_WORDS = new Set(['help', '--help', '-h', '-?']);

const VERSION_WORDS = new Set(['version', '--version', '-V']);

export const run = async argv => {
	const [name, ...rest] = argv;

	if (name === undefined || HELP_WORDS.has(name)) {
		usage();

		return name === undefined ? 1 : 0;
	}

	if (VERSION_WORDS.has(name)) {
		info(version);

		return 0;
	}

	const command = commands[name];

	if (command === undefined) {
		fail(`Unknown command "${name}".${suggest(name)}`);

		return 1;
	}

	let definition = command;
	let argumentsForCommand = rest;
	let title = name;

	if (command.subcommands) {
		const [sub, ...subRest] = rest;

		if (sub !== undefined && command.subcommands[sub]) {
			// The child's own usage, under the name actually typed, rather than the parent's page.
			definition = { ...command, usage: `ender ${name} ${sub}`, subcommands: undefined, ...command.subcommands[sub] };
			argumentsForCommand = subRest;
			title = `${name} ${sub}`;
		} else if (sub !== undefined && !sub.startsWith('-')) {
			fail(`"${name}" has no subcommand "${sub}"`);
			commandHelp(name, command);

			return 1;
		} else if (command.run === undefined && !rest.includes('--help') && !rest.includes('-h')) {
			commandHelp(name, command);

			return 1;
		}
	}

	const spec = { ...GLOBAL_FLAGS, ...definition.flags };
	const parsed = parseArgv(argumentsForCommand, spec);

	if (parsed.flags.help) {
		commandHelp(title, definition);

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

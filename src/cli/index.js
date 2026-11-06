import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { version } from '../../package.json';
import { fail, info, paint, setVerbosity } from '../out';
import { adoptConfiguredName } from '../auth/adopt';
import { ICON_ARGS, iconLog, startedAsApp } from '../desktop';
import { detach } from '../jobs';
import * as instances from '../instance';
import { commands } from './commands';
import { commandHelp, startHere, usage } from './help';
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

/** Opened from the app bundle a disk image carries: ender web starts on its own and outlives this, as macLauncher's does. */
const startFromIcon = async () => {
	await mkdir(dirname(iconLog()), { recursive: true });
	detach([process.execPath, ...ICON_ARGS], iconLog());

	return 0;
};

/**
 * The command a line names and the flags it may carry: a subcommand's own definition under the name actually typed,
 * with the parent's usage replaced; `unknownSubcommand` when a parent with subcommands was given a word that is none.
 */
export const commandLine = argv => {
	const [name, ...rest] = argv;
	const command = Object.hasOwn(commands, name) ? commands[name] : undefined;

	if (command === undefined) return { name, command };

	let definition = command;
	let args = rest;
	let title = name;
	let unknownSubcommand;

	if (command.subcommands) {
		const [sub, ...subRest] = rest;

		if (sub !== undefined && Object.hasOwn(command.subcommands, sub)) {
			definition = { ...command, usage: `ender ${name} ${sub}`, subcommands: undefined, ...command.subcommands[sub] };
			args = subRest;
			title = `${name} ${sub}`;
		} else if (sub !== undefined && !sub.startsWith('-')) unknownSubcommand = sub;
	}

	return {
		name,
		command,
		definition,
		title,
		unknownSubcommand,
		parse: () => parseArgv(args, { ...GLOBAL_FLAGS, ...definition.flags }),
	};
};

export const run = async argv => {
	if (startedAsApp(argv)) return startFromIcon();

	const [name, ...rest] = argv;

	if (name === undefined && (await instances.list()).length === 0) {
		startHere();

		return 0;
	}

	if (name === undefined || HELP_WORDS.has(name)) {
		usage();

		return 0;
	}

	if (VERSION_WORDS.has(name)) {
		info(version);

		return 0;
	}

	const { command, definition, title, unknownSubcommand, parse } = commandLine(argv);

	if (command !== undefined) await adoptConfiguredName();

	if (command === undefined) {
		fail(`Unknown command "${name}".${suggest(name)}`);

		return 1;
	}

	if (unknownSubcommand !== undefined) {
		fail(`"${name}" has no subcommand "${unknownSubcommand}"`);
		commandHelp(name, command);

		return 1;
	}

	if (definition.run === undefined && !rest.includes('--help') && !rest.includes('-h')) {
		commandHelp(name, command);

		return 1;
	}

	const parsed = parse();

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

		if (process.env.ENDER_DEBUG) console.error(paint.dim(error.stack));
		if (error instanceof AggregateError) {
			for (const nested of error.errors.slice(0, 5)) info(paint.dim(`  ${nested.message}`));
		}

		return 1;
	}
};

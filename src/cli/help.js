import { info, paint } from '../out';
import { commands } from './commands';

const GROUPS = [
	['Instances', ['ls', 'new', 'use', 'info', 'delete', 'import']],
	['Running', ['install', 'launch', 'explain']],
	['Mods', ['search', 'add', 'drop', 'sync', 'update']],
	['Servers', ['server']],
	['Settings', ['config', 'java']],
];

export const usage = () => {
	info(`${paint.bold('mcm')} :: Minecraft instances, mods, and servers`);
	info('');
	info(`  ${paint.dim('mcm <command> [arguments] [flags]')}`);

	for (const [group, names] of GROUPS) {
		info('');
		info(paint.bold(group));

		for (const name of names) info(`  ${paint.cyan(name.padEnd(10))} ${commands[name].summary}`);
	}

	info('');
	info(paint.dim("  mcm <command> --help  for a command's flags"));
};

export const commandHelp = (name, command) => {
	info(`${paint.bold(name)} :: ${command.summary}`);
	info('');
	info(`  ${command.usage ?? `mcm ${name}`}`);

	if (command.subcommands) {
		info('');
		info(paint.bold('Subcommands'));

		for (const [sub, definition] of Object.entries(command.subcommands)) {
			info(`  ${paint.cyan(sub.padEnd(10))} ${definition.summary}`);
		}
	}

	const flags = Object.entries(command.flags ?? {});

	if (flags.length > 0) {
		info('');
		info(paint.bold('Flags'));

		for (const [flag, spec] of flags) {
			const alias = spec.alias ? `-${spec.alias}, ` : '    ';
			const shown = `${alias}--${flag}${spec.type === 'boolean' ? '' : ' <value>'}`;

			info(
				`  ${paint.cyan(shown.padEnd(24))} ${spec.description ?? ''}${spec.default === undefined ? '' : paint.dim(` (${spec.default})`)}`,
			);
		}
	}
};

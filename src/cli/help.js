import { info, paint } from '../out';
import { commands } from './commands';

const GROUPS = [
	['Instances', ['ls', 'new', 'use', 'info', 'set', 'bump', 'clone', 'delete', 'import']],
	['Running', ['install', 'launch', 'explain']],
	['Mods', ['search', 'add', 'drop', 'sync', 'update']],
	['Servers', ['server']],
	['Accounts', ['account']],
	['Settings', ['config', 'java']],
];

export const usage = () => {
	info(`${paint.bold('ender')} :: Minecraft instances, mods, and servers`);
	info('');
	info(`  ${paint.dim('ender <command> [arguments] [flags]')}`);

	for (const [group, names] of GROUPS) {
		info('');
		info(paint.bold(group));

		for (const name of names) info(`  ${paint.cyan(name.padEnd(10))} ${commands[name].summary}`);
	}

	info('');
	info(paint.dim("  ender <command> --help  for a command's flags"));
};

export const commandHelp = (name, command) => {
	info(`${paint.bold(name)} :: ${command.summary}`);
	info('');
	info(`  ${command.usage ?? `ender ${name}`}`);

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

		// Flags are declared in camelCase and typed in kebab-case, so kebab is what is shown. A
		// boolean already on by default is only useful as its negation.
		const kebab = flag => flag.replaceAll(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);

		for (const [flag, spec] of flags) {
			const alias = spec.alias ? `-${spec.alias}, ` : '    ';
			const name = spec.type === 'boolean' && spec.default === true ? `--no-${kebab(flag)}` : `--${kebab(flag)}`;
			const shown = `${alias}${name}${spec.type === 'boolean' ? '' : ' <value>'}`;
			const note = spec.default === undefined || spec.type === 'boolean' ? '' : paint.dim(` (${spec.default})`);
			// The name shown is the negation, so the sentence beside it has to be too, or the
			// row says the opposite of what typing it does: "--no-assets  Include game assets".
			const description = (name.startsWith('--no-') ? spec.off : undefined) ?? spec.description ?? '';

			info(`  ${paint.cyan(shown.padEnd(26))} ${description}${note}`);
		}
	}
};

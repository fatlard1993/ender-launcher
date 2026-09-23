import { accounts } from '../auth';
import { readConfig } from '../config';
import { done, info, paint, plural, warn } from '../out';
import { targetInstance } from './context';

const CLIENT_ID_HELP = [
	'No Azure client id is configured.',
	'',
	'  Minecraft sign in needs an app registration of your own:',
	'    1. Register an application at https://portal.azure.com (Microsoft Entra ID)',
	'    2. Add a "Mobile and desktop" platform and allow public client flows',
	'    3. Apply for Minecraft API access at https://aka.ms/mce-reviewappid',
	'    4. mcm config clientId <the application id>',
	'',
	'  Until a registration is approved, instances launch offline.',
].join('\n');

export const ls = async () => {
	const found = await accounts.list();

	if (found.length === 0) {
		info('No accounts. Sign in with "mcm account add".');
		info(paint.dim('  Without one, instances launch offline under the configured username.'));

		return 0;
	}

	for (const account of found) {
		info(
			`${account.active ? paint.green('*') : ' '} ${paint.bold(account.name.padEnd(18))} ${paint.dim(account.uuid)}`,
		);
	}

	return 0;
};

export const add = async () => {
	const { clientId } = await readConfig();

	if (!clientId) {
		warn('Cannot sign in yet.');
		info('');
		info(CLIENT_ID_HELP);

		return 1;
	}

	const account = await accounts.add({ clientId });

	done(`Signed in as ${account.name}`);
	info(paint.dim(`  ${account.uuid}`));

	return 0;
};

export const use = async ({ positionals }) => {
	const [name] = positionals;

	if (name === undefined) throw new Error('mcm account use <name>');

	await accounts.use(name);

	done(`Playing as ${name}`);

	return 0;
};

export const remove = async ({ positionals }) => {
	const [name] = positionals;

	if (name === undefined) throw new Error('mcm account remove <name>');

	await accounts.remove(name);

	done(`Removed ${name}`);

	return 0;
};

/** Bind one instance to one account, for when the active account is not the one it should use. */
export const assign = async ({ positionals, flags }) => {
	const [name] = positionals;
	const { manifest } = await targetInstance(flags.instance);

	if (name === undefined) {
		info(
			manifest.account ? `${manifest.name} plays as ${manifest.account}` : `${manifest.name} uses the active account`,
		);

		return 0;
	}

	const { default: instances } = await import('../instance');

	manifest.account = name === 'none' ? undefined : name;

	await instances.write(manifest);

	done(manifest.account ? `${manifest.name} now plays as ${name}` : `${manifest.name} follows the active account`);

	return 0;
};

export const status = async () => {
	const [found, config] = await Promise.all([accounts.list(), readConfig()]);

	info(`  client id   ${config.clientId ?? paint.dim('unset')}`);
	info(`  accounts    ${plural(found.length, 'account')}`);
	info(`  active      ${found.find(account => account.active)?.name ?? paint.dim('none, launches offline')}`);

	return 0;
};

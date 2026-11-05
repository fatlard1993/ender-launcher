import { join } from 'node:path';

import { accounts } from '../auth';
import { DEFAULT_PLAYER } from '../auth/adopt';
import * as instances from '../instance';
import { done, info, paint, plural, warn } from '../out';
import { targetInstance } from './context';

export const ls = async ({ flags = {} } = {}) => {
	const found = await accounts.list();

	if (flags.json) {
		info(
			JSON.stringify({
				fallback: DEFAULT_PLAYER,
				accounts: found.map(({ name, kind, uuid, active }) => ({ name, kind, uuid, active })),
			}),
		);

		return 0;
	}

	if (flags.names) {
		for (const account of found) info(account.name);

		return 0;
	}

	if (found.length === 0) {
		info('No accounts yet.');
		info(paint.dim('  ender account add --offline <name>   an identity that needs no sign in'));
		info(paint.dim('  ender account add                   sign in to a Microsoft account'));
		info(paint.dim(`  Without either, instances launch offline as ${DEFAULT_PLAYER}.`));

		return 0;
	}

	for (const account of found) {
		const kind = account.kind === 'offline' ? paint.dim('offline') : paint.cyan('microsoft');

		info(
			`${account.active ? paint.green('*') : ' '} ${paint.bold(account.name.padEnd(18))} ${kind.padEnd(19)} ${paint.dim(account.uuid)}`,
		);
	}

	return 0;
};

export const add = async ({ positionals, flags }) => {
	if (flags.offline) {
		const [name] = positionals;

		if (name === undefined) throw new Error('ender account add --offline <name>');

		const account = await accounts.addOffline(name);

		const playing = (await accounts.list()).find(known => known.active)?.name;

		done(`Added offline account ${account.name}`);
		info(paint.dim(`  ${account.uuid}`));
		info(
			paint.dim(
				playing === account.name
					? `  instances play as ${account.name} unless given another`
					: `  instances still play as ${playing}; "ender account use ${account.name}" switches`,
			),
		);

		return 0;
	}

	const account = await accounts.add({ qr: flags.qr !== false });

	done(`Signed in as ${account.name}`);
	info(paint.dim(`  ${account.uuid}`));

	return 0;
};

export const importAccounts = async ({ positionals }) => {
	const [file = join(instances.PRISM_ROOT, 'accounts.json')] = positionals;
	const results = await accounts.importPrism(file);

	if (results.length === 0) info(`Prism has no Microsoft accounts in ${file}`);

	for (const { name, error } of results) {
		if (error) warn(`${name} was not taken over: ${error}`);
		else done(`Took over ${name} from Prism`);
	}

	return results.some(result => result.error) ? 1 : 0;
};

export const use = async ({ positionals }) => {
	const [name] = positionals;

	if (name === undefined) throw new Error('ender account use <name>');

	await accounts.use(name);

	done(`Playing as ${name}`);

	return 0;
};

export const remove = async ({ positionals }) => {
	const [name] = positionals;

	if (name === undefined) throw new Error('ender account remove <name>');

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

	if (name !== 'none') await accounts.assertExists(name);

	manifest.account = name === 'none' ? undefined : name;

	await instances.write(manifest);

	done(manifest.account ? `${manifest.name} now plays as ${name}` : `${manifest.name} follows the active account`);

	return 0;
};

export const status = async () => {
	const found = await accounts.list();

	const active = found.find(account => account.active);

	info(`  accounts    ${plural(found.length, 'account')} (${found.filter(a => a.kind === 'offline').length} offline)`);
	info(
		`  active      ${active ? `${active.name} ${paint.dim(`(${active.kind})`)}` : paint.dim(`none, launches offline as ${DEFAULT_PLAYER}`)}`,
	);

	return 0;
};

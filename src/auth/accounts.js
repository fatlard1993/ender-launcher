import { chmod } from 'node:fs/promises';

import { readJson, writeJson } from '../json';
import { detail } from '../out';
import { paths } from '../paths';
import { fetchProfile, refresh, signIn, toMinecraft } from './microsoft';

const accountsPath = () => paths.accounts;

/** A minute of slack, so a token does not expire between being chosen and being used. */
const EXPIRY_MARGIN = 60_000;

export const readAccounts = async () => readJson(accountsPath(), { active: undefined, accounts: {} });

export const writeAccounts = async store => {
	await writeJson(accountsPath(), store);

	// Refresh tokens are account credentials; nobody else on the machine needs to read them.
	await chmod(accountsPath(), 0o600).catch(() => {});

	return store;
};

export const list = async () => {
	const { active, accounts } = await readAccounts();

	return Object.values(accounts).map(account => ({ ...account, active: account.name === active }));
};

/** Sign in and keep the result under the profile name Minecraft reports. */
export const add = async ({ clientId, onPrompt } = {}) => {
	const tokens = await signIn({ clientId, onPrompt });
	const minecraft = await toMinecraft(tokens.accessToken, clientId);
	const profile = await fetchProfile(minecraft.token);
	const store = await readAccounts();

	store.accounts[profile.name] = {
		name: profile.name,
		uuid: profile.id,
		clientId,
		refreshToken: tokens.refreshToken,
		token: minecraft.token,
		expiresAt: minecraft.expiresAt,
	};

	store.active ??= profile.name;

	await writeAccounts(store);

	return store.accounts[profile.name];
};

export const remove = async name => {
	const store = await readAccounts();

	if (store.accounts[name] === undefined) throw new Error(`No account named "${name}"`);

	delete store.accounts[name];

	if (store.active === name) store.active = Object.keys(store.accounts)[0];

	await writeAccounts(store);
};

export const use = async name => {
	const store = await readAccounts();

	if (store.accounts[name] === undefined) throw new Error(`No account named "${name}"`);

	store.active = name;

	await writeAccounts(store);
};

/**
 * The account an instance plays as, with its Minecraft token renewed if it has gone stale.
 * Renewal walks the whole chain again, because a Minecraft token is minted from an Xbox token
 * which is minted from a Microsoft one; only the last of those is long lived.
 */
export const resolveAccount = async wanted => {
	const store = await readAccounts();
	const name = wanted ?? store.active;

	if (name === undefined) return undefined;

	const account = store.accounts[name];

	if (account === undefined) throw new Error(`No account named "${name}". "mcm account" lists them.`);

	if (account.expiresAt > Date.now() + EXPIRY_MARGIN) return account;

	detail('auth', `renewing ${account.name}`);

	const tokens = await refresh({ refreshToken: account.refreshToken, clientId: account.clientId });
	const minecraft = await toMinecraft(tokens.accessToken, account.clientId);

	Object.assign(account, {
		refreshToken: tokens.refreshToken,
		token: minecraft.token,
		expiresAt: minecraft.expiresAt,
	});

	await writeAccounts(store);

	return account;
};

export const asProfile = account => ({
	name: account.name,
	uuid: account.uuid,
	accessToken: account.token,
	userType: 'msa',
	xuid: account.xuid ?? '0',
	clientId: account.clientId ?? '0',
});

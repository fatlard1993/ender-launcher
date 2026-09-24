import { chmod } from 'node:fs/promises';

import { readJson, writeJson } from '../json';
import { detail } from '../out';
import { paths } from '../paths';
import { offlineProfile, offlineUuid } from './offline';
import { fetchProfile, refresh, signIn, toMinecraft } from './microsoft';

/** Accounts stored before offline ones existed are all Microsoft ones. */
const kindOf = account => account.kind ?? 'microsoft';

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

	return Object.values(accounts).map(account => ({
		...account,
		kind: kindOf(account),
		active: account.name === active,
	}));
};

/** Sign in and keep the result under the profile name Minecraft reports. */
export const add = async ({ clientId, onPrompt } = {}) => {
	const tokens = await signIn({ clientId, onPrompt });
	const minecraft = await toMinecraft(tokens.accessToken, clientId);
	const profile = await fetchProfile(minecraft.token);
	const store = await readAccounts();

	store.accounts[profile.name] = {
		kind: 'microsoft',
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

/**
 * An identity that needs no sign in. Its uuid is derived from the name the way vanilla derives it,
 * so it is the same player a bare username would have been, just one you can name and switch to.
 */
export const addOffline = async name => {
	if (!/^\w{3,16}$/.test(name)) {
		throw new Error(`"${name}" is not a usable Minecraft name (3 to 16 letters, digits or underscore).`);
	}

	const store = await readAccounts();

	if (store.accounts[name] !== undefined) throw new Error(`An account named "${name}" already exists`);

	store.accounts[name] = { kind: 'offline', name, uuid: offlineUuid(name) };
	store.active ??= name;

	await writeAccounts(store);

	return store.accounts[name];
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

	if (account === undefined) throw new Error(`No account named "${name}". "ender account" lists them.`);

	// An offline identity has nothing to renew; it is a name and the uuid that follows from it.
	if (kindOf(account) === 'offline') return account;

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

export const asProfile = account =>
	kindOf(account) === 'offline'
		? { ...offlineProfile(account.name), online: false }
		: {
				name: account.name,
				uuid: account.uuid,
				accessToken: account.token,
				userType: 'msa',
				xuid: account.xuid ?? '0',
				clientId: account.clientId ?? '0',
				online: true,
			};

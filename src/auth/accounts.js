import { chmod } from 'node:fs/promises';

import { readJson, writeJson } from '../json';
import { detail } from '../out';
import { paths } from '../paths';
import { offlineProfile, offlineUuid } from './offline';
import { CLIENT_ID, fetchProfile, refresh, signIn, toMinecraft } from './microsoft';

/** Accounts stored before offline ones existed are all Microsoft ones. */
const kindOf = account => account.kind ?? 'microsoft';

const accountsPath = () => paths.accounts;

/**
 * A game keeps the token it launched with for as long as it stays open, and a Minecraft token lasts a day. One older
 * than an hour is renewed, so a launch always has nearly the whole day: a game left open overnight on a token near its
 * end has its joins refused by the next afternoon.
 */
const FRESH_FOR = 23 * 60 * 60_000;

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
		...(kindOf(account) === 'microsoft' && !renewsHere(account) ? { signInOnce: true } : {}),
	}));
};

/** Sign in and keep the result under the profile name Minecraft reports. */
export const add = async ({ onPrompt, qr } = {}) => {
	const tokens = await signIn({ onPrompt, qr });
	const { clientId } = tokens;
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
	const store = await readAccounts();

	if (store.accounts[name] !== undefined) throw new Error(`An account named "${name}" already exists`);

	return ensureOffline(name, { activate: true });
};

/** What Minecraft accepts as a player name. */
export const NAME = /^\w{3,16}$/;

const assertName = name => {
	if (!NAME.test(name ?? '')) {
		throw new Error(`"${name}" is not a usable Minecraft name (3 to 16 letters, digits or underscore).`);
	}
};

/** The account of this name, made as an offline one when there is none; `activate` makes it active if none is. */
export const ensureOffline = async (name, { activate = false } = {}) => {
	assertName(name);

	const store = await readAccounts();

	store.accounts[name] ??= { kind: 'offline', name, uuid: offlineUuid(name) };

	if (activate) store.active ??= name;

	await writeAccounts(store);

	return store.accounts[name];
};

/** Refuses a name no account has, so a typo is caught where it is typed rather than at the next launch. */
export const assertExists = async name => {
	if ((await readAccounts()).accounts[name] === undefined) {
		throw new Error(`No account named "${name}". "ender account" lists them.`);
	}
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

/** Walk a Microsoft account's tokens forward from its refresh token, keeping what each step returns. */
const renew = async account => {
	const tokens = await refresh({
		refreshToken: account.refreshToken,
		clientId: account.clientId,
		scope: account.scope,
	});
	const minecraft = await toMinecraft(tokens.accessToken, account.clientId);

	return Object.assign(account, {
		refreshToken: tokens.refreshToken,
		token: minecraft.token,
		expiresAt: minecraft.expiresAt,
	});
};

/**
 * The Microsoft accounts Prism signed in, each signed in once more through ender's own app: Prism's tokens answer to
 * Prism's app registration, whose credentials are Prism's to use, not ender's. Each sign in is kept under the profile
 * Minecraft reports, in place of an offline stand-in of that name, and Prism's active account becomes the active one.
 * Nothing of Prism's is kept but the names, to ask for.
 */
export const importPrism = async (file, { signInOnce = add, asking = () => {} } = {}) => {
	const prism = await readJson(file, undefined);

	if (prism === undefined) throw new Error(`No Prism accounts at ${file}`);

	const results = [];

	for (const entry of prism.accounts ?? []) {
		const name = entry.profile?.name;

		if (entry.type !== 'MSA' || !name) continue;

		asking(name);

		try {
			const account = await signInOnce();

			if (entry.active) await use(account.name);

			results.push({ name, signedIn: account.name });
		} catch (error) {
			results.push({ name, error: error.message });
		}
	}

	return results;
};

/**
 * Whether ender renews an account's sign in: only one made through its own app. One taken over from Prism, or made
 * before ender had an app of its own, answers to another launcher's registration, which is not ender's to use.
 */
export const renewsHere = account => account.clientId === CLIENT_ID;

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

	if (account.expiresAt > Date.now() + FRESH_FOR) return account;

	if (!renewsHere(account)) {
		throw new Error(
			`${account.name} was signed in through another launcher's app, as one taken over from Prism was, and ender renews a sign in only through its own: sign in once with "ender account add", and ${account.name} is kept as it was`,
		);
	}

	detail('auth', `renewing ${account.name}`);

	await renew(account);
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

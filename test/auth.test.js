import { mkdtemp, rm } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { offlineUuid } from '../src/auth/offline';

let home;
let previous;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), 'ender-auth-'));
	previous = process.env.ENDER_HOME;
	process.env.ENDER_HOME = home;
});

afterEach(async () => {
	if (previous === undefined) delete process.env.ENDER_HOME;
	else process.env.ENDER_HOME = previous;

	await rm(home, { recursive: true, force: true });
});

// Paths are read when asked, so one import honors whatever ENDER_HOME each test sets.
const accountsModule = async () => import('../src/auth/accounts');

describe('account storage', () => {
	test('starts empty and says so', async () => {
		const accounts = await accountsModule();

		expect(await accounts.list()).toEqual([]);
		expect((await accounts.readAccounts()).active).toBeUndefined();
	});

	test('round trips, and marks exactly one active', async () => {
		const accounts = await accountsModule();

		await accounts.writeAccounts({
			active: 'one',
			accounts: {
				one: { name: 'one', uuid: 'a', expiresAt: Date.now() + 1e6 },
				two: { name: 'two', uuid: 'b', expiresAt: Date.now() + 1e6 },
			},
		});

		const listed = await accounts.list();

		expect(listed).toHaveLength(2);
		expect(listed.filter(account => account.active).map(account => account.name)).toEqual(['one']);
	});

	// Refresh tokens are credentials; the file holding them should not be world readable.
	test('is written with owner-only permissions', async () => {
		const accounts = await accountsModule();

		await accounts.writeAccounts({ active: undefined, accounts: {} });

		const mode = (await stat(join(home, 'accounts.json'))).mode & 0o777;

		expect(mode).toBe(0o600);
	});

	test('choosing an account that is not there names the mistake', async () => {
		const accounts = await accountsModule();

		await expect(accounts.use('ghost')).rejects.toThrow('No account named "ghost"');
		await expect(accounts.resolveAccount('ghost')).rejects.toThrow('No account named "ghost"');
	});

	test('removing the active one hands the slot to whatever remains', async () => {
		const accounts = await accountsModule();

		await accounts.writeAccounts({
			active: 'one',
			accounts: { one: { name: 'one' }, two: { name: 'two' } },
		});
		await accounts.remove('one');

		expect((await accounts.readAccounts()).active).toBe('two');
	});
});

describe('offline accounts', () => {
	test('derive the same uuid a bare username would have', async () => {
		const accounts = await accountsModule();
		const account = await accounts.addOffline('Tester');

		expect(account.kind).toBe('offline');
		expect(account.uuid).toBe(offlineUuid('Tester'));
	});

	test('refuse a name Minecraft would not accept', async () => {
		const accounts = await accountsModule();

		for (const bad of ['no', 'way-too-long-a-name-here', 'has space', 'bad!']) {
			await expect(accounts.addOffline(bad)).rejects.toThrow('not a usable Minecraft name');
		}
	});

	test('will not quietly replace one that exists', async () => {
		const accounts = await accountsModule();

		await accounts.addOffline('Tester');
		await expect(accounts.addOffline('Tester')).rejects.toThrow('already exists');
	});

	test('sit beside microsoft ones and switch the same way', async () => {
		const accounts = await accountsModule();

		await accounts.writeAccounts({
			active: 'signedin',
			accounts: {
				signedin: { kind: 'microsoft', name: 'signedin', uuid: 'x', expiresAt: Date.now() + 1e6 },
			},
		});
		await accounts.addOffline('Tester');
		await accounts.use('Tester');

		const listed = await accounts.list();

		expect(listed.map(account => account.kind).sort()).toEqual(['microsoft', 'offline']);
		expect(listed.find(account => account.active).name).toBe('Tester');
	});

	// An offline identity has no token, so resolving one must not try to renew anything.
	test('resolve without reaching for the network', async () => {
		const accounts = await accountsModule();

		await accounts.addOffline('Tester');

		const resolved = await accounts.resolveAccount('Tester');

		expect(resolved.name).toBe('Tester');
		expect(resolved.token).toBeUndefined();
	});
});

describe('who an instance plays as', () => {
	test('falls back to the offline identity when nobody is signed in', async () => {
		const { profileFor } = await import('../src/auth');
		const profile = await profileFor({ username: 'Notch' });

		expect(profile.online).toBe(false);
		expect(profile.uuid).toBe(offlineUuid('Notch'));
		expect(profile.userType).toBe('legacy');
	});

	test('an offline account plays as itself, not as the configured username', async () => {
		const accounts = await accountsModule();

		await accounts.addOffline('Tester');

		const { profileFor } = await import('../src/auth');
		const profile = await profileFor({ username: 'Ignored' });

		expect(profile.name).toBe('Tester');
		expect(profile.online).toBe(false);
		expect(profile.uuid).toBe(offlineUuid('Tester'));
	});

	test('uses a stored account when there is one, and says it is online', async () => {
		const accounts = await accountsModule();

		await accounts.writeAccounts({
			active: 'player',
			accounts: {
				player: {
					kind: 'microsoft',
					name: 'player',
					uuid: 'abc',
					token: 'secret',
					expiresAt: Date.now() + 1e6,
					clientId: 'cid',
				},
			},
		});

		const { profileFor } = await import('../src/auth');
		const profile = await profileFor({});

		expect(profile.online).toBe(true);
		expect(profile.name).toBe('player');
		expect(profile.userType).toBe('msa');
		expect(profile.accessToken).toBe('secret');
	});
});

describe('account listing for scripts', () => {
	// The dotfiles hook decides whether to add an offline identity by looking at this
	// output. It used to read the human listing and match "a marker, a space, a word",
	// which the indented help under "No accounts yet." also satisfies - so a machine with
	// no account at all read as already set up, and never got one.
	const captured = async flags => {
		const { ls } = await import('../src/commands/account');
		const lines = [];
		const real = console.log;

		console.log = (...args) => lines.push(args.join(' '));

		try {
			await ls({ flags });
		} finally {
			console.log = real;
		}

		return lines;
	};

	test('says nothing at all when there are no accounts', async () => {
		expect(await captured({ names: true })).toEqual([]);
	});

	test('prints one bare name per account', async () => {
		const accounts = await accountsModule();

		await accounts.addOffline('Steve');
		await accounts.addOffline('Alex');

		expect((await captured({ names: true })).sort()).toEqual(['Alex', 'Steve']);
	});

	test('still prints the guidance without the flag', async () => {
		const lines = await captured({});

		expect(lines.some(line => line.includes('No accounts yet'))).toBe(true);
	});
});

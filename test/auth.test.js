import { mkdtemp, rm } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { offlineUuid } from '../src/auth/offline';

let home;
let previous;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), 'mcm-auth-'));
	previous = process.env.MCM_HOME;
	process.env.MCM_HOME = home;
});

afterEach(async () => {
	if (previous === undefined) delete process.env.MCM_HOME;
	else process.env.MCM_HOME = previous;

	await rm(home, { recursive: true, force: true });
});

// Paths are read when asked, so one import honors whatever MCM_HOME each test sets.
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

describe('who an instance plays as', () => {
	test('falls back to the offline identity when nobody is signed in', async () => {
		const { profileFor } = await import('../src/auth');
		const profile = await profileFor({ username: 'Notch' });

		expect(profile.online).toBe(false);
		expect(profile.uuid).toBe(offlineUuid('Notch'));
		expect(profile.userType).toBe('legacy');
	});

	test('uses a stored account when there is one, and says it is online', async () => {
		const accounts = await accountsModule();

		await accounts.writeAccounts({
			active: 'player',
			accounts: {
				player: { name: 'player', uuid: 'abc', token: 'secret', expiresAt: Date.now() + 1e6, clientId: 'cid' },
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

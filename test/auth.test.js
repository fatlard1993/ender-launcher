import { mkdtemp, rm } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { printSignIn, signInLines } from '../src/auth/microsoft';
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
				one: { name: 'one', uuid: 'a', expiresAt: Date.now() + 864e5 },
				two: { name: 'two', uuid: 'b', expiresAt: Date.now() + 864e5 },
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
				signedin: { kind: 'microsoft', name: 'signedin', uuid: 'x', expiresAt: Date.now() + 864e5 },
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
					expiresAt: Date.now() + 864e5,
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
	// A provisioning script branches on this output, so it is a line to test, not prose to match by shape.
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

	test('says Microsoft sign in needs a registration of your own when ender has none', async () => {
		const lines = await captured({});

		expect(lines.some(line => line.includes('app registration of your own'))).toBe(true);
	});
});

describe('adding an offline account', () => {
	const added = async name => {
		const { add } = await import('../src/commands/account');
		const lines = [];
		const real = console.log;

		console.log = (...args) => lines.push(args.join(' '));

		try {
			await add({ positionals: [name], flags: { offline: true } });
		} finally {
			console.log = real;
		}

		return lines.join('\n');
	};

	test('says the first one is who instances now play as', async () => {
		expect(await added('Steve')).toContain('instances play as Steve unless given another');
	});

	test('says a later one changes nothing until chosen', async () => {
		await added('Steve');

		expect(await added('Alex')).toContain('instances still play as Steve; "ender account use Alex" switches');
	});
});

describe('accounts taken over from Prism', () => {
	const prismFile = async accounts => {
		const file = join(home, 'prism-accounts.json');

		await Bun.write(file, JSON.stringify({ formatVersion: 3, accounts }));

		return file;
	};
	const msa = (name, extra = {}) => ({
		type: 'MSA',
		'msa-client-id': 'prism-cid',
		msa: { refresh_token: `refresh-${name}` },
		profile: { id: `uuid-${name}`, name },
		...extra,
	});
	const renewal = async account => ({
		...account,
		refreshToken: `${account.refreshToken}-rotated`,
		token: 't',
		expiresAt: 1,
	});

	// The player played online through Prism and offline under the same name through ender: the sign in replaces the stand-in
	test('replace the offline stand-in of the same name and become active', async () => {
		const accounts = await accountsModule();

		await accounts.addOffline('Ben');

		const file = await prismFile([msa('Ben', { active: true }), { type: 'Offline', profile: { name: 'Local' } }]);

		expect(await accounts.importPrism(file, { renewal })).toEqual([{ name: 'Ben' }]);

		const { active, accounts: stored } = await accounts.readAccounts();

		expect(active).toBe('Ben');
		expect(stored.Ben).toEqual({
			kind: 'microsoft',
			name: 'Ben',
			uuid: 'uuid-Ben',
			clientId: 'prism-cid',
			refreshToken: 'refresh-Ben-rotated',
			scope: 'XboxLive.SignIn XboxLive.offline_access',
			token: 't',
			expiresAt: 1,
		});
	});

	test('keep nothing for one that no longer renews, and say why', async () => {
		const accounts = await accountsModule();

		await accounts.addOffline('Ben');

		const file = await prismFile([msa('Ben', { active: true })]);
		const refused = async () => {
			throw new Error('Could not refresh the sign in (invalid_grant). Sign in again.');
		};

		expect(await accounts.importPrism(file, { renewal: refused })).toEqual([
			{ name: 'Ben', error: 'Could not refresh the sign in (invalid_grant). Sign in again.' },
		]);
		expect((await accounts.readAccounts()).accounts.Ben.kind).toBe('offline');
	});

	test('names the file when Prism has none', async () => {
		const accounts = await accountsModule();

		await expect(accounts.importPrism(join(home, 'missing.json'), { renewal })).rejects.toThrow('missing.json');
	});
});

describe('renewal before a launch', () => {
	// A game holds its token until it closes, so a launch on one near its end loses its joins partway through
	test('renews a token older than an hour, though it has not expired', async () => {
		const accounts = await accountsModule();

		await accounts.writeAccounts({
			active: 'player',
			accounts: {
				player: {
					kind: 'microsoft',
					name: 'player',
					uuid: 'abc',
					token: 'old',
					expiresAt: Date.now() + 3600e3,
					clientId: 'cid',
				},
			},
		});

		const requested = [];
		const realFetch = globalThis.fetch;

		globalThis.fetch = async url => {
			requested.push(String(url));

			return Response.json({ error: 'offline in tests' }, { status: 400 });
		};

		try {
			await expect(accounts.resolveAccount()).rejects.toThrow('Could not refresh');
		} finally {
			globalThis.fetch = realFetch;
		}

		expect(requested[0]).toContain('oauth2/v2.0/token');
	});
});

describe('a username from before accounts held who plays', () => {
	const instanceFile = name => join(home, 'instances', name, 'instance.json');

	test('in config becomes the active offline account, and leaves config', async () => {
		await Bun.write(join(home, 'config.json'), JSON.stringify({ username: 'Chase', memory: { min: 1, max: 2 } }));

		const { adoptConfiguredName } = await import('../src/auth/adopt');

		await adoptConfiguredName();

		const accounts = await accountsModule();

		expect((await accounts.list()).map(({ name, kind, active }) => [name, kind, active])).toEqual([
			['Chase', 'offline', true],
		]);
		expect(await Bun.file(join(home, 'config.json')).json()).toEqual({ memory: { min: 1, max: 2 } });
	});

	test('the default name makes no account', async () => {
		await Bun.write(join(home, 'config.json'), JSON.stringify({ username: 'Player' }));

		const { adoptConfiguredName } = await import('../src/auth/adopt');

		await adoptConfiguredName();

		expect(await (await accountsModule()).list()).toEqual([]);
	});

	test('on an instance becomes the offline account it is assigned, without taking the active slot', async () => {
		await Bun.write(
			instanceFile('old'),
			JSON.stringify({ name: 'old', minecraft: '26.3', loader: { type: 'fabric' }, username: 'Kid_2', mods: [] }),
		);

		const instances = await import('../src/instance');
		const manifest = await instances.read('old');

		expect(manifest.account).toBe('Kid_2');
		expect(manifest.username).toBeUndefined();
		expect((await Bun.file(instanceFile('old')).json()).username).toBeUndefined();
		expect((await (await accountsModule()).readAccounts()).active).toBeUndefined();
	});
});

describe('who plays, as a script or a page reads it', () => {
	test('lists each account as JSON, never its tokens', async () => {
		const accounts = await accountsModule();

		await accounts.writeAccounts({
			active: 'player',
			accounts: { player: { kind: 'microsoft', name: 'player', uuid: 'abc', token: 'secret', refreshToken: 'secret' } },
		});

		const { ls } = await import('../src/commands/account');
		const lines = [];
		const real = console.log;

		console.log = (...args) => lines.push(args.join(' '));

		try {
			await ls({ flags: { json: true } });
		} finally {
			console.log = real;
		}

		expect(lines.join('')).not.toContain('secret');
		expect(JSON.parse(lines.join(''))).toEqual({
			signIn: false,
			fallback: 'Player',
			accounts: [{ name: 'player', kind: 'microsoft', uuid: 'abc', active: true }],
		});
	});

	test('ender config username names an offline account and plays as it', async () => {
		const { config } = await import('../src/commands/settings');
		const real = console.log;

		console.log = () => {};

		try {
			await config({ positionals: ['username', 'Alex'] });
		} finally {
			console.log = real;
		}

		expect((await (await accountsModule()).list()).map(({ name, active }) => [name, active])).toEqual([['Alex', true]]);
	});

	test('an instance cannot be given an account nobody has', async () => {
		await expect((await accountsModule()).assertExists('Nobody')).rejects.toThrow('No account named "Nobody"');
	});
});

describe('the lines a Microsoft sign in prints', () => {
	const printed = qr => {
		const lines = [];
		const real = console.log;

		console.log = (...args) => lines.push(stripVTControlCharacters(args.join(' ')));

		try {
			printSignIn({ verification_uri: 'https://www.microsoft.com/link', user_code: 'ABCD1234' }, { qr });
		} finally {
			console.log = real;
		}

		return lines.flatMap(line => line.split('\n'));
	};

	test('prints the link and code lines the page reads, as it reads them', () => {
		const lines = printed(false);
		const said = key => lines.map(line => line.match(new RegExp(`^\\s*${key} (\\S+)`))?.[1]).find(Boolean);

		expect(said('link')).toBe('https://www.microsoft.com/link');
		expect(said('code')).toBe('ABCD1234');
	});

	test('says to scan only when there is a square to scan', () => {
		expect(printed(false).join('\n')).toContain('Open https://www.microsoft.com/link');
		expect(printed(false).join('\n')).not.toContain('Scan');
		expect(printed(true).join('\n')).toContain('Scan the code above');
	});

	test('hand over the page and the code apart, with no code in the link for Microsoft to refuse', () => {
		const lines = signInLines({ verification_uri: 'https://www.microsoft.com/link', user_code: 'ABCD1234' });

		expect(lines).toEqual(['link https://www.microsoft.com/link', 'code ABCD1234']);
		expect(lines.join('\n')).not.toContain('otc');
	});
});

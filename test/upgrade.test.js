import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, spyOn, test } from 'bun:test';

import { withFetch } from './fetch';

describe('ender upgrade', () => {
	test('downloads the build named for this system and chip, and none for one there is no build for', async () => {
		const { binaryFor } = await import('../src/commands/upgrade');

		expect(binaryFor('linux', 'x64')).toBe('ender-linux-x64');
		expect(binaryFor('darwin', 'arm64')).toBe('ender-darwin-arm64');
		expect(binaryFor('win32', 'x64')).toBe('ender-windows-x64.exe');
		expect(() => binaryFor('win32', 'arm64')).toThrow('no ender build for win32 on arm64');
		expect(() => binaryFor('freebsd', 'x64')).toThrow('no ender build for freebsd');
	});

	test('replaces only a compiled ender, and leaves a checkout to git', async () => {
		const { isCompiled, upgrade } = await import('../src/commands/upgrade');

		expect(isCompiled('/$bunfs/root/ender')).toBe(true);
		expect(isCompiled('B:/~BUN/root/ender.exe')).toBe(true);
		expect(isCompiled('/home/me/ender-launcher/index.js')).toBe(false);
		await expect(upgrade({ flags: {} })).rejects.toThrow('git pull');
	});

	test('leaves an ender Homebrew installed to brew', async () => {
		const { isBrewed } = await import('../src/commands/upgrade');

		expect(isBrewed('/opt/homebrew/Cellar/ender/0.1.0/bin/ender')).toBe(true);
		expect(isBrewed('/home/linuxbrew/.linuxbrew/Cellar/ender/0.1.0/bin/ender')).toBe(true);
		expect(isBrewed('/home/me/.local/bin/ender')).toBe(false);
	});

	test('says who brings it up to date, which the web page offers or explains', async () => {
		const { whoUpgrades } = await import('../src/commands/upgrade');

		expect(whoUpgrades({ compiled: false })).toBe('checkout');
		expect(whoUpgrades({ compiled: true, path: '/opt/homebrew/Cellar/ender/0.2.0/bin/ender' })).toBe('brew');
		expect(whoUpgrades({ compiled: true, path: '/Applications/Ender.app/Contents/MacOS/ender' })).toBe('self');
	});

	test('knows the app bundle it is the executable of, so it can seal the bundle again', async () => {
		const { appBundleOf } = await import('../src/commands/upgrade');

		expect(appBundleOf('/Applications/Ender.app/Contents/MacOS/ender')).toBe('/Applications/Ender.app');
		expect(appBundleOf('/home/me/.local/bin/ender')).toBeUndefined();
	});
});

describe('replacing the binary', () => {
	const sha256 = bytes => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
	const release = (binary, sums) => ({
		tag_name: 'v9.9.9',
		assets: [
			{ name: binary, browser_download_url: `https://dl/${binary}` },
			{ name: 'SHA256SUMS', browser_download_url: 'https://dl/SHA256SUMS' },
		],
		sums,
	});
	const answering = (listed, served) => (url, binary) => {
		if (url.endsWith('/releases/latest')) return Response.json(release(binary));
		if (url === `https://dl/${binary}`) return new Response(served);
		if (url === 'https://dl/SHA256SUMS') return new Response(`${listed}  ${binary}\n`);
	};
	const machine = async (platform, home) => {
		const execPath = join(home, platform === 'win32' ? 'ender.exe' : 'ender');

		await Bun.write(execPath, 'the old ender');

		return { compiled: true, execPath, platform, arch: 'x64' };
	};

	test('a download that is not the file the release lists changes nothing, and leaves nothing behind', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ender-upgrade-'));

		try {
			const { upgrade, binaryFor } = await import('../src/commands/upgrade');
			const me = await machine('linux', home);
			const binary = binaryFor('linux', 'x64');
			const quiet = spyOn(console, 'log').mockImplementation(() => {});

			try {
				await withFetch(
					url => answering(sha256('what the release says'), 'something else')(url, binary),
					() =>
						expect(upgrade({ flags: {} }, me)).rejects.toThrow(
							`${binary} is not the file ender 9.9.9 lists; nothing was changed`,
						),
				);
			} finally {
				quiet.mockRestore();
			}

			expect(await Bun.file(me.execPath).text()).toBe('the old ender');
			expect(await readdir(home)).toEqual(['ender']);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test('a download that matches takes the place of the binary, moved aside first on Windows alone', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ender-upgrade-'));

		try {
			const { upgrade, binaryFor } = await import('../src/commands/upgrade');
			const quiet = spyOn(console, 'log').mockImplementation(() => {});

			try {
				for (const platform of ['linux', 'win32']) {
					const me = await machine(platform, home);
					const binary = binaryFor(platform, 'x64');

					await withFetch(
						url => answering(sha256('the new ender'), 'the new ender')(url, binary),
						() => upgrade({ flags: {} }, me),
					);

					expect(await Bun.file(me.execPath).text()).toBe('the new ender');
					expect((await stat(me.execPath)).mode & 0o111).not.toBe(0);
				}
			} finally {
				quiet.mockRestore();
			}

			expect((await readdir(home)).sort()).toEqual(['ender', 'ender.exe', 'ender.exe.old']);
			expect(await Bun.file(join(home, 'ender.exe.old')).text()).toBe('the old ender');
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

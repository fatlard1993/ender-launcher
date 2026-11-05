import { describe, expect, test } from 'bun:test';

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

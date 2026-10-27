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
});

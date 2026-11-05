import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { icns, ico } from '../scripts/icons';
import {
	addIcon,
	desktopEntry,
	infoPlist,
	linkForTerminal,
	macLauncher,
	removeIcon,
	stableCommand,
	startedAsApp,
	terminalStatus,
} from '../src/desktop';

let home;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), 'ender-desktop-'));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

describe('the desktop icon', () => {
	test('runs ender web until its page is closed, from a path with spaces and quotes intact', () => {
		expect(macLauncher(["/Users/o'neil/my bin/ender"])).toContain(
			`'/Users/o'\\''neil/my bin/ender' 'web' '--until-idle' >> "$HOME/Library/Logs/ender.log" 2>&1 &`,
		);
		expect(desktopEntry(['/home/me/my bin/ender'], '/icons/ender.png')).toContain(
			'Exec="/home/me/my bin/ender" "web" "--until-idle"',
		);
	});

	test('a checkout runs as bun and its entry point', () => {
		expect(desktopEntry(['/usr/bin/bun', '/src/ender/index.js'], 'x')).toContain(
			'Exec="/usr/bin/bun" "/src/ender/index.js" "web" "--until-idle"',
		);
	});

	test("points at Homebrew's bin rather than a Cellar an upgrade removes", () => {
		expect(stableCommand(['/opt/homebrew/Cellar/ender/0.1.14/bin/ender'])).toEqual(['/opt/homebrew/bin/ender']);
		expect(stableCommand(['/home/me/.local/bin/ender'])).toEqual(['/home/me/.local/bin/ender']);
	});

	test('the bundle names its executable and icon, and stays out of the Dock', () => {
		const plist = infoPlist({ executable: 'Ender', release: '1.2.3' });

		expect(plist).toContain('<key>CFBundleExecutable</key><string>Ender</string>');
		expect(plist).toContain('<key>CFBundleIconFile</key><string>ender</string>');
		expect(plist).toContain('<key>CFBundleShortVersionString</key><string>1.2.3</string>');
		expect(plist).toContain('<key>LSUIElement</key><true/>');
	});

	test('is told apart from a terminal run by where the binary sits, not by having no arguments', () => {
		const app = '/Applications/Ender.app/Contents/MacOS/ender';

		expect(startedAsApp([], app, false, 1)).toBe(true);
		expect(startedAsApp(['-psn_0_12345'], app, false, 1)).toBe(true);
		expect(startedAsApp(['ls'], app, false, 1)).toBe(false);
		expect(startedAsApp([], '/home/me/.local/bin/ender', false, 1)).toBe(false);
	});

	test('a bare ender through its link runs as a command from Terminal, ssh or cron, whose parent is not launchd', () => {
		const app = '/Applications/Ender.app/Contents/MacOS/ender';

		expect(startedAsApp([], app, true, 1)).toBe(false);
		expect(startedAsApp([], app, false, 4242)).toBe(false);
		expect(startedAsApp([], app)).toBe(false);
	});

	test('on Linux, an entry in the app menu and its icon, both taken away again', async () => {
		const previous = process.env.XDG_DATA_HOME;

		delete process.env.XDG_DATA_HOME;

		try {
			const entry = await addIcon({ command: ['/bin/ender'], platform: 'linux', home });

			expect(entry).toBe(join(home, '.local/share/applications/ender-launcher.desktop'));
			expect(await Bun.file(entry).text()).toContain(
				`Icon=${join(home, '.local/share/icons/hicolor/512x512/apps/ender-launcher.png')}`,
			);
			expect((await removeIcon({ platform: 'linux', home })).length).toBe(2);
			expect(await Bun.file(entry).exists()).toBe(false);
			expect(await removeIcon({ platform: 'linux', home })).toEqual([]);
		} finally {
			if (previous !== undefined) process.env.XDG_DATA_HOME = previous;
		}
	});

	test('on macOS, an app in ~/Applications with an executable launcher and the icns', async () => {
		const app = await addIcon({ command: ['/bin/ender'], platform: 'darwin', home });
		const launcher = join(app, 'Contents/MacOS/Ender');

		expect(app).toBe(join(home, 'Applications/Ender.app'));
		expect((await stat(launcher)).mode & 0o111).not.toBe(0);
		expect((await Bun.file(join(app, 'Contents/Resources/ender.icns')).bytes()).subarray(0, 4)).toEqual(
			new TextEncoder().encode('icns'),
		);
		expect(await removeIcon({ platform: 'darwin', home })).toEqual([app]);
	});

	test('on Windows, a minimized Start menu shortcut to ender web with the ico beside ender', async () => {
		const made = [];
		const previous = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };

		process.env.APPDATA = join(home, 'Roaming');
		process.env.LOCALAPPDATA = join(home, 'Local');

		try {
			await addIcon({
				command: ['C:\\ender\\ender.exe'],
				platform: 'win32',
				home,
				shortcut: async shortcut => made.push(shortcut),
			});
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}

		expect(made).toEqual([
			{
				shortcut: join(home, 'Roaming/Microsoft/Windows/Start Menu/Programs/Ender.lnk'),
				target: 'C:\\ender\\ender.exe',
				args: 'web --until-idle',
				icon: join(home, 'Local/ender/ender.ico'),
			},
		]);
		expect(await Bun.file(join(home, 'Local/ender/ender.ico')).exists()).toBe(true);
	});
});

describe('the desktop icons', () => {
	const pngs = { 16: Buffer.from('sixteen'), 256: Buffer.from('two hundred fifty-six') };

	test('an icns is its magic and whole length, then each png under the type naming its size', () => {
		const written = icns(pngs);

		expect(written.toString('latin1', 0, 4)).toBe('icns');
		expect(written.readUInt32BE(4)).toBe(written.length);
		expect(written.toString('latin1', 8, 12)).toBe('icp4');
		expect(written.readUInt32BE(12)).toBe(8 + pngs[16].length);
		expect(written.toString('latin1', 8 + 8 + pngs[16].length, 8 + 8 + pngs[16].length + 4)).toBe('ic08');
	});

	test('an ico lists each size, 256 written as 0, pointing at its png', () => {
		const written = ico(pngs);

		expect(written.readUInt16LE(2)).toBe(1);
		expect(written.readUInt16LE(4)).toBe(2);
		expect(written.readUInt8(6)).toBe(16);
		expect(written.readUInt8(6 + 16)).toBe(0);

		const offset = written.readUInt32LE(6 + 16 + 12);

		expect(written.subarray(offset).toString()).toBe('two hundred fifty-six');
	});
});

describe("a Mac's Terminal", () => {
	const binary = '/Applications/Ender.app/Contents/MacOS/ender';
	const linked = async () => ({ code: 0, stderr: '' });

	test('is not offered a link for an ender outside an app bundle', async () => {
		expect(await terminalStatus(undefined)).toBeUndefined();
		await expect(linkForTerminal(undefined, { run: linked, link: join(home, 'ender') })).rejects.toMatchObject({
			reason: 'outside',
		});
	});

	test('says whether its ender is this one, with a line to paste that makes the folder first', async () => {
		const own = join(home, 'Ender.app', 'Contents', 'MacOS', 'ender');
		const link = join(home, 'bin', 'ender');

		await Bun.write(own, '');

		expect(await terminalStatus(own, link)).toEqual({
			linked: false,
			line: `sudo mkdir -p ${join(home, 'bin')} && sudo ln -sfh '${own}' ${link}`,
		});

		await Bun.write(join(home, 'bin', '.keep'), '');
		await symlink(own, link);

		expect((await terminalStatus(own, link)).linked).toBe(true);
	});

	test('names another ender at the link and never links over it, before asking for a password', async () => {
		const own = join(home, 'Ender.app', 'Contents', 'MacOS', 'ender');
		const link = join(home, 'ender');
		const run = () => expect.unreachable();

		await Bun.write(own, '');
		await symlink('/usr/local/Cellar/ender/0.2.3/bin/ender', link);

		expect((await terminalStatus(own, link)).occupied).toBe('/usr/local/Cellar/ender/0.2.3/bin/ender');
		await expect(linkForTerminal(own, { run, link })).rejects.toMatchObject({ reason: 'occupied' });
	});

	test("replaces a link into another Ender.app, as that one is Ender's own", async () => {
		const own = join(home, 'Ender.app', 'Contents', 'MacOS', 'ender');
		const link = join(home, 'ender');

		await Bun.write(own, '');
		await symlink('/Users/me/Old/Ender.app/Contents/MacOS/ender', link);

		expect(await terminalStatus(own, link)).not.toHaveProperty('occupied');
		await linkForTerminal(own, { run: linked, link });
	});

	test('links the binary behind a password prompt that names Ender, handing its path over as an argument rather than as script', async () => {
		const ran = [];

		await linkForTerminal(binary, {
			link: join(home, 'ender'),
			run: async command => {
				ran.push(command);

				return { code: 0, stderr: '' };
			},
		});

		expect(ran[0][0]).toBe('osascript');
		expect(ran[0].at(-1)).toBe(binary);
		expect(ran[0].join(' ')).toContain('with prompt "Ender is adding the ender command to Terminal."');
		expect(ran[0].join(' ')).toContain('with administrator privileges');
		expect(ran[0].join(' ')).toContain('ln -sfh');
		expect(ran[0].slice(0, -1).join(' ')).not.toContain(binary);
	});

	test('asks for one password at a time', async () => {
		let release;
		const slow = () => new Promise(resolve => (release = () => resolve({ code: 0, stderr: '' })));
		const link = join(home, 'ender');
		const first = linkForTerminal(binary, { run: slow, link });

		await new Promise(resolve => setTimeout(resolve, 10));
		await expect(linkForTerminal(binary, { run: linked, link })).rejects.toMatchObject({ reason: 'busy' });
		release();
		await first;
	});

	test('says a dismissed password prompt linked nothing', async () => {
		const dismissed = async () => ({ code: 1, stderr: 'execution error: User canceled. (-128)' });

		await expect(linkForTerminal(binary, { run: dismissed, link: join(home, 'ender') })).rejects.toMatchObject({
			reason: 'canceled',
		});
	});

	test('refuses to link a copy macOS will discard, before asking for a password, but not an install on another disk', async () => {
		const run = () => expect.unreachable();
		const link = join(home, 'ender');

		for (const copy of [
			'/private/var/folders/x/AppTranslocation/ABC/d/Ender.app/Contents/MacOS/ender',
			'/Volumes/Ender/Ender.app/Contents/MacOS/ender',
			'/Volumes/Ender 1/Ender.app/Contents/MacOS/ender',
		]) {
			await expect(linkForTerminal(copy, { run, link })).rejects.toMatchObject({ reason: 'refused' });
		}

		expect(await terminalStatus('/Volumes/Games/Applications/Ender.app/Contents/MacOS/ender', link)).not.toHaveProperty(
			'refused',
		);
	});
});

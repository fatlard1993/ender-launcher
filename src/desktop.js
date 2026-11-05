import { chmod, mkdir, readlink, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isatty } from 'node:tty';

import icnsFile from '../assets/ender.icns' with { type: 'file' };
import icoFile from '../assets/ender.ico' with { type: 'file' };
import pngFile from '../assets/ender.png' with { type: 'file' };
import { version } from '../package.json';

export const APP_NAME = 'Ender';

/** What the icon runs: ender web, stopping once its page is closed, since an icon leaves no terminal to stop it from. */
export const ICON_ARGS = ['web', '--until-idle'];

/** Where an ender started without a terminal writes what it says. */
export const iconLog = (home = homedir()) => join(home, 'Library', 'Logs', 'ender.log');

/** The ender a running copy is reached by: Homebrew's bin link rather than its Cellar, which moves on each upgrade. */
export const stableCommand = command =>
	command.map((part, index) => (index === 0 ? part.replace(/\/Cellar\/ender\/[^/]+\/bin\//, '/bin/') : part));

/**
 * A double-click on an app bundle runs its executable with no arguments, or with the process serial number older macOS
 * adds, with no terminal, as a child of launchd, process 1; `ender` run through its link into the PATH, from Terminal,
 * ssh or cron, has another parent.
 */
export const startedAsApp = (argv, execPath = process.execPath, interactive = isatty(0), parent = process.ppid) =>
	!interactive &&
	parent === 1 &&
	/\.app\/Contents\/MacOS\/[^/]+$/.test(execPath) &&
	argv.every(arg => arg.startsWith('-psn_'));

const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export const infoPlist = ({ executable, release = version }) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>${APP_NAME}</string>
	<key>CFBundleDisplayName</key><string>${APP_NAME}</string>
	<key>CFBundleIdentifier</key><string>io.github.fatlard1993.ender</string>
	<key>CFBundleExecutable</key><string>${xml(executable)}</string>
	<key>CFBundleIconFile</key><string>ender</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>${xml(release)}</string>
	<key>CFBundleVersion</key><string>${xml(release)}</string>
	<key>LSMinimumSystemVersion</key><string>11.0</string>
	<key>LSUIElement</key><true/>
</dict>
</plist>
`;

const shellQuoted = text => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * The executable of an app bundle made on this machine: it starts ender web in the background and exits, so each
 * double-click runs it again and finds the one already running, where macOS would only bring a running app forward.
 */
export const macLauncher = command => `#!/bin/sh
mkdir -p "$HOME/Library/Logs"
${[...command, ...ICON_ARGS].map(shellQuoted).join(' ')} >> "$HOME/Library/Logs/ender.log" 2>&1 &
`;

/** Where a Mac's Terminal finds a command with nothing added to its PATH. */
export const TERMINAL_LINK = '/usr/local/bin/ender';

/** A link into some Ender.app, this one or one installed before it elsewhere, which a new link may replace. */
const ENDER_APP_BINARY = /\.app\/Contents\/MacOS\/ender$/;

/** How osascript ends when the user dismisses the password prompt. */
const DISMISSED = '(-128)';

/** A link into Terminal that could not be made, and which of the ways it fails, for the page to tell apart. */
export class TerminalLinkError extends Error {
	constructor(reason, message) {
		super(message);
		this.reason = reason;
	}
}

/**
 * Why a binary cannot be linked from where it is: macOS runs a bundle opened from Downloads from a translocated copy it
 * discards, and one opened inside the disk image from a volume that goes when the image is ejected.
 */
const linkRefusal = binary =>
	binary.includes('/AppTranslocation/') || /^\/Volumes\/Ender(?: \d+)?\/Ender\.app\//.test(binary)
		? 'Ender is running from a copy macOS will discard; drag Ender into Applications, open it from there, and try again'
		: undefined;

const pointsAt = async link => {
	try {
		return await readlink(link);
	} catch (error) {
		if (error.code === 'ENOENT') return undefined;
		if (error.code === 'EINVAL') return link;

		throw error;
	}
};

/**
 * Whether `link` is this binary, the line that makes it so, why it cannot be linked from where Ender runs, and what
 * occupies the link when it is something other than an Ender.app's ender; undefined for a binary outside an app bundle,
 * which an installer or the user put on the PATH already. A different ender earlier on the user's PATH is not seen.
 */
export const terminalStatus = async (binary, link = TERMINAL_LINK) => {
	if (!binary) return undefined;

	const target = await pointsAt(link);
	const real = place => realpath(place).catch(() => undefined);
	const linked = target !== undefined && (await real(link)) === (await real(binary));
	const occupied = target !== undefined && !linked && !ENDER_APP_BINARY.test(target) ? target : undefined;
	const refused = linkRefusal(binary);

	return {
		linked,
		line: `sudo mkdir -p ${dirname(link)} && sudo ln -sfh ${shellQuoted(binary)} ${link}`,
		...(refused && { refused }),
		...(occupied && { occupied }),
	};
};

const adminLink = link => [
	'on run argv',
	`do shell script "mkdir -p ${dirname(link)} && ln -sfh " & quoted form of (item 1 of argv) & " ${link}" with prompt "Ender is adding the ender command to Terminal." with administrator privileges`,
	'end run',
];

const spawned = async command => {
	const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'pipe' });
	const stderr = await new Response(child.stderr).text();

	return { code: await child.exited, stderr };
};

let linking = false;

/**
 * Links the binary into Terminal's PATH behind macOS's own password prompt, one prompt at a time, never over a link that
 * is not an Ender.app's, saying why when it does not.
 */
export const linkForTerminal = async (binary, { run = spawned, link = TERMINAL_LINK } = {}) => {
	const status = await terminalStatus(binary, link);

	if (!status) throw new TerminalLinkError('outside', 'Only an ender installed as Ender.app is linked into Terminal');
	if (status.refused) throw new TerminalLinkError('refused', status.refused);
	if (status.occupied) {
		throw new TerminalLinkError(
			'occupied',
			`${link} is already ${status.occupied}; Ender leaves another ender in place, so remove it first to use this one`,
		);
	}
	if (linking) throw new TerminalLinkError('busy', 'macOS is already asking for your password to link it');

	linking = true;

	try {
		const { code, stderr } = await run(['osascript', ...adminLink(link).flatMap(line => ['-e', line]), binary]);

		if (code === 0) return;
		if (stderr.includes(DISMISSED)) {
			throw new TerminalLinkError('canceled', `The password prompt was dismissed; ${link} was not linked`);
		}

		throw new TerminalLinkError('failed', `macOS did not link ${link}: ${stderr.trim()}`);
	} finally {
		linking = false;
	}
};

const execQuoted = text => `"${text.replaceAll(/["`$\\]/g, match => `\\${match}`)}"`;

export const desktopEntry = (command, icon) => `[Desktop Entry]
Type=Application
Name=${APP_NAME}
Comment=Minecraft instances and mods, managed in your browser
Exec=${[...command, ...ICON_ARGS].map(execQuoted).join(' ')}
Icon=${icon}
Terminal=false
Categories=Game;
`;

const dataHome = home => process.env.XDG_DATA_HOME || join(home, '.local', 'share');

/** Where each system's icon lives, and its files. */
export const iconPlaces = ({ platform = process.platform, home = homedir() } = {}) => {
	if (platform === 'darwin') return { app: join(home, 'Applications', `${APP_NAME}.app`) };

	if (platform === 'win32') {
		const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
		const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');

		return {
			shortcut: join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`),
			icon: join(localAppData, 'ender', 'ender.ico'),
		};
	}

	return {
		entry: join(dataHome(home), 'applications', 'ender-launcher.desktop'),
		icon: join(dataHome(home), 'icons', 'hicolor', '512x512', 'apps', 'ender-launcher.png'),
	};
};

/** Writes an app bundle whose executable is `executable` beside an icns, for this machine or for a disk image. */
export const writeAppBundle = async (app, { executable, write }) => {
	await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
	await mkdir(join(app, 'Contents', 'Resources'), { recursive: true });
	await Bun.write(join(app, 'Contents', 'Info.plist'), infoPlist({ executable }));
	await Bun.write(join(app, 'Contents', 'Resources', 'ender.icns'), Bun.file(icnsFile));
	await write(join(app, 'Contents', 'MacOS', executable));
};

const powershellShortcut = async ({ shortcut, target, args, icon }) => {
	const made = Bun.spawn(
		[
			'powershell',
			'-NoProfile',
			'-Command',
			'$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); $s.TargetPath = $env:TARGET; $s.Arguments = $env:ARGS; $s.IconLocation = $env:ICON; $s.WindowStyle = 7; $s.Save()',
		],
		{
			env: { ...process.env, LNK: shortcut, TARGET: target, ARGS: args, ICON: icon },
			stdout: 'ignore',
			stderr: 'pipe',
		},
	);
	const said = await new Response(made.stderr).text();

	if ((await made.exited) !== 0) throw new Error(`PowerShell could not make the Start menu shortcut: ${said.trim()}`);
};

/** Puts the icon where this system's app menu finds it, and answers where. */
export const addIcon = async ({
	command,
	platform = process.platform,
	home = homedir(),
	shortcut = powershellShortcut,
}) => {
	const places = iconPlaces({ platform, home });

	if (platform === 'darwin') {
		await rm(places.app, { recursive: true, force: true });
		await writeAppBundle(places.app, {
			executable: APP_NAME,
			write: async path => {
				await Bun.write(path, macLauncher(command));
				await chmod(path, 0o755);
			},
		});

		return places.app;
	}

	if (platform === 'win32') {
		const [target, ...rest] = command;

		await mkdir(dirname(places.icon), { recursive: true });
		await mkdir(dirname(places.shortcut), { recursive: true });
		await Bun.write(places.icon, Bun.file(icoFile));
		await shortcut({ shortcut: places.shortcut, target, args: [...rest, ...ICON_ARGS].join(' '), icon: places.icon });

		return places.shortcut;
	}

	await mkdir(dirname(places.icon), { recursive: true });
	await mkdir(dirname(places.entry), { recursive: true });
	await Bun.write(places.icon, Bun.file(pngFile));
	await Bun.write(places.entry, desktopEntry(command, places.icon));

	return places.entry;
};

const exists = place =>
	stat(place).then(
		() => true,
		() => false,
	);

/** Takes the icon away again, answering what was removed. */
export const removeIcon = async ({ platform = process.platform, home = homedir() } = {}) => {
	const places = Object.values(iconPlaces({ platform, home }));
	const present = [];

	for (const place of places) {
		if (await exists(place)) present.push(place);

		await rm(place, { recursive: true, force: true });
	}

	return present;
};

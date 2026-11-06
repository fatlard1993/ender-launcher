import { chmod, rename, rm } from 'node:fs/promises';

import { version } from '../../package.json';
import { fetchWithRetry, userAgent } from '../download';
import { done, step, warn } from '../out';

const LATEST = 'https://api.github.com/repos/fatlard1993/ender-launcher/releases/latest';

const SYSTEMS = { linux: 'linux', darwin: 'darwin', win32: 'windows' };

/** The release file built for this machine, as the release workflow names them. */
export const binaryFor = (platform = process.platform, arch = process.arch) => {
	const system = SYSTEMS[platform];

	if (!system || !['x64', 'arm64'].includes(arch) || (system === 'windows' && arch !== 'x64'))
		throw new Error(`There is no ender build for ${platform} on ${arch}`);

	return `ender-${system}-${arch}${system === 'windows' ? '.exe' : ''}`;
};

/** Whether this is a compiled ender, which carries its code inside it, rather than a checkout run by Bun. */
export const isCompiled = (main = Bun.main) => main.startsWith('/$bunfs/') || main.includes('~BUN');

/** Whether Homebrew keeps this binary, in its Cellar, where only brew should replace it. */
export const isBrewed = (path = process.execPath) => path.includes('/Cellar/');

/** Who replaces this ender: itself, Homebrew, or git in the checkout it runs from. */
export const whoUpgrades = ({ compiled = isCompiled(), path = process.execPath } = {}) => {
	if (!compiled) return 'checkout';

	return isBrewed(path) ? 'brew' : 'self';
};

/** The app bundle this binary is the executable of, as a disk image installs it; undefined outside one. */
export const appBundleOf = (path = process.execPath) => path.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/)?.[1];

/** The newest release as GitHub lists it: its tag and the files it carries. */
export const latestRelease = async () => {
	const release = await (await fetchWithRetry(LATEST, { headers: { 'user-agent': userAgent } })).json();

	if (typeof release.tag_name !== 'string')
		throw new Error(`GitHub did not list ender's newest release: ${release.message ?? 'no tag'}`);

	return { version: release.tag_name.replace(/^v/, ''), assets: release.assets };
};

/**
 * A bundle's executable replaced is a bundle whose seal no longer matches, which macOS may refuse to open; codesign
 * ships with macOS, so the bundle is sealed again ad hoc, as the release signed it.
 */
const resealApp = async app => {
	const sealed = Bun.spawn(['codesign', '--force', '--deep', '--sign', '-', app], { stdout: 'ignore', stderr: 'pipe' });
	const said = await new Response(sealed.stderr).text();

	if ((await sealed.exited) !== 0) {
		warn(`${app} was upgraded but not sealed again (${said.trim()}); if macOS will not open it, download Ender again`);
	}
};

const sha256 = bytes => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

/**
 * Replace this ender with the newest release's, checked against the sha256 the release lists. A running binary can be
 * renamed over everywhere but Windows, which can only have it moved aside first.
 */
export const upgrade = async (
	{ flags },
	{ compiled = isCompiled(), execPath = process.execPath, platform = process.platform, arch = process.arch } = {},
) => {
	if (!compiled) {
		throw new Error(
			'This ender runs from a checkout, which git pull brings up to date; upgrade replaces a released binary',
		);
	}

	if (isBrewed(execPath)) throw new Error('Homebrew installed this ender; brew upgrade ender brings it up to date');

	const app = appBundleOf(execPath);

	if (app?.includes('/AppTranslocation/')) {
		throw new Error(
			'Ender is running from the read-only copy macOS made when it was first opened; drag Ender into Applications, open it from there, and upgrade again',
		);
	}

	const release = await latestRelease();
	const latest = release.version;

	if (latest === version && !flags.force) {
		done(`ender ${version} is the newest release`);

		return 0;
	}

	const binary = binaryFor(platform, arch);
	const asset = name => release.assets.find(found => found.name === name)?.browser_download_url;

	if (!asset(binary) || !asset('SHA256SUMS')) throw new Error(`ender ${latest} has no ${binary} to upgrade to`);

	step(`Downloading ender ${latest}`);

	const bytes = new Uint8Array(await (await fetchWithRetry(asset(binary))).arrayBuffer());
	const sums = await (await fetchWithRetry(asset('SHA256SUMS'))).text();
	const expected = sums
		.split('\n')
		.find(line => line.trim().endsWith(` ${binary}`))
		?.split(/\s+/)[0];

	if (expected !== sha256(bytes))
		throw new Error(`${binary} is not the file ender ${latest} lists; nothing was changed`);

	const current = execPath;
	const incoming = `${current}.new`;

	await Bun.write(incoming, bytes);
	await chmod(incoming, 0o755);

	if (platform === 'win32') {
		await rm(`${current}.old`, { force: true });
		await rename(current, `${current}.old`);
	}

	await rename(incoming, current);

	if (app) await resealApp(app);

	done(`Upgraded ender from ${version} to ${latest}`);

	return 0;
};

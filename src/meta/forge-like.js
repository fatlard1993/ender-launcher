import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ensureFile, fetchJson } from '../download';
import { selectJava } from '../java';
import { detail, step, warn } from '../out';
import { paths } from '../paths';

/**
 * Forge and NeoForge are installed, not merely described.
 *
 * Neither publishes a launcher profile you can fetch. The profile is produced by running their
 * installer, which patches the game jar through a chain of tools and writes out the libraries and
 * the launch profile. Rather than reimplement that chain -- six processors, LZMA binary patches
 * and a mapping pass -- their own installer is run once, headless, with the Java mcm already
 * manages. The output is an ordinary `inheritsFrom` profile, which is a shape this launcher
 * already merges.
 */
export const forgeLike = ({ name, versionsFor, installerUrl, profileId }) => {
	const profilePath = (minecraft, loaderVersion) => {
		const id = profileId(minecraft, loaderVersion);

		return join(paths.versions, id, `${id}.json`);
	};

	const isInstalled = async (minecraft, loaderVersion) => Bun.file(profilePath(minecraft, loaderVersion)).exists();

	/**
	 * Run the vendor installer into a staging directory, then keep only what a launch needs: the
	 * profile it wrote, and the libraries it fetched, merged into the shared library tree.
	 */
	/**
	 * Fetch the vendor installer and run it headless in `directory`.
	 *
	 * Forge's installer takes --installClient / --installServer; NeoForge's newer one accepts those
	 * spellings too, so one pair of flags serves both. It writes its real diagnosis to a log beside
	 * itself rather than to either stream, which is why failure is read from there.
	 */
	const runInstaller = async (minecraft, loaderVersion, directory, mode, { javaPath } = {}) => {
		const installer = join(directory, 'installer.jar');

		await mkdir(directory, { recursive: true });
		await ensureFile({ url: installerUrl(minecraft, loaderVersion), path: installer });

		// Any reasonably modern Java runs the installer; it is a plain tool, not the game, so no
		// runtime is fetched purely to run it.
		const java = await selectJava(17, javaPath);

		detail('installer', `${java.path} -jar installer.jar ${mode}`);

		const process_ = Bun.spawn([java.path, '-jar', installer, mode, directory], {
			cwd: directory,
			stdout: 'pipe',
			stderr: 'pipe',
		});

		const [out, error] = await Promise.all([
			new Response(process_.stdout).text(),
			new Response(process_.stderr).text(),
		]);

		if ((await process_.exited) !== 0) {
			const logged = await Bun.file(join(directory, 'installer.jar.log'))
				.text()
				.catch(() => '');
			const said = [logged, error, out].find(text => text.trim() !== '') ?? '(it said nothing)';

			throw new Error(`The ${name} installer failed:\n${said.trim().split('\n').slice(-8).join('\n')}`);
		}

		await rm(installer, { force: true });
		await rm(join(directory, 'installer.jar.log'), { force: true });
	};

	/** Install a server in place: its argument file names libraries by path relative to there. */
	const installServer = async (minecraft, loaderVersion, directory, options) => {
		await runInstaller(minecraft, loaderVersion, directory, '--installServer', options);

		detail(name, `server ${loaderVersion} installed into ${directory}`);
	};

	const install = async (minecraft, loaderVersion, { javaPath } = {}) => {
		const staging = join(paths.cache, `${name.toLowerCase()}-install-${loaderVersion}`);

		await rm(staging, { recursive: true, force: true });
		await mkdir(join(staging, 'versions'), { recursive: true });

		step(`Installing ${name} ${loaderVersion} for Minecraft ${minecraft}`);

		// The installer expects to find a launcher it can register a profile with; an empty one
		// satisfies it, and the profile it injects there is discarded with the staging directory.
		await writeFile(join(staging, 'launcher_profiles.json'), '{"profiles":{},"version":3}\n');

		try {
			await runInstaller(minecraft, loaderVersion, staging, '--installClient', { javaPath });
		} catch (error) {
			await rm(staging, { recursive: true, force: true });

			throw error;
		}

		const id = profileId(minecraft, loaderVersion);
		const produced = join(staging, 'versions', id, `${id}.json`);

		if (!(await Bun.file(produced).exists())) {
			const wrote = await readdir(join(staging, 'versions')).catch(() => []);

			await rm(staging, { recursive: true, force: true });

			throw new Error(`The ${name} installer wrote no profile for ${id} (found: ${wrote.join(', ') || 'nothing'})`);
		}

		const destination = profilePath(minecraft, loaderVersion);

		await mkdir(dirname(destination), { recursive: true });
		await cp(produced, destination);

		// Its library tree is the same maven layout as ours, so it merges in rather than living
		// beside it. Existing files are kept, because ours are already checksum-verified.
		await cp(join(staging, 'libraries'), paths.libraries, { recursive: true, force: false }).catch(error => {
			if (error.code !== 'ERR_FS_CP_EEXIST') throw error;
		});

		await rm(staging, { recursive: true, force: true });

		detail(name, `installed ${id}`);

		return destination;
	};

	const profile = async (minecraft, loaderVersion, options) => {
		if (!(await isInstalled(minecraft, loaderVersion))) await install(minecraft, loaderVersion, options);

		return Bun.file(profilePath(minecraft, loaderVersion)).json();
	};

	/** These profiles carry resolved download blocks, so the vanilla library reader understands them. */
	const libraryJobs = (loaderProfile, donorRoots = []) => {
		const jobs = [];

		for (const library of loaderProfile.libraries) {
			const artifact = library.downloads?.artifact;

			if (artifact === undefined) continue;

			// The installer writes entries for jars it produced locally, which have no url to fetch
			// from; those are already sitting in the library tree it handed over.
			if (!artifact.url) {
				detail(name, `${library.name} comes from the installer, not a repository`);

				continue;
			}

			jobs.push({
				name: library.name,
				url: artifact.url,
				checksum: artifact.sha1 ? { algorithm: 'sha1', value: artifact.sha1.toLowerCase() } : undefined,
				size: artifact.size,
				path: join(paths.libraries, artifact.path),
				donors: donorRoots.map(root => join(root, artifact.path)),
			});
		}

		return jobs;
	};

	const latestLoader = async minecraft => {
		const versions = await versionsFor(minecraft);

		if (versions.length === 0) throw new Error(`${name} has no build for Minecraft ${minecraft} yet`);

		return versions.at(-1);
	};

	return {
		name,
		source: 'its own installer',
		versionsFor,
		latestLoader,
		profile,
		libraryJobs,
		isInstalled,
		install,
		installServer,
		profileId,
	};
};

const FORGE_PROMOTIONS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';

export const forge = forgeLike({
	name: 'Forge',
	versionsFor: async minecraft => {
		const { promos } = await fetchJson(FORGE_PROMOTIONS);
		const found = [promos[`${minecraft}-recommended`], promos[`${minecraft}-latest`]].filter(Boolean);

		return [...new Set(found)];
	},
	installerUrl: (minecraft, loaderVersion) =>
		`https://maven.minecraftforge.net/net/minecraftforge/forge/${minecraft}-${loaderVersion}/forge-${minecraft}-${loaderVersion}-installer.jar`,
	// Forge names its profile after the pairing; NeoForge after itself alone.
	profileId: (minecraft, loaderVersion) => `${minecraft}-forge-${loaderVersion}`,
});

const NEOFORGE_VERSIONS = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';

export const neoforge = forgeLike({
	name: 'NeoForge',
	versionsFor: async minecraft => {
		const { versions } = await fetchJson(NEOFORGE_VERSIONS);
		// NeoForge numbers itself after the game version it targets: 1.21.1 -> 21.1.x.
		const [, major, minor = '0'] = /^1\.(\d+)(?:\.(\d+))?$/.exec(minecraft) ?? [];
		const prefix = major ? `${major}.${minor}.` : `${minecraft}.`;

		return versions.filter(version => version.startsWith(prefix));
	},
	installerUrl: (minecraft, loaderVersion) =>
		`https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`,
	profileId: (minecraft, loaderVersion) => `neoforge-${loaderVersion}`,
});

export const forgeFamily = { forge, neoforge };

export const warnAboutInstaller = () =>
	warn('Forge and NeoForge are installed by running their own installer, which takes a minute the first time.');

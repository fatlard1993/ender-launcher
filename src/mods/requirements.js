import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { checksumText } from '../download';
import { satisfies } from './range';

/** What the game and its loader provide, never a jar in the mods directory: ender settles these elsewhere. */
const PLATFORM = new Set(['minecraft', 'java', 'fabricloader', 'quilt_loader', 'neoforge', 'forge']);

/** A version as the loader compares it: build metadata after a `+` is not part of the order. */
const comparable = version => String(version ?? '').replace(/\+.*$/, '');

const provides = (mod, modId) => mod.id === modId || (mod.provides ?? []).includes(modId);

/** The version a mod offers of what it provides: a jar nested inside it has its own, an alias it declares has the mod's. */
const versionOf = (mod, modId) => (mod.id !== modId && mod.bundled?.[modId]) || mod.version;

/**
 * The requirements an installed jar narrows to versions the jar providing them is not: Better Webs needing Pandorical
 * 15.36.0 or later beside Pandorical 15.35.4, which the loader refuses to start. A requirement nothing installed
 * provides is left out here; that is an unplaced dependency, reported on its own. A version or range that cannot be
 * read is taken as met, as the loader's own leniency would.
 */
export const unmetRequirements = installed =>
	installed.flatMap(dependent =>
		(dependent.mods ?? []).flatMap(mod =>
			Object.entries(mod.dependsVersions ?? {})
				.filter(([modId]) => !PLATFORM.has(modId))
				.flatMap(([modId, range]) => {
					const providers = installed.filter(
						candidate => candidate !== dependent && (candidate.mods ?? []).some(other => provides(other, modId)),
					);

					if (providers.length === 0) return [];

					const met = providers.some(provider =>
						provider.mods
							.filter(other => provides(other, modId))
							.some(other => satisfies(comparable(versionOf(other, modId)), range) !== false),
					);

					if (met) return [];

					const provider = providers[0];
					const offering = provider.mods.find(other => provides(other, modId));
					const have = offering && versionOf(offering, modId);

					return [{ dependent, modId, range, provider, have }];
				}),
		),
	);

/** Whether these mods, one jar's, meet every requirement asked of the provider they would replace. */
export const meetsAll = (mods, wants) =>
	wants.every(({ modId, range }) =>
		mods.filter(mod => provides(mod, modId)).some(mod => satisfies(comparable(versionOf(mod, modId)), range) !== false),
	);

/** Why a mod was left out of the instance, one line each, for whoever asked for the sync. */
export const unmetMessage = ({ dependent, modId, range, provider, have, tried }) =>
	`${dependent.source}:${dependent.id} ${dependent.version} requires ${modId} ${range}, but ${provider.source}:${provider.id} is ${have ?? 'an unreadable version'}${
		tried ? ', and its newest release on GitHub does not meet it either' : ''
	}; left out until it does, since the game refuses to start with both`;

/**
 * Each installed jar's mods as the requirement check reads them, kept by checksum in `known` beside the ids the sync
 * already keeps there, so a server start reads only the jars it has not seen before.
 */
const modsOf = async (resolution, modsDir, known, readMods) => {
	const checksum = checksumText(resolution.file.checksum);
	const key = checksum && `mods-bundled:${checksum}`;

	if (key && known[key]) return { mods: known[key], learned: false };

	const mods = (await readMods(join(modsDir, resolution.file.filename)).catch(() => [])).map(mod => ({
		id: mod.id,
		version: mod.version,
		provides: mod.provides ?? [],
		...(mod.bundled ? { bundled: mod.bundled } : {}),
		...(mod.dependsVersions ? { dependsVersions: mod.dependsVersions } : {}),
	}));

	if (key) known[key] = mods;

	return { mods, learned: key !== undefined };
};

/**
 * Settle the requirements the installed jars narrow, in place in `installed`. A provider that came from a GitHub
 * repository the index has not yet caught up with is looked up on GitHub itself, and its newest release takes its place
 * when that release meets every requirement asked of it. Returns what is still unmet, for the sync to leave out and
 * report: the loader refuses to start an instance holding both, and refuses it whole.
 */
export const meetRequirements = async (installed, { modsDir, context, known = {}, readMods, install, resolveLive, onLearned }) => {
	let learned = false;

	for (const resolution of installed) {
		const read = await modsOf(resolution, modsDir, known, readMods);

		resolution.mods = read.mods;
		learned ||= read.learned;
	}

	const tried = new Set();

	for (let unmet = unmetRequirements(installed); unmet.length > 0; unmet = unmetRequirements(installed)) {
		const provider = unmet.find(({ provider }) => provider.source === 'github' && !tried.has(provider.key))?.provider;

		if (provider === undefined) {
			if (learned) await onLearned?.();

			return unmet.map(item => ({ ...item, tried: tried.has(item.provider.key) }));
		}

		tried.add(provider.key);

		const live = await resolveLive({ source: 'github', id: provider.id }, context).catch(() => undefined);

		if (live === undefined || live.file.filename === provider.file.filename) continue;

		await install(live, modsDir);

		const read = await modsOf(live, modsDir, known, readMods);
		const wants = unmet.filter(item => item.provider === provider);

		learned ||= read.learned;

		if (!meetsAll(read.mods, wants)) {
			await unlink(join(modsDir, live.file.filename)).catch(() => {});

			continue;
		}

		await unlink(join(modsDir, provider.file.filename)).catch(() => {});
		installed[installed.indexOf(provider)] = {
			...live,
			key: provider.key,
			requested: provider.requested,
			modIds: [...new Set(read.mods.map(mod => mod.id).filter(Boolean))],
			mods: read.mods,
			ahead: { of: provider.version, because: wants.map(({ dependent }) => `${dependent.source}:${dependent.id}`) },
		};
	}

	if (learned) await onLearned?.();

	return [];
};

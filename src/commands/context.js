import { readConfig } from '../config';
import * as instances from '../instance';
import { isProject } from '../mods/gradle';

/** Which instance a command acts on: what the caller resolved, then whatever `use` last set. */
export const targetName = async (explicit, config) => {
	const name = explicit ?? (config ?? (await readConfig())).activeInstance;

	if (name === undefined) {
		throw new Error('No instance given and none is active. Try "mcm use <name>" or pass --instance.');
	}

	return name;
};

export const targetInstance = async explicit => {
	const config = await readConfig();
	const manifest = await instances.read(await targetName(explicit, config));

	return { config, manifest };
};

/** Instance settings win over global ones; global settings exist so every instance need not repeat them. */
export const settingsFor = (manifest, config) => ({
	username: manifest.username ?? config.username,
	memory: manifest.memory ?? config.memory,
	javaPath: manifest.javaPath ?? config.javaPath,
});

const LOCAL = /^\.{0,2}\//;

/** `sodium`, `modrinth:sodium@0.5.8`, `cf:jei`, `./build/libs/mod.jar`, or a url. */
/**
 * Refine a parsed spec against the disk: a path naming a gradle project is a source to build from,
 * where a path naming a jar is the jar itself. Kept apart from parsing so the parse stays pure.
 */
export const refineModSpec = async entry => {
	if (entry.source !== 'local') return entry;

	return (await isProject(entry.path)) ? { source: 'gradle', path: entry.path } : entry;
};

export const parseModSpec = spec => {
	if (spec.startsWith('http://') || spec.startsWith('https://')) return { source: 'url', url: spec };
	if (LOCAL.test(spec) || spec.endsWith('.jar')) return { source: 'local', path: spec };
	if (spec.startsWith('gradle:')) return { source: 'gradle', path: spec.slice(7) };

	const aliases = {
		gradle: 'gradle',
		mr: 'modrinth',
		modrinth: 'modrinth',
		cf: 'curseforge',
		curseforge: 'curseforge',
		gh: 'github',
		github: 'github',
	};
	const separator = spec.indexOf(':');

	let source = 'modrinth';
	let remainder = spec;

	if (separator !== -1 && aliases[spec.slice(0, separator)]) {
		source = aliases[spec.slice(0, separator)];
		remainder = spec.slice(separator + 1);
	}

	const at = remainder.lastIndexOf('@');

	return at > 0 ? { source, id: remainder.slice(0, at), version: remainder.slice(at + 1) } : { source, id: remainder };
};

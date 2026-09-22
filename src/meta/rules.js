const osNames = { linux: 'linux', darwin: 'osx', win32: 'windows' };

const archAliases = { x64: ['x86_64', 'x64', 'amd64'], ia32: ['x86', 'i386'], arm64: ['arm64', 'aarch64'] };

export const currentOs = {
	name: osNames[process.platform] || process.platform,
	arch: archAliases[process.arch] || [process.arch],
	version: process.report?.getReport?.().header?.osRelease ?? '',
};

const matchesOs = ({ name, arch, version }) => {
	if (name !== undefined && name !== currentOs.name) return false;
	if (arch !== undefined && !currentOs.arch.includes(arch)) return false;
	if (version !== undefined && !new RegExp(version).test(currentOs.version)) return false;

	return true;
};

const matchesFeatures = (required, active) =>
	Object.entries(required).every(([feature, wanted]) => Boolean(active[feature]) === wanted);

/**
 * Mojang rule semantics: no rules means allow, otherwise deny until a matching rule says otherwise,
 * with later matches overriding earlier ones.
 */
export const allowed = (rules, features = {}) => {
	if (!rules?.length) return true;

	let verdict = false;

	for (const rule of rules) {
		if (rule.os !== undefined && !matchesOs(rule.os)) continue;
		if (rule.features !== undefined && !matchesFeatures(rule.features, features)) continue;

		verdict = rule.action === 'allow';
	}

	return verdict;
};

/** Flatten a mixed `arguments` array, dropping entries whose rules do not hold here. */
export const applicableArguments = (entries = [], features = {}) =>
	entries.flatMap(entry => {
		if (typeof entry === 'string') return [entry];
		if (!allowed(entry.rules, features)) return [];

		return Array.isArray(entry.value) ? entry.value : [entry.value];
	});

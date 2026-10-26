import { satisfies } from './range';

/** The hosts the index crawls, each a mod source of the same name. */
export const HOSTS = { github: 'GitHub', codeberg: 'Codeberg', gitlab: 'GitLab' };

/** Stars a repository needs before a mod id it claims is taken to name it unasked. */
export const ESTABLISHED = 50;

/** What every mod runs on rather than a mod anyone installs. */
const PLATFORM = new Set([
	'minecraft',
	'java',
	'fabricloader',
	'fabric-loader',
	'quilt_loader',
	'forge',
	'neoforge',
	'javafml',
]);

export const loaderFits = (declared, loader) =>
	!loader || declared === loader || (loader === 'quilt' && declared === 'fabric');

/** 2 when a mod declares the instance's loader and game version, 1 when its range cannot be read, 0 when it does not fit. */
export const fit = (mods, { minecraft, loader } = {}) =>
	Math.max(
		0,
		...(mods ?? []).map(mod => {
			if (!loaderFits(mod.loader, loader)) return 0;
			if (minecraft === undefined) return 2;

			return { true: 2, undefined: 1, false: 0 }[satisfies(minecraft, mod.minecraft)];
		}),
	);

const words = text => (text ?? '').toLowerCase();

/**
 * How well an index entry answers a query: every word must appear somewhere, and an id or name outranks
 * a description. The whole query naming the mod, as its id, its repository or its name, outranks any
 * word of it doing so, so "fabric api" is Fabric API before a repository called fabric. Whole matches
 * are not scored against each other, since a copy of a name matches as well as the name: stars decide.
 */
const relevance = (entry, terms) => {
	const ids = [entry.repo, ...(entry.latest?.mods ?? []).map(mod => mod.id)].map(words);
	const names = (entry.latest?.mods ?? []).map(mod => words(mod.name));
	const description = words(entry.description);
	const slugs = new Set([terms.join('-'), terms.join('_'), terms.join('')]);
	const whole = ids.some(candidate => slugs.has(candidate.split('/').at(-1))) || names.includes(terms.join(' '));
	if (whole) return 1000;

	let score = 0;

	for (const term of terms) {
		if (ids.some(candidate => candidate === term || candidate.endsWith(`/${term}`))) score += 100;
		else if (ids.some(candidate => candidate.includes(term)) || names.some(name => name.includes(term))) score += 10;
		else if (description.includes(term)) score += 1;
		else return 0;
	}

	return score;
};

/**
 * The established repository, with more stars, whose mod has an id or name this entry's mod also has.
 * A port does this as well as a disguise, so it is said as the fact it is.
 */
const sharing = (entry, entries) => {
	for (const other of entries) {
		if (other === entry || (other.stars ?? 0) < ESTABLISHED || (other.stars ?? 0) <= (entry.stars ?? 0)) continue;

		for (const ours of entry.latest?.mods ?? []) {
			const theirs = other.latest?.mods.find(
				mod => mod.id === ours.id || (mod.name !== undefined && words(mod.name) === words(ours.name)),
			);

			if (theirs)
				return `declares ${theirs.id === ours.id ? `"${ours.id}"` : `the name "${ours.name}"`}, as ${other.repo}${other.host && other.host !== 'github' ? ` on ${HOSTS[other.host]}` : ''} does`;
		}
	}

	return '';
};

/** This entry's mod that the whole query names, by its id or its name. */
const named = (entry, terms) => {
	const slugs = new Set([terms.join('-'), terms.join('_'), terms.join('')]);

	return (entry.latest?.mods ?? []).find(mod => slugs.has(words(mod.id)) || words(mod.name) === terms.join(' '));
};

/**
 * Index entries that answer a query and fit the loader and game version, best first, each with what it
 * shares with an established mod, and, when the query names its mod and no established repository
 * declares that mod, that nothing vouches for the name. An empty query answers with everything that
 * fits, by stars.
 */
export const rank = (entries, query, { minecraft, loader } = {}) => {
	const terms = words(query).split(/\s+/).filter(Boolean);
	const vouched = terms.length > 0 && entries.some(entry => (entry.stars ?? 0) >= ESTABLISHED && named(entry, terms));
	const unproven = entry => {
		const mod = !vouched && terms.length > 0 && (entry.stars ?? 0) < ESTABLISHED && named(entry, terms);

		return mod ? `no repository with ${ESTABLISHED} stars or more declares "${mod.name ?? mod.id}"` : '';
	};

	return entries
		.filter(entry => !entry.archived)
		.filter(entry => fit(entry.targets, { minecraft, loader }) > 0)
		.map(entry => ({ entry, score: terms.length === 0 ? 1 : relevance(entry, terms) }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || (b.entry.stars ?? 0) - (a.entry.stars ?? 0))
		.map(({ entry }) => ({ entry, sharing: sharing(entry, entries), unproven: unproven(entry) }));
};

/** The part of a mod id before its first separator, which a library's modules share with it. */
const namespaceOf = id => id.split(/[-_]/)[0];

/**
 * Every index entry claiming a mod id, most likely first: those whose own mod has the id, by stars,
 * then those that provide it as a module of their own, named under their own id, by how much they
 * provide. A library is often bundled inside the mods that use it, so a jar carrying a mod it is not
 * named for is not where that mod comes from.
 */
export const claimantsOf = (id, entries, fits = {}) => {
	const byStars = (a, b) => (b.stars ?? 0) - (a.stars ?? 0);
	const fitting = fits.minecraft || fits.loader ? entries.filter(entry => fit(entry.targets, fits) > 0) : entries;
	const own = fitting.filter(entry => entry.latest?.mods.some(mod => mod.id === id)).sort(byStars);
	const providers = fitting
		.filter(
			entry =>
				!own.includes(entry) &&
				entry.latest?.provides?.includes(id) &&
				entry.latest.mods.some(mod => namespaceOf(mod.id) === namespaceOf(id)),
		)
		.sort((a, b) => b.latest.provides.length - a.latest.provides.length || byStars(a, b));

	return [...own, ...providers];
};

const ownerOf = ({ host, repo }) => `${host ?? 'github'}:${repo.split('/')[0].toLowerCase()}`;

/**
 * The entry a mod id can be trusted to name: the likeliest claimant that is established, or that shares
 * an owner with the repository requiring it. Any jar can declare any mod id, so a claim alone would
 * let a new repository answer for a mod the index does not have. Given the instance's loader and game
 * version, only a repository with a release for them can answer.
 */
export const providerOf = (id, entries, requiring, fits) =>
	claimantsOf(id, entries, fits).find(
		entry => (entry.stars ?? 0) >= ESTABLISHED || (requiring !== undefined && ownerOf(entry) === ownerOf(requiring)),
	);

/** The ids a jar's mods require from elsewhere: not the platform, and not what the jar already carries. */
export const requiredIds = mods => {
	const carried = new Set(mods.flatMap(mod => [mod.id, ...(mod.provides ?? [])]));

	return [...new Set(mods.flatMap(mod => mod.depends ?? []))].filter(id => !PLATFORM.has(id) && !carried.has(id));
};

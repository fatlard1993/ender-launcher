/** Least to most stable. A build is only taken from a lower channel when no higher one exists. */
const CHANNELS = ['alpha', 'beta', 'release'];

export const channelRank = channel => {
	const index = CHANNELS.indexOf(String(channel ?? 'release').toLowerCase());

	return index === -1 ? CHANNELS.length - 1 : index;
};

/**
 * Choose a build from the candidates a source offered.
 *
 * Sources tend to answer newest-first, but neither Modrinth nor CurseForge documents that and
 * neither request asks for it, so the ordering is made here rather than assumed. Within a channel
 * the newest wins; a stable release outranks a newer prerelease, because "latest" almost never
 * means "the alpha that landed this morning". A snapshot old enough to have only alphas still
 * resolves, because the best channel present is what gets used.
 *
 * `allowPrerelease` drops the channel preference and takes the newest of anything.
 */
export const pickBuild = (candidates, { allowPrerelease = false } = {}) => {
	if (candidates.length === 0) return undefined;

	const byDate = [...candidates].sort((a, b) => (b.published ?? 0) - (a.published ?? 0));

	if (allowPrerelease) return byDate[0];

	const best = Math.max(...byDate.map(candidate => channelRank(candidate.channel)));

	return byDate.find(candidate => channelRank(candidate.channel) === best);
};

/** Gradle publishes these beside the real artifact; none of them is a mod. */
const NOT_A_MOD = /-(sources|javadoc|dev|api|slim|shadow)\.jar$/i;

/**
 * Pick the jar a release actually ships. A release carrying several is usually one artifact plus
 * its sources and javadoc, so those go first; what remains is preferred by game version, then by
 * the shortest name, which is the plain artifact rather than a variant of it.
 */
export const chooseAsset = (assets, { minecraft, loader, pattern } = {}) => {
	let candidates = assets.filter(asset => asset.name.endsWith('.jar') && !NOT_A_MOD.test(asset.name));

	if (candidates.length === 0) return undefined;

	if (pattern) {
		const matcher = new RegExp(pattern, 'i');

		candidates = candidates.filter(asset => matcher.test(asset.name));

		if (candidates.length === 0) return undefined;
	}

	// A multiloader release ships fabric and forge jars side by side under equal-length names, and
	// a sort alone would hand back whichever the listing happened to put first.
	const narrow = (list, term) => {
		const matched = term ? list.filter(asset => asset.name.toLowerCase().includes(term.toLowerCase())) : [];

		return matched.length > 0 ? matched : list;
	};

	const pool = narrow(narrow(candidates, loader), minecraft);

	return [...pool].sort((a, b) => a.name.length - b.name.length)[0];
};

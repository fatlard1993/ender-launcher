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

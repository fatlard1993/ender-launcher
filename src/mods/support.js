/** FUNDING.yml's platform keys, as a reader names each. */
const PLATFORM_NAMES = {
	github: 'GitHub Sponsors',
	patreon: 'Patreon',
	open_collective: 'Open Collective',
	ko_fi: 'Ko-fi',
	liberapay: 'Liberapay',
	buy_me_a_coffee: 'Buy Me a Coffee',
	polar: 'Polar',
	thanks_dev: 'thanks.dev',
	issuehunt: 'IssueHunt',
	tidelift: 'Tidelift',
	community_bridge: 'LFX Crowdfunding',
	lfx_crowdfunding: 'LFX Crowdfunding',
};

/**
 * How an index entry's author takes support, each named for where it leads: a custom link by its site, which is the
 * author's say, not the index's.
 */
export const supportOf = entry =>
	(entry.funding ?? []).map(({ platform, url }) => ({
		url,
		label: PLATFORM_NAMES[platform] ?? new URL(url).hostname.replace(/^www\./, ''),
	}));

/** Whose a repository is, as its host spells the owner. */
export const ownerName = entry => entry.repo.split('/')[0];

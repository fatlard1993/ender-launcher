import { API, authorized, refused } from './githubAccount';

export const INDEX_REPOSITORY = 'fatlard1993/ender-index';

/**
 * The issues ender files on the index for a player, each as its issue form would: the form's title, its labels, and
 * the heading its one field answers under. GitHub drops the labels of an issue opened through its API by anyone who
 * cannot triage the repository, so the index's workflows know these by title as well.
 */
export const INDEX_ISSUES = {
	fund: { title: "I would pay this mod's author", labels: ['interest', 'fund'], heading: 'Mod' },
	release: { title: 'I want a built release of this mod', labels: ['interest', 'release'], heading: 'Mod' },
	pack: { title: 'List a pack', labels: ['pack'], heading: 'Pack' },
};

/** The body an issue form writes for its one field. */
export const issueBody = (kind, answer) => `### ${INDEX_ISSUES[kind].heading}\n\n${answer}\n`;

/** File one of the index's issues as the account ender signs in with; answers its number and link. */
export const fileIndexIssue = async (kind, answer, { fetcher = fetch, configured } = {}) => {
	const { title, labels } = INDEX_ISSUES[kind];
	const response = await fetcher(`${API}/repos/${INDEX_REPOSITORY}/issues`, {
		method: 'POST',
		headers: { ...(await authorized(configured)), 'content-type': 'application/json' },
		body: JSON.stringify({ title, labels, body: issueBody(kind, answer) }),
	});

	if (!response.ok) return refused(response, `open "${title}" on the index`, 'open issues');

	const { number, html_url: url } = await response.json();

	return { number, url };
};

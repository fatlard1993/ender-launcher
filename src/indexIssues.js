import { API, authorized, refused, signedInAs } from './githubAccount';

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

/** The issue this account opened before with the same title and answer, open or closed, or undefined. */
const openedBefore = async (kind, answer, { fetcher, configured }) => {
	const login = await signedInAs({ fetcher, configured });
	const response = await fetcher(
		`${API}/repos/${INDEX_REPOSITORY}/issues?creator=${encodeURIComponent(login)}&state=all&per_page=100`,
		{ headers: await authorized(configured) },
	);

	if (!response.ok) return refused(response, 'list the issues it opened on the index', 'read issues');

	const body = issueBody(kind, answer).trim();

	return (await response.json()).find(issue => issue.title === INDEX_ISSUES[kind].title && issue.body?.trim() === body);
};

/**
 * File one of the index's issues as the account ender signs in with, unless it filed the same one before; answers its
 * number and link, and whether it was filed before.
 */
export const fileIndexIssue = async (kind, answer, { fetcher = fetch, configured } = {}) => {
	const before = await openedBefore(kind, answer, { fetcher, configured });

	if (before) return { number: before.number, url: before.html_url, before: true };

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

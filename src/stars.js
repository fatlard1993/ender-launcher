import { readConfig } from './config';
import { token } from './mods/github';

const API = 'https://api.github.com';

const SIGN_IN = 'Stars are kept by a GitHub account: sign in with gh auth login, or set GITHUB_TOKEN';

const authorized = async configured => {
	const authorization = await token(configured ?? (await readConfig()).githubToken);

	if (!authorization) throw Object.assign(new Error(SIGN_IN), { status: 401 });

	return {
		accept: 'application/vnd.github+json',
		authorization: `Bearer ${authorization}`,
		'x-github-api-version': '2022-11-28',
	};
};

/** GitHub's answer when it would not do what was asked, and what a token without starring needs. */
const refused = async (response, doing) => {
	const { message } = await response.json().catch(() => ({}));
	const scoped = response.status === 404 || (response.status === 403 && !/rate limit/i.test(message ?? ''));

	throw new Error(
		`GitHub would not ${doing} (${response.status}${message ? `: ${message}` : ''})${scoped ? '; the token needs to be allowed to star' : ''}`,
	);
};

const nextPage = response => response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];

/** Every repository the account ender signs in with has starred, as owner/repo. */
export const starredRepositories = async ({ fetcher = fetch, configured } = {}) => {
	const headers = await authorized(configured);
	const starred = [];
	let url = `${API}/user/starred?per_page=100`;

	while (url) {
		const response = await fetcher(url, { headers });

		if (!response.ok) return refused(response, 'list its stars');

		starred.push(...(await response.json()).map(repository => repository.full_name));
		url = nextPage(response);
	}

	return starred;
};

/** Star a repository under that account, or take its star back. */
export const setStar = async (repository, starring, { fetcher = fetch, configured } = {}) => {
	const response = await fetcher(`${API}/user/starred/${repository}`, {
		method: starring ? 'PUT' : 'DELETE',
		headers: await authorized(configured),
	});

	if (!response.ok) return refused(response, `${starring ? 'star' : 'take back its star on'} ${repository}`);
};

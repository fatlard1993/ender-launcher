import { readConfig } from './config';
import { token } from './mods/github';

export const API = 'https://api.github.com';

const SIGN_IN = 'This needs a GitHub account: sign in with gh auth login, or set GITHUB_TOKEN';

/** The headers that act as the account ender signs in with; a 401 error when there is none. */
export const authorized = async configured => {
	const authorization = await token(configured ?? (await readConfig()).githubToken);

	if (!authorization) throw Object.assign(new Error(SIGN_IN), { status: 401 });

	return {
		accept: 'application/vnd.github+json',
		authorization: `Bearer ${authorization}`,
		'x-github-api-version': '2022-11-28',
	};
};

/** GitHub's answer when it would not do what was asked, and what the token is missing when that is why. */
export const refused = async (response, doing, missing) => {
	const { message } = await response.json().catch(() => ({}));
	const scoped = response.status === 404 || (response.status === 403 && !/rate limit/i.test(message ?? ''));

	throw new Error(
		`GitHub would not ${doing} (${response.status}${message ? `: ${message}` : ''})${scoped ? `; the token needs to be allowed to ${missing}` : ''}`,
	);
};

/** The login of the account ender signs in with. */
export const signedInAs = async ({ fetcher = fetch, configured } = {}) => {
	const response = await fetcher(`${API}/user`, { headers: await authorized(configured) });

	if (!response.ok) return refused(response, 'say who is signed in', 'read the account');

	return (await response.json()).login;
};

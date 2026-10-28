import { readConfig } from './config';
import { ENDER_PACK } from './instance/enderPack';
import { token } from './mods/github';

const SCOPE_HINT = '; the token needs the gist scope';

/**
 * Publish an ender pack as a secret gist under the GitHub account ender signs in with: unlisted, and readable by
 * anyone given its link, which is what a pack to follow needs. Given the id of one published before, it updates that
 * gist, so whoever follows its link gets the change; a gist since deleted is published anew.
 */
export const publishPack = async (pack, { id, fetcher = fetch, configured } = {}) => {
	const authorization = await token(configured ?? (await readConfig()).githubToken);

	if (!authorization) {
		throw new Error('Publishing a gist needs a GitHub account: sign in with gh auth login, or set GITHUB_TOKEN');
	}

	const send = (method, url) =>
		fetcher(url, {
			method,
			headers: {
				accept: 'application/vnd.github+json',
				authorization: `Bearer ${authorization}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				description: `ender pack: ${pack.name ?? 'unnamed'}`,
				...(method === 'POST' ? { public: false } : {}),
				files: { [ENDER_PACK]: { content: `${JSON.stringify(pack, null, '\t')}\n` } },
			}),
		});
	let response = id ? await send('PATCH', `https://api.github.com/gists/${id}`) : undefined;
	const updated = response?.ok === true;

	if (!updated) {
		if (response && response.status !== 404) return refused(response, 'update');

		response = await send('POST', 'https://api.github.com/gists');

		if (!response.ok) return refused(response, 'create');
	}

	const { id: published, html_url: url } = await response.json();

	return { id: published, url, line: `ender import gist:${published}`, updated };
};

/** GitHub's answer when it would not take the gist, and what a token without the gist scope needs. */
const refused = async (response, doing) => {
	const { message } = await response.json().catch(() => ({}));
	const scoped = response.status === 404 || (response.status === 403 && !/rate limit/i.test(message ?? ''));

	throw new Error(
		`GitHub would not ${doing} the gist (${response.status}${message ? `: ${message}` : ''})${scoped ? SCOPE_HINT : ''}`,
	);
};

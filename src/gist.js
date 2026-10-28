import { readConfig } from './config';
import { ENDER_PACK } from './instance/enderPack';
import { token } from './mods/github';

/**
 * Publish an ender pack as a secret gist under the GitHub account ender signs in with: unlisted, and readable by
 * anyone given its link, which is what a pack to follow needs. Answers where it is and the line that imports it.
 */
export const publishPack = async (pack, { fetcher = fetch, configured } = {}) => {
	const authorization = await token(configured ?? (await readConfig()).githubToken);

	if (!authorization) {
		throw new Error('Publishing a gist needs a GitHub account: sign in with gh auth login, or set GITHUB_TOKEN');
	}

	const response = await fetcher('https://api.github.com/gists', {
		method: 'POST',
		headers: {
			accept: 'application/vnd.github+json',
			authorization: `Bearer ${authorization}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify({
			description: `ender pack: ${pack.name ?? 'unnamed'}`,
			public: false,
			files: { [ENDER_PACK]: { content: `${JSON.stringify(pack, null, '\t')}\n` } },
		}),
	});

	if (!response.ok) {
		const { message } = await response.json().catch(() => ({}));

		throw new Error(
			`GitHub would not create the gist (${response.status}${message ? `: ${message}` : ''})${response.status === 404 || response.status === 403 ? '; the token needs the gist scope' : ''}`,
		);
	}

	const { id, html_url: url } = await response.json();

	return { id, url, line: `ender import gist:${id}` };
};

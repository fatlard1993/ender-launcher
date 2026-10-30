import { API, authorized, refused } from './githubAccount';

const nextPage = response => response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];

/** Every repository the account ender signs in with has starred, as owner/repo. */
export const starredRepositories = async ({ fetcher = fetch, configured } = {}) => {
	const headers = await authorized(configured);
	const starred = [];
	let url = `${API}/user/starred?per_page=100`;

	while (url) {
		const response = await fetcher(url, { headers });

		if (!response.ok) return refused(response, 'list its stars', 'star');

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

	if (!response.ok) return refused(response, `${starring ? 'star' : 'take back its star on'} ${repository}`, 'star');
};

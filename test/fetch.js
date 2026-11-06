/**
 * Run `work` with fetch answered by `answer(url, init)` instead of the network: a Response, or undefined for a 404.
 * Every request made is given to `work` as it was asked, so a test can hold the adapter to the request it builds.
 */
export const withFetch = async (answer, work) => {
	const real = globalThis.fetch;
	const asked = [];

	globalThis.fetch = async (url, init = {}) => {
		const request = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body };

		asked.push(request);

		return (await answer(request.url, request)) ?? new Response('no such route', { status: 404 });
	};

	try {
		return await work(asked);
	} finally {
		globalThis.fetch = real;
	}
};

import { describe, expect, test } from 'bun:test';

describe('ender share', () => {
	test('names a repository by the index key for it, and anything else by its id', async () => {
		const { shareKey } = await import('../src/commands/share');

		expect(shareKey('gh:fatlard1993/big-boats')).toBe('github:fatlard1993/big-boats');
		expect(shareKey('cb:someone/mod')).toBe('codeberg:someone/mod');
		expect(shareKey('sodium')).toBe('sodium');
	});

	test('chooses the mods named and offers the rest of the instance, each once', async () => {
		const { SHARE_PAGE, shareUrl } = await import('../src/commands/share');
		const url = new URL(shareUrl(['github:a/boats'], ['github:a/boats', 'sodium', 'lithium']));

		expect(`${url.origin}${url.pathname}`).toBe(SHARE_PAGE);
		expect(url.hash).toBe('#/share');
		expect(url.searchParams.getAll('mod')).toEqual(['github:a/boats']);
		expect(url.searchParams.getAll('from')).toEqual(['sodium', 'lithium']);
	});
});

import { describe, expect, test } from 'bun:test';

describe('ender share', () => {
	test('names a repository by the index key for it, and anything else by its id', async () => {
		const { shareKey } = await import('../src/commands/share');

		expect(shareKey('gh:fatlard1993/big-boats')).toBe('github:fatlard1993/big-boats');
		expect(shareKey('cb:someone/mod')).toBe('codeberg:someone/mod');
		expect(shareKey('sodium')).toBe('sodium');
	});

	test("opens the index's shot form with the mods named filled in, one to a line", async () => {
		const { SHARE_FORM, shareUrl } = await import('../src/commands/share');
		const url = new URL(shareUrl(['github:a/boats', 'lithium']));

		expect(`${url.origin}${url.pathname}`).toBe(SHARE_FORM);
		expect(url.searchParams.get('template')).toBe('shot.yml');
		expect(url.searchParams.get('mods')).toBe('github:a/boats\nlithium');
	});

	test('opens the pack form with the published pack filled in', async () => {
		const { SHARE_FORM, listPackUrl } = await import('../src/commands/share');
		const url = new URL(listPackUrl('https://gist.github.com/you/abc'));

		expect(`${url.origin}${url.pathname}`).toBe(SHARE_FORM);
		expect(url.searchParams.get('template')).toBe('pack.yml');
		expect(url.searchParams.get('pack')).toBe('https://gist.github.com/you/abc');
	});
});

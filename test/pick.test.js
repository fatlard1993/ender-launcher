import { describe, expect, test } from 'bun:test';

import { channelRank, pickBuild } from '../src/mods/pick';

const build = (name, channel, day) => ({ name, channel, published: Date.parse(`2026-09-${day}T00:00:00Z`) });

describe('channel ranking', () => {
	test('orders least to most stable', () => {
		expect(channelRank('alpha')).toBeLessThan(channelRank('beta'));
		expect(channelRank('beta')).toBeLessThan(channelRank('release'));
	});

	test('an unknown or absent channel is treated as a release', () => {
		expect(channelRank(undefined)).toBe(channelRank('release'));
		expect(channelRank('something-else')).toBe(channelRank('release'));
	});
});

describe('picking a build', () => {
	// The case that sent an alpha Sodium into a fresh instance.
	test('a release beats a newer prerelease', () => {
		const picked = pickBuild([build('alpha', 'alpha', 20), build('release', 'release', 15)]);

		expect(picked.name).toBe('release');
	});

	test('within a channel the newest wins', () => {
		const picked = pickBuild([build('old', 'release', 10), build('new', 'release', 20)]);

		expect(picked.name).toBe('new');
	});

	// A snapshot fresh enough that nobody has cut a release yet still has to resolve.
	test('falls back to the best channel actually present', () => {
		expect(pickBuild([build('a1', 'alpha', 10), build('a2', 'alpha', 20)]).name).toBe('a2');
		expect(pickBuild([build('a', 'alpha', 20), build('b', 'beta', 10)]).name).toBe('b');
	});

	test('allowPrerelease takes the newest of anything', () => {
		const candidates = [build('alpha', 'alpha', 20), build('release', 'release', 15)];

		expect(pickBuild(candidates, { allowPrerelease: true }).name).toBe('alpha');
	});

	test('does not depend on the order the source returned', () => {
		const candidates = [build('release', 'release', 15), build('alpha', 'alpha', 20)];

		expect(pickBuild(candidates).name).toBe('release');
		expect(pickBuild([...candidates].reverse()).name).toBe('release');
	});

	test('nothing in, nothing out', () => {
		expect(pickBuild([])).toBeUndefined();
	});

	test('candidates with no date still resolve', () => {
		expect(pickBuild([{ name: 'x', channel: 'release' }]).name).toBe('x');
	});
});

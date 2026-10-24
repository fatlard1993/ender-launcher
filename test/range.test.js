import { describe, expect, test } from 'bun:test';

import { satisfies } from '../src/mods/range';

describe('fabric version ranges', () => {
	// Every range here was read out of a real release jar by the index.
	test('a bounded range, with the trailing hyphen excluding the next version and its prereleases', () => {
		expect(satisfies('26.3', '>=26.3 <26.4-')).toBe(true);
		expect(satisfies('26.3.1', '>=26.3 <26.4-')).toBe(true);
		expect(satisfies('26.4-alpha.1', '>=26.3 <26.4-')).toBe(false);
		expect(satisfies('26.2', '>=26.3 <26.4-')).toBe(false);
	});

	test('tilde keeps to the minor version', () => {
		expect(satisfies('26.3', '~26.3')).toBe(true);
		expect(satisfies('26.3.2', '~26.3')).toBe(true);
		expect(satisfies('26.4', '~26.3')).toBe(false);
		expect(satisfies('26.3-alpha.2', '~26.3-')).toBe(true);
	});

	test('caret keeps to the major version', () => {
		expect(satisfies('1.21.4', '^1.20')).toBe(true);
		expect(satisfies('2.0', '^1.20')).toBe(false);
	});

	test('wildcards, alternatives, exact versions and anything', () => {
		expect(satisfies('1.21.4', '1.21.x')).toBe(true);
		expect(satisfies('1.20.6', '1.21.x')).toBe(false);
		expect(satisfies('1.21.2', '1.21.1 || 1.21.2')).toBe(true);
		expect(satisfies('1.21.3', '1.21.1 || 1.21.2')).toBe(false);
		expect(satisfies('1.21.1', '1.21.1')).toBe(true);
		expect(satisfies('26.3', '*')).toBe(true);
	});

	test('a prerelease sorts below its release and by its own parts', () => {
		expect(satisfies('26.3-alpha.2', '<26.3-alpha.3')).toBe(true);
		expect(satisfies('26.3-alpha.10', '<26.3-alpha.3')).toBe(false);
		expect(satisfies('26.3', '<26.3-alpha.3')).toBe(false);
	});

	test('an operator written apart from its version still reads', () => {
		expect(satisfies('1.21', '>= 1.20 < 1.22')).toBe(true);
	});
});

describe('maven version ranges', () => {
	test('half-open, open-ended and exact', () => {
		expect(satisfies('26.3', '[26.3, 26.4)')).toBe(true);
		expect(satisfies('26.4', '[26.3, 26.4)')).toBe(false);
		expect(satisfies('30.1', '[26.1.2,)')).toBe(true);
		expect(satisfies('26.1.1', '[26.1.2,)')).toBe(false);
		expect(satisfies('1.20', '(,1.20]')).toBe(true);
		expect(satisfies('1.20.1', '[1.20.1]')).toBe(true);
		expect(satisfies('1.20.2', '[1.20.1]')).toBe(false);
	});

	test('a union of ranges', () => {
		expect(satisfies('1.21', '[1.18,1.19),[1.20,1.22)')).toBe(true);
		expect(satisfies('1.19.2', '[1.18,1.19),[1.20,1.22)')).toBe(false);
	});
});

describe('what cannot be read', () => {
	test('is unknown, not a refusal', () => {
		expect(satisfies('26w14a', '>=26.3')).toBeUndefined();
		expect(satisfies('26.3', undefined)).toBeUndefined();
		expect(satisfies('26.3', '>=banana')).toBeUndefined();
	});

	test('a definite no in one term outweighs an unreadable other', () => {
		expect(satisfies('1.0', '>=2.0 <banana')).toBe(false);
	});
});

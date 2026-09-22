import { describe, expect, test } from 'bun:test';

import { offlineUuid } from '../src/auth';
import { parseModSpec } from '../src/commands/context';
import { parseArgv } from '../src/cli/parse';
import { coordinateToPath, coordinateToUrl } from '../src/meta/maven';
import { allowed, applicableArguments } from '../src/meta/rules';

describe('offline identity', () => {
	// Vanilla's own derivation; if this value moves, existing worlds stop recognizing the player.
	test('matches the known offline UUID for Notch', () => {
		expect(offlineUuid('Notch')).toBe('b50ad385-829d-3141-a216-7e7d7539ba7f');
	});

	test('is a version 3 uuid with the right variant', () => {
		const uuid = offlineUuid('someone-else');

		expect(uuid[14]).toBe('3');
		expect('89ab').toContain(uuid[19]);
	});
});

describe('maven coordinates', () => {
	test('resolves a plain coordinate', () => {
		expect(coordinateToPath('org.ow2.asm:asm:9.10.1')).toBe('org/ow2/asm/asm/9.10.1/asm-9.10.1.jar');
	});

	test('keeps the classifier, which distinguishes a natives jar from its own artifact', () => {
		expect(coordinateToPath('com.mojang:jtracy:1.14.38:natives-linux')).toBe(
			'com/mojang/jtracy/1.14.38/jtracy-1.14.38-natives-linux.jar',
		);
	});

	test('honors an explicit extension', () => {
		expect(coordinateToPath('net.fabricmc:intermediary:26.3@zip')).toEndWith('intermediary-26.3.zip');
	});

	test('joins onto a repository without doubling the separator', () => {
		expect(coordinateToUrl('a.b:c:1', 'https://maven.example/')).toBe('https://maven.example/a/b/c/1/c-1.jar');
	});
});

describe('rules', () => {
	test('no rules means allowed', () => {
		expect(allowed()).toBe(true);
		expect(allowed([])).toBe(true);
	});

	test('an unmatched os rule denies', () => {
		expect(allowed([{ action: 'allow', os: { name: 'nonesuch' } }])).toBe(false);
	});

	test('a later disallow overrides an earlier allow', () => {
		expect(allowed([{ action: 'allow' }, { action: 'disallow' }])).toBe(false);
	});

	test('features default to off', () => {
		expect(allowed([{ action: 'allow', features: { is_demo_user: true } }])).toBe(false);
		expect(allowed([{ action: 'allow', features: { is_demo_user: true } }], { is_demo_user: true })).toBe(true);
	});

	test('flattens argument entries and drops the ones that do not apply', () => {
		const flattened = applicableArguments([
			'--always',
			{ rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '1'] },
			{ rules: [{ action: 'allow' }], value: '--also' },
		]);

		expect(flattened).toEqual(['--always', '--also']);
	});
});

describe('argument parsing', () => {
	const spec = {
		instance: { alias: 'i' },
		verbose: { type: 'boolean', alias: 'v' },
		limit: { type: 'number', alias: 'n', default: 8 },
		dryRun: { type: 'boolean' },
	};

	test('takes any number of positionals', () => {
		expect(parseArgv(['a', 'b', 'c'], spec).positionals).toEqual(['a', 'b', 'c']);
	});

	test('accepts kebab-case for a camelCase flag', () => {
		expect(parseArgv(['--dry-run'], spec).flags.dryRun).toBe(true);
		expect(parseArgv(['--no-dry-run'], spec).flags.dryRun).toBe(false);
	});

	test('reads a value inline or as the next token', () => {
		expect(parseArgv(['--limit=3'], spec).flags.limit).toBe(3);
		expect(parseArgv(['--limit', '3'], spec).flags.limit).toBe(3);
	});

	test('groups short booleans and lets the last one take a value', () => {
		const { flags } = parseArgv(['-vi', 'suite'], spec);

		expect(flags.verbose).toBe(true);
		expect(flags.instance).toBe('suite');
	});

	test('refuses a value flag buried inside a group', () => {
		expect(() => parseArgv(['-iv', 'suite'], spec)).toThrow();
	});

	test('applies defaults and rejects unknown flags', () => {
		expect(parseArgv([], spec).flags.limit).toBe(8);
		expect(() => parseArgv(['--nope'], spec)).toThrow('Unknown flag');
	});

	test('passes everything after -- through untouched', () => {
		expect(parseArgv(['go', '--', '-Xmx8G', '--limit'], spec).rest).toEqual(['-Xmx8G', '--limit']);
	});
});

describe('mod specs', () => {
	test('defaults to modrinth', () => {
		expect(parseModSpec('sodium')).toEqual({ source: 'modrinth', id: 'sodium' });
	});

	test('understands source prefixes', () => {
		expect(parseModSpec('cf:jei').source).toBe('curseforge');
	});

	test('pins on the last @, so a version containing + or - survives', () => {
		expect(parseModSpec('mr:fabric-api@0.160.6+26.3')).toEqual({
			source: 'modrinth',
			id: 'fabric-api',
			version: '0.160.6+26.3',
		});
	});

	test('treats paths and urls as their own sources', () => {
		expect(parseModSpec('./build/libs/a.jar').source).toBe('local');
		expect(parseModSpec('https://example.com/a.jar').source).toBe('url');
	});
});

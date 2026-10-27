import { describe, expect, test } from 'bun:test';

import { formula, sumsOf } from '../scripts/formula';

const sums = sumsOf(
	['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64.exe']
		.map((target, at) => `${String(at).repeat(64)}  ender-${target}`)
		.join('\n'),
);

describe('the Homebrew formula', () => {
	test("installs each system and chip's own binary, checked by its sha256", () => {
		const written = formula('0.2.0', sums);

		expect(written).toContain('version "0.2.0"');
		expect(written).toContain(
			'  on_macos do\n    on_arm do\n      url "https://github.com/fatlard1993/ender-launcher/releases/download/v0.2.0/ender-darwin-arm64"\n      sha256 "' +
				'0'.repeat(64),
		);
		expect(written).toContain(`ender-linux-x64"\n      sha256 "${'3'.repeat(64)}"`);
		expect(written).toContain('bin.install Dir["ender-*"].first => "ender"');
	});

	test('is not written for a release missing a binary', () => {
		expect(() => formula('0.2.0', sumsOf(`${'0'.repeat(64)}  ender-darwin-arm64`))).toThrow(
			'No sha256 for ender-darwin-x64',
		);
	});
});

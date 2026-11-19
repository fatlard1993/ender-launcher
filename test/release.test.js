import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

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
			'  on_macos do\n    depends_on macos: :ventura\n\n    on_arm do\n      url "https://github.com/fatlard1993/ender-launcher/releases/download/v0.2.0/ender-darwin-arm64"\n      sha256 "' +
				'0'.repeat(64),
		);
		expect(written).toContain('  on_linux do\n    on_arm do\n');
		expect(written).toContain(`ender-linux-x64"\n      sha256 "${'3'.repeat(64)}"`);
		expect(written).toContain('bin.install Dir["ender-*"].first => "ender"');
	});

	test('says what to type first once brew has installed it', () => {
		expect(formula('0.2.0', sums)).toContain('Start with: ender new survival, then ender launch');
	});

	test('is not written for a release missing a binary', () => {
		expect(() => formula('0.2.0', sumsOf(`${'0'.repeat(64)}  ender-darwin-arm64`))).toThrow(
			'No sha256 for ender-darwin-x64',
		);
	});
});

describe('install.sh', () => {
	const scratch = mkdtemp(join(tmpdir(), 'ender-install-'));

	afterAll(async () => rm(await scratch, { recursive: true, force: true }));

	/** install.sh run on an Apple silicon Mac reporting macOS `version`, downloading from a folder with nothing in it. */
	const onMac = async version => {
		const directory = await mkdtemp(join(await scratch, 'mac-'));
		const bin = join(directory, 'bin');

		await Bun.$`mkdir -p ${bin} ${join(directory, 'releases')}`;
		await writeFile(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac\n');
		await writeFile(join(bin, 'sw_vers'), `#!/bin/sh\necho ${version}\n`);
		await chmod(join(bin, 'uname'), 0o755);
		await chmod(join(bin, 'sw_vers'), 0o755);

		const child = Bun.spawn(['sh', join(import.meta.dir, '..', 'install.sh')], {
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				ENDER_INSTALL: join(directory, 'installed'),
				ENDER_RELEASES: `file://${join(directory, 'releases')}`,
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});

		return { code: await child.exited, output: (await child.stdout.text()) + (await child.stderr.text()) };
	};

	test('refuses a Mac older than macOS 13 before downloading anything', async () => {
		const { code, output } = await onMac('12.7.4');

		expect(code).toBe(1);
		expect(output).toContain('needs macOS 13 or later, and this Mac has 12.7.4; nothing was installed');
		expect(output).not.toContain('Downloading');
	});

	test('downloads for macOS 13', async () => {
		expect((await onMac('13.6.1')).output).toContain('Downloading ender-darwin-arm64');
	});
});

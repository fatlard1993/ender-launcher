import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { adoptiumQuery, jdkHomeIn } from '../src/jdk';
import { resolveFromSource } from '../src/mods/indexed';
import { SOURCE_ZIPS, allowBuilding, pickBuiltJar } from '../src/mods/source';

let home;
let previous;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), 'ender-source-'));
	previous = process.env.ENDER_HOME;
	process.env.ENDER_HOME = home;
});

afterEach(async () => {
	if (previous === undefined) delete process.env.ENDER_HOME;
	else process.env.ENDER_HOME = previous;

	await rm(home, { recursive: true, force: true });
});

describe('a JDK', () => {
	test("is asked of Adoptium by Adoptium's names for the system", () => {
		expect(adoptiumQuery(21, 'linux', 'x64')).toContain('/21/hotspot?architecture=x64&image_type=jdk&os=linux');
		expect(adoptiumQuery(17, 'darwin', 'arm64')).toContain('architecture=aarch64&image_type=jdk&os=mac');
		expect(() => adoptiumQuery(21, 'sunos', 'x64')).toThrow('sunos-x64');
	});

	test('on macOS keeps bin/ inside its bundle', () => {
		expect(jdkHomeIn('/j', 'darwin')).toBe('/j/Contents/Home');
		expect(jdkHomeIn('/j', 'linux')).toBe('/j');
	});
});

test('each host serves a commit as a zip', () => {
	expect(SOURCE_ZIPS.github('a/b', 'c0ffee')).toBe('https://codeload.github.com/a/b/zip/c0ffee');
	expect(SOURCE_ZIPS.gitlab('g/sub/p', 'c0ffee')).toBe('https://gitlab.com/g/sub/p/-/archive/c0ffee/p-c0ffee.zip');
});

test("a build's jar is the one its version names, or else the largest that is not a by-product", async () => {
	const libs = join(home, 'build', 'libs');

	await mkdir(libs, { recursive: true });
	await writeFile(join(libs, 'mod-1.0+1.21.jar'), 'xx');
	await writeFile(join(libs, 'mod-1.0+1.21-sources.jar'), 'xxxxxxxx');
	await writeFile(join(libs, 'mod-dev.jar'), 'x');

	expect(await pickBuiltJar(home, '1.0+1.21')).toEndWith('mod-1.0+1.21.jar');
	expect(await pickBuiltJar(home, '2.0')).toEndWith('mod-1.0+1.21.jar');
	expect(await pickBuiltJar(join(home, 'nothing'), '1.0')).toBeUndefined();
});

test('building a repository is allowed by name, and stays allowed', async () => {
	expect(await allowBuilding('github:a/b', false)).toBe(false);
	expect(await allowBuilding('github:a/b', true)).toBe(true);
	expect(await allowBuilding('github:a/b', false)).toBe(true);
	expect(await allowBuilding('github:a/c', false)).toBe(false);
});

describe('a repository with only its source', () => {
	const record = {
		releases: [],
		source: {
			commit: 'c0ffee0000',
			minecraft: '1.21.4',
			loader: 'fabric',
			mods: [{ id: 'mod', loader: 'fabric', minecraft: '1.21.4' }],
		},
	};
	const entry = { source: 'github', id: 'a/b' };

	test('is not built until the player allows it, and says how', async () => {
		await expect(
			resolveFromSource(record, entry, { minecraft: '1.21.4', loader: 'fabric', buildMissing: false }),
		).rejects.toThrow('ender add github:a/b --build');
	});

	test('is not built for a game its source does not build for', async () => {
		await expect(
			resolveFromSource(record, entry, { minecraft: '1.20.1', loader: 'fabric', buildMissing: true }),
		).rejects.toThrow('builds for Minecraft 1.21.4');
		expect(await allowBuilding('github:a/b', false)).toBe(false);
	});

	test('is no source at all when the index knows none', async () => {
		expect(await resolveFromSource({ releases: [] }, entry, {})).toBeUndefined();
	});
});

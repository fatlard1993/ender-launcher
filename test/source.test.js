import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { adoptiumQuery, jdkHomeIn } from '../src/jdk';
import { resolveFromSource } from '../src/mods/indexed';
import { updateConfig } from '../src/config';
import { paths } from '../src/paths';
import {
	SOURCE_ZIPS,
	ScriptsChanged,
	allowHeldScripts,
	allowanceOf,
	buildFromSource,
	buildScripts,
	heldScriptsDiff,
	pickBuiltJar,
	scriptChanges,
} from '../src/mods/source';

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

/** A project's source as ender unpacks it to build, at one commit, from its files by path. */
const sourceAt = async (commit, files) => {
	const directory = join(home, 'cache', 'sources', 'github', 'a', 'b', commit);

	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(directory, path, '..'), { recursive: true });
		await writeFile(join(directory, path), text);
	}

	return directory;
};

const project = {
	gradlew: '#!/bin/sh',
	'gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=gradle-8.10',
	'settings.gradle': "includeBuild 'plugins'",
	'build.gradle': "plugins { id 'fabric-loom' }",
	'gradle.properties': 'mod_version=1.0',
	'plugins/src/main/java/Plugin.java': 'class Plugin {}',
	'buildSrc/src/main/kotlin/Logic.kt': 'object Logic',
	'src/main/java/Mod.java': 'class Mod {}',
	'build/libs/mod.jar': 'x',
};

describe("building a repository's source", () => {
	test('holds an allowance to the build scripts: the wrapper, scripts, properties, buildSrc and included builds', async () => {
		const scripts = await buildScripts(await sourceAt('c0ffee0000', project));

		expect(Object.keys(scripts)).toEqual([
			'build.gradle',
			'buildSrc/src/main/kotlin/Logic.kt',
			'gradle.properties',
			'gradle/wrapper/gradle-wrapper.properties',
			'gradlew',
			'plugins/src/main/java/Plugin.java',
			'settings.gradle',
		]);
		expect(
			scriptChanges(scripts, { ...scripts, 'build.gradle': 'other', 'new.gradle.kts': 'x', gradlew: undefined }),
		).toEqual({
			added: ['new.gradle.kts'],
			changed: ['build.gradle', 'gradlew'],
			removed: [],
		});
	});

	test('a later commit whose build scripts changed is not built, and says which changed and how to compare them', async () => {
		const first = await buildScripts(await sourceAt('c0ffee0000', project));

		await updateConfig({ builds: { 'github:a/b': { commit: 'c0ffee0000', scripts: first } } });
		await sourceAt('beef000000', {
			...project,
			'build.gradle': "plugins { id 'fabric-loom' }\nexec { 'curl' }",
			'mod.gradle': 'x',
		});

		const held = buildFromSource({
			host: 'github',
			name: 'a/b',
			commit: 'beef000000',
			allowance: await allowanceOf('github:a/b'),
		});

		await expect(held).rejects.toBeInstanceOf(ScriptsChanged);
		await expect(held).rejects.toThrow('added: mod.gradle');
		await expect(held).rejects.toThrow('changed: build.gradle');
		await expect(held).rejects.toThrow(
			`git diff --no-index ${join(home, 'builds-allowed', 'github', 'a/b')} ${join(home, 'builds-allowed', 'github', 'a/b@beef000')}`,
		);
		expect(await Bun.file(join(home, 'builds-allowed', 'github', 'a/b@beef000', 'mod.gradle')).exists()).toBe(true);

		const diff = await heldScriptsDiff('github:a/b', 'beef000000');

		expect(diff).toContain("+exec { 'curl' }");
		expect(diff).toContain('b/b@beef000/mod.gradle');
		expect(await heldScriptsDiff('github:a/b', 'abc1234')).toBeUndefined();
		for (const key of ['github:../b', 'github:a/..', 'github:./b', 'github:a/../../x']) {
			expect(await allowHeldScripts(key, 'beef000000')).toBe(false);
			expect(await heldScriptsDiff(key, 'beef000000')).toBeUndefined();
		}
		expect(await allowHeldScripts('github:a/b', 'abc1234')).toBe(false);
		expect(await allowHeldScripts('github:a/b', 'beef000000')).toBe(true);
		expect(await allowanceOf('github:a/b')).toEqual({
			commit: 'beef000000',
			scripts: await buildScripts(join(home, 'cache', 'sources', 'github', 'a', 'b', 'beef000000')),
		});
		expect(await allowHeldScripts('github:a/b', 'beef000000')).toBe(false);
	});

	test('an allowance from ender 0.3, a list, is asked for again, and allowing one keeps the others', async () => {
		await writeFile(
			paths.config,
			JSON.stringify({ activeInstance: 'suite', clientId: 'x', builds: ['github:a/b', 'github:c/d'] }),
		);
		await sourceAt('beef000000', project);

		expect(await allowanceOf('github:a/b')).toEqual({});
		expect(await allowanceOf('github:a/c')).toBeUndefined();
		await expect(
			buildFromSource({
				host: 'github',
				name: 'a/b',
				commit: 'beef000000',
				allowance: await allowanceOf('github:a/b'),
			}),
		).rejects.toThrow('was allowed to build before ender kept which build scripts an allowance covers');
		expect(await allowHeldScripts('github:a/b', 'beef000000')).toBe(true);
		expect(await allowanceOf('github:c/d')).toEqual({});
		expect(await Bun.file(paths.config).json()).toMatchObject({
			format: 1,
			activeInstance: 'suite',
			builds: { 'github:c/d': {} },
		});
		expect(await Bun.file(paths.config).json()).not.toHaveProperty('clientId');
	});

	test('is never started without an allowance', async () => {
		await expect(buildFromSource({ host: 'github', name: 'a/b', commit: 'beef000000' })).rejects.toThrow(
			'was not allowed',
		);
	});
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
		expect(await allowanceOf('github:a/b')).toBeUndefined();
	});

	test('with releases for other versions says so, rather than that it has none', async () => {
		const released = { ...record, releases: [{ tag: 'v1', assets: [] }] };

		await expect(
			resolveFromSource(released, entry, { minecraft: '1.21.4', loader: 'fabric', buildMissing: false }),
		).rejects.toThrow('github:a/b has no release for Minecraft 1.21.4 on fabric, only its source');
		await expect(
			resolveFromSource(record, entry, { minecraft: '1.21.4', loader: 'fabric', buildMissing: false }),
		).rejects.toThrow('github:a/b has no built release, only its source');
	});

	test('is no source at all when the index knows none', async () => {
		expect(await resolveFromSource({ releases: [] }, entry, {})).toBeUndefined();
	});
});

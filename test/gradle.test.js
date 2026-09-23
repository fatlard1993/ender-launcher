import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { builtJar, isProject, readProperties, resolve } from '../src/mods/gradle';

let root;

const project = async (name, properties, jars = []) => {
	const directory = join(root, name);

	await mkdir(join(directory, 'build', 'libs'), { recursive: true });
	await writeFile(join(directory, 'gradle.properties'), properties);

	for (const jar of jars) await writeFile(join(directory, 'build', 'libs', jar), jar);

	return directory;
};

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'mcm-gradle-'));
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('reading gradle.properties', () => {
	test('tolerates both spacing styles, which these projects mix', async () => {
		const directory = await project('spacing', 'a = 1\nb=2\n# note\n\nc   =   3\n');

		expect(await readProperties(directory)).toEqual({ a: '1', b: '2', c: '3' });
	});

	test('a directory without one is not a project', async () => {
		expect(await isProject(join(root, 'nope'))).toBe(false);
	});
});

describe('finding the built jar', () => {
	// The name cannot be computed: some projects set archives_base_name, some derive it from
	// mod_id, some append the author. What holds is that the jar ends with its version.
	test('finds it whatever the base name is', async () => {
		const plain = await project('plain', 'mod_version = 1.0.0\n', ['kragle-1.0.0.jar']);
		const suffixed = await project('suffixed', 'mod_version = 3.1.1\n', ['wood-floor-justfatlard-3.1.1.jar']);

		expect(await builtJar(plain, '1.0.0')).toEndWith('kragle-1.0.0.jar');
		expect(await builtJar(suffixed, '3.1.1')).toEndWith('wood-floor-justfatlard-3.1.1.jar');
	});

	// Classifiers come after the version, so matching the version already excludes them.
	test('ignores sources, testsupport and the other siblings', async () => {
		const directory = await project('variants', 'mod_version = 15.8.0\n', [
			'pandorical-15.8.0.jar',
			'pandorical-15.8.0-sources.jar',
			'pandorical-15.8.0-testsupport.jar',
		]);

		expect(await builtJar(directory, '15.8.0')).toEndWith('pandorical-15.8.0.jar');
	});

	// build/libs keeps every version ever built, so the declared one has to be picked exactly.
	test('picks the declared version, not the newest file', async () => {
		const directory = await project('history', 'mod_version = 15.3.1\n', [
			'pandorical-15.1.0.jar',
			'pandorical-15.3.1.jar',
			'pandorical-15.8.0.jar',
		]);

		expect(await builtJar(directory, '15.3.1')).toEndWith('pandorical-15.3.1.jar');
	});

	test('says nothing rather than guessing when that version was never built', async () => {
		const directory = await project('absent', 'mod_version = 2.0.0\n', ['thing-1.0.0.jar']);

		expect(await builtJar(directory, '2.0.0')).toBeUndefined();
	});
});

describe('resolving a project', () => {
	test('takes its version from the properties, so a rebuild needs no manifest edit', async () => {
		const directory = await project('versioned', 'mod_version = 4.5.6\nminecraft_version = 26.3\n', [
			'versioned-4.5.6.jar',
		]);
		const resolution = await resolve({ path: directory }, { minecraft: '26.3' });

		expect(resolution.version).toBe('4.5.6');
		expect(resolution.file.filename).toBe('versioned-4.5.6.jar');
		expect(resolution.file.localPath).toEndWith('versioned-4.5.6.jar');
	});

	test('refuses a project built against another game version', async () => {
		const directory = await project('mismatch', 'mod_version = 1.0.0\nminecraft_version = 1.20.1\n', [
			'mismatch-1.0.0.jar',
		]);

		await expect(resolve({ path: directory }, { minecraft: '26.3' })).rejects.toThrow('built for Minecraft 1.20.1');
	});

	test('will not build behind you unless asked', async () => {
		const directory = await project('unbuilt', 'mod_version = 1.0.0\nminecraft_version = 26.3\n');

		await expect(resolve({ path: directory }, { minecraft: '26.3' })).rejects.toThrow('no built jar');
	});
});

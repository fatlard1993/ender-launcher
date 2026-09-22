import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { ensureFile } from '../src/download';
import { coordinateToPath } from '../src/meta/maven';
import { assertKnownLoader, assertLaunchableLoader, isLaunchable } from '../src/meta/resolve';
import { chooseAsset } from '../src/mods/github';
import { extractArchive } from '../src/archive';

describe('maven coordinates cannot leave the repository root', () => {
	test('an extension segment cannot climb out', () => {
		expect(() => coordinateToPath('a:b:1:@../../../../../../home/chase/.bashrc')).toThrow('Unusable maven');
	});

	test('dotted segments are refused', () => {
		expect(() => coordinateToPath('..:..:..')).toThrow('Unusable maven');
	});

	test('a separator inside a segment is refused', () => {
		expect(() => coordinateToPath('a/b:c:1')).toThrow('Unusable maven');
		expect(() => coordinateToPath('a:b:1@../x')).toThrow('Unusable maven');
	});

	test('ordinary coordinates still resolve', () => {
		expect(coordinateToPath('org.ow2.asm:asm:9.10.1')).toBe('org/ow2/asm/asm/9.10.1/asm-9.10.1.jar');
		expect(coordinateToPath('com.mojang:jtracy:1.14.38:natives-linux')).toEndWith('-natives-linux.jar');
	});
});

describe('holding an instance and launching it are separate abilities', () => {
	test('every real loader can be held', () => {
		for (const type of ['fabric', 'quilt', 'forge', 'neoforge', 'vanilla']) {
			expect(assertKnownLoader({ type })).toBe(type);
		}

		expect(assertKnownLoader(undefined)).toBe('vanilla');
	});

	test('something that is not a loader at all is still refused', () => {
		expect(() => assertKnownLoader({ type: 'banana' })).toThrow('not a Minecraft loader');
	});

	test('only fabric and vanilla can be launched', () => {
		expect(isLaunchable('fabric')).toBe(true);
		expect(isLaunchable('vanilla')).toBe(true);
		expect(isLaunchable(undefined)).toBe(true);

		for (const type of ['quilt', 'forge', 'neoforge']) expect(isLaunchable(type)).toBe(false);
	});

	test('asking for a launch mcm cannot build says so, rather than answering with vanilla', () => {
		for (const type of ['quilt', 'forge', 'neoforge']) {
			expect(() => assertLaunchableLoader({ type })).toThrow(`cannot build a ${type} launch`);
		}

		expect(assertLaunchableLoader({ type: 'fabric' })).toBe('fabric');
	});
});

describe('github asset selection', () => {
	test('the loader decides between equal-length multiloader jars', () => {
		const assets = [{ name: 'mod-1.0-forge.jar' }, { name: 'mod-1.0-fabri.jar' }];

		expect(chooseAsset(assets, { loader: 'forge' }).name).toBe('mod-1.0-forge.jar');
	});

	test('loader wins before game version', () => {
		const assets = [{ name: 'mod-26.3-forge.jar' }, { name: 'mod-26.3-fabric.jar' }];

		expect(chooseAsset(assets, { minecraft: '26.3', loader: 'fabric' }).name).toBe('mod-26.3-fabric.jar');
	});
});

describe('a download with no checksum still has to be the right length', () => {
	let server;
	let directory;

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'mcm-verify-'));
		server = Bun.serve({ port: 0, fetch: () => new Response('nowhere near a jar') });
	});

	afterAll(async () => {
		server.stop();

		await rm(directory, { recursive: true, force: true });
	});

	test('a body shorter than the declared size is refused', async () => {
		const attempt = ensureFile({
			url: `http://localhost:${server.port}/m.jar`,
			path: join(directory, 'a.jar'),
			size: 1908068,
		});

		await expect(attempt).rejects.toThrow('Expected 1908068 bytes');
	});

	test('nothing is left behind when it is refused', async () => {
		expect(await Bun.file(join(directory, 'a.jar')).exists()).toBe(false);
	});

	test('a body matching the declared size is kept', async () => {
		const path = join(directory, 'b.jar');

		await ensureFile({ url: `http://localhost:${server.port}/m.jar`, path, size: 18 });

		expect(await Bun.file(path).text()).toBe('nowhere near a jar');
	});
});

describe('natives archives', () => {
	let directory;

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'mcm-zip-'));
	});

	afterAll(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test('refuses an archive that is not one', async () => {
		const path = join(directory, 'not.jar');

		await writeFile(path, 'definitely not a zip');

		await expect(extractArchive(path, directory)).rejects.toThrow('Not a zip archive');
	});
});

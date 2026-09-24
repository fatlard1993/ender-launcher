import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { ensureFile } from '../src/download';
import { coordinateToPath } from '../src/meta/maven';
import { LOADER_SERVICES, assertKnownLoader, assertLaunchableLoader, isLaunchable } from '../src/meta/resolve';
import { chooseAsset } from '../src/mods/github';
import { strategyFor } from '../src/server';
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

	test('every known loader can now be launched', () => {
		for (const type of ['fabric', 'quilt', 'forge', 'neoforge', 'vanilla']) {
			expect(isLaunchable(type)).toBe(true);
			expect(assertLaunchableLoader({ type })).toBe(type);
		}

		expect(isLaunchable(undefined)).toBe(true);
	});

	test('a loader that does not exist is refused at both gates', () => {
		expect(() => assertKnownLoader({ type: 'banana' })).toThrow('not a Minecraft loader');
		expect(() => assertLaunchableLoader({ type: 'banana' })).toThrow('not a Minecraft loader');
	});

	test('vanilla needs no service; every other launchable loader has one', () => {
		expect(LOADER_SERVICES.vanilla).toBeUndefined();

		for (const type of ['fabric', 'quilt', 'forge', 'neoforge']) {
			expect(typeof LOADER_SERVICES[type].latestLoader).toBe('function');
			expect(typeof LOADER_SERVICES[type].profile).toBe('function');
			expect(typeof LOADER_SERVICES[type].libraryJobs).toBe('function');
		}
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
		directory = await mkdtemp(join(tmpdir(), 'ender-verify-'));
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
		directory = await mkdtemp(join(tmpdir(), 'ender-zip-'));
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

describe('loader services', () => {
	test('forge names its profile after the pairing, neoforge after itself', () => {
		expect(LOADER_SERVICES.forge.profileId('1.20.1', '47.4.23')).toBe('1.20.1-forge-47.4.23');
		expect(LOADER_SERVICES.neoforge.profileId('1.21.1', '21.1.251')).toBe('neoforge-21.1.251');
	});

	test('each service says where its answers come from, so explain can report it', () => {
		expect(LOADER_SERVICES.fabric.source).toBe('meta.fabricmc.net');
		expect(LOADER_SERVICES.quilt.source).toBe('meta.quiltmc.org');
		expect(LOADER_SERVICES.forge.source).toBe('its own installer');
		expect(LOADER_SERVICES.neoforge.source).toBe('its own installer');
	});
});

describe('server strategies', () => {
	const instance = type => ({ name: 't', gameDir: '/tmp/x', loader: { type } });

	test('every launchable loader can also run a server', () => {
		for (const type of ['fabric', 'quilt', 'forge', 'neoforge', 'vanilla']) {
			expect(strategyFor(instance(type)).name).toBeString();
		}
	});

	test('an instance with no loader is treated as vanilla', () => {
		expect(strategyFor({ name: 't', gameDir: '/tmp/x' }).name).toBe('Vanilla');
	});

	// Fabric ships a bootstrap jar and Quilt's installer writes one; Forge and NeoForge are started
	// from an argument file instead, so they have no jar to name.
	test('only the loaders that end up with a runnable jar expose one', () => {
		expect(strategyFor(instance('fabric')).jarPath(instance('fabric'))).toEndWith('fabric-server.jar');
		expect(strategyFor(instance('quilt')).jarPath(instance('quilt'))).toEndWith('quilt-server-launch.jar');
		expect(strategyFor(instance('vanilla')).jarPath(instance('vanilla'))).toEndWith('server.jar');
		expect(strategyFor(instance('forge')).jarPath).toBeUndefined();
	});
});

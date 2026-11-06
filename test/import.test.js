import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { fromPrism } from '../src/instance/import';

let directory;

const prismInstance = async (name, gameDirName) => {
	const instance = join(directory, name);

	await mkdir(join(instance, gameDirName, 'mods'), { recursive: true });
	await writeFile(
		join(instance, 'mmc-pack.json'),
		JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.21.1' }] }),
	);

	return instance;
};

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), 'ender-import-'));
});

afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe('prism import', () => {
	test('finds a .minecraft game directory', async () => {
		const { manifest } = await fromPrism(await prismInstance('dotted', '.minecraft'));

		expect(manifest.gameDir).toEndWith(join('dotted', '.minecraft'));
	});

	test('finds a game directory Prism named without the dot', async () => {
		const { manifest } = await fromPrism(await prismInstance('plain', 'minecraft'));

		expect(manifest.gameDir).toEndWith(join('plain', 'minecraft'));
	});
});

describe('what a Prism instance says of itself', () => {
	const prism = async (name, components, cfg) => {
		const instance = join(directory, name);

		await mkdir(join(instance, '.minecraft', 'mods'), { recursive: true });
		await writeFile(
			join(instance, 'mmc-pack.json'),
			JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.21.1' }, ...components] }),
		);
		if (cfg) await writeFile(join(instance, 'instance.cfg'), cfg);

		return fromPrism(instance);
	};

	test('each loader component is the loader it stands for, and none is vanilla', async () => {
		const loaders = {
			'net.fabricmc.fabric-loader': 'fabric',
			'org.quiltmc.quilt-loader': 'quilt',
			'net.minecraftforge': 'forge',
			'net.neoforged': 'neoforge',
		};

		for (const [uid, type] of Object.entries(loaders)) {
			const { manifest } = await prism(type, [{ uid, version: '1.2.3' }]);

			expect(manifest.loader).toEqual({ type, version: '1.2.3' });
		}

		expect((await prism('plain', [{ uid: 'org.lwjgl3', version: '3.3.3' }])).manifest.loader).toEqual({
			type: 'vanilla',
		});
	});

	test('its name, memory and JVM arguments are taken only where Prism says they override the defaults', async () => {
		const overridden = await prism(
			'tuned',
			[],
			[
				'[General]',
				'name="Tuned Pack"',
				'OverrideMemory=true',
				'MinMemAlloc=1024',
				'MaxMemAlloc=6144',
				'OverrideJavaArgs=true',
				'JvmArgs=-XX:+UseG1GC  -Dfoo=bar',
			].join('\n'),
		);
		const defaulted = await prism(
			'untuned',
			[],
			['[General]', 'name=Untuned', 'MaxMemAlloc=6144', 'JvmArgs=-Xss1M'].join('\n'),
		);

		expect(overridden.manifest).toMatchObject({
			name: 'Tuned Pack',
			type: 'client',
			memory: { min: 1024, max: 6144 },
			jvmArgs: ['-XX:+UseG1GC', '-Dfoo=bar'],
		});
		expect(defaulted.manifest).toMatchObject({ name: 'Untuned', memory: undefined, jvmArgs: [] });
		expect((await prism('unnamed', [])).manifest.name).toBe('unnamed');
	});

	test('a directory with no mmc-pack.json is not a Prism instance', async () => {
		await expect(fromPrism(join(directory, 'nowhere'))).rejects.toThrow('Not a Prism instance');
	});
});

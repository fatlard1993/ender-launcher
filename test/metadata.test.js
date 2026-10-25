import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { parseLeniently, readMods } from '../src/mods/metadata';
import { jar as jarIn } from './jars';

let directory;

const jar = files => jarIn(directory, files);

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), 'ender-metadata-'));
});

afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe('mods declared in a built jar', () => {
	test('fabric', async () => {
		const path = await jar({
			'fabric.mod.json': JSON.stringify({
				id: 'modmenu',
				version: '22.0.0',
				name: 'Mod Menu',
				environment: 'client',
				depends: { fabricloader: '>=0.19.2', minecraft: ['1.21.1', '1.21.2'] },
			}),
		});

		expect(await readMods(path)).toEqual([
			{
				loader: 'fabric',
				id: 'modmenu',
				version: '22.0.0',
				name: 'Mod Menu',
				description: undefined,
				minecraft: '1.21.1 || 1.21.2',
				environment: 'client',
				depends: ['fabricloader', 'minecraft'],
				provides: [],
			},
		]);
	});

	// Fabric API ships its modules as nested jars, and mods depend on the modules by name.
	test('a fabric jar provides the mods nested inside it, and what it declares it provides', async () => {
		const module = await jar({ 'fabric.mod.json': JSON.stringify({ id: 'fabric-screen-api-v1', version: '1' }) });
		const path = await jar({
			'fabric.mod.json': JSON.stringify({ id: 'fabric-api', version: '1', provides: ['fabric'] }),
			'META-INF/jars/fabric-screen-api-v1.jar': await Bun.file(module).bytes(),
			'META-INF/jars/broken.jar': 'not a jar',
		});
		const [mod] = await readMods(path);

		expect(mod.provides).toEqual(['fabric', 'fabric-screen-api-v1']);
	});

	test('quilt', async () => {
		const path = await jar({
			'quilt.mod.json': JSON.stringify({
				quilt_loader: {
					id: 'q',
					version: '1.0',
					metadata: { name: 'Q' },
					depends: ['quilt_loader', { id: 'minecraft', versions: '>=1.20' }],
				},
			}),
		});
		const [mod] = await readMods(path);

		expect(mod).toMatchObject({
			loader: 'quilt',
			id: 'q',
			version: '1.0',
			name: 'Q',
			minecraft: '>=1.20',
			depends: ['quilt_loader', 'minecraft'],
		});
	});

	// The version placeholder is filled from the jar manifest at load time, so it is filled from there here.
	test('neoforge, with its version taken from the jar manifest', async () => {
		const path = await jar({
			'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\nImplementation-Version: 3.0.5\n',
			'META-INF/neoforge.mods.toml': [
				'modLoader = "javafml"',
				'[[mods]]',
				'modId = "backpacked"',
				'version = "${file.jarVersion}"',
				'displayName = "Backpacked"',
				'[[dependencies.backpacked]]',
				'modId = "minecraft"',
				'type = "required"',
				'versionRange = "[1.21.1,1.21.2)"',
				'side = "BOTH"',
				'[[dependencies.backpacked]]',
				'modId = "jei"',
				'type = "optional"',
			].join('\n'),
		});

		expect(await readMods(path)).toEqual([
			{
				loader: 'neoforge',
				id: 'backpacked',
				version: '3.0.5',
				name: 'Backpacked',
				description: undefined,
				minecraft: '[1.21.1,1.21.2)',
				environment: '*',
				depends: ['minecraft'],
			},
		]);
	});

	test('a jar built for two loaders declares both', async () => {
		const path = await jar({
			'fabric.mod.json': JSON.stringify({ id: 'both', version: '1' }),
			'META-INF/mods.toml': 'modLoader = "javafml"\n[[mods]]\nmodId = "both"\nversion = "1"\n',
		});

		expect((await readMods(path)).map(mod => mod.loader)).toEqual(['fabric', 'forge']);
	});

	test('a jar that declares nothing holds no mods', async () => {
		expect(await readMods(await jar({ 'a/A.class': 'x' }))).toEqual([]);
	});
});

describe('metadata as published', () => {
	// A real release jar describes itself over several raw lines, and loads.
	test('a line break written raw inside a string is read as one', () => {
		expect(parseLeniently('{ "id": "ba", "description": "BA items\nDeveloper: \\"Cirno\\"\tqwa" }')).toEqual({
			id: 'ba',
			description: 'BA items\nDeveloper: "Cirno"\tqwa',
		});
	});

	test('what is broken otherwise still fails, with the original complaint', () => {
		expect(() => parseLeniently('{ "id": ')).toThrow();
	});

	// owo-lib 0.3.2+1.17 was uploaded inside its form body; Java reads it, so the game loads it.
	test('a jar with bytes before and after the archive is read where the archive sits', async () => {
		const plain = await jar({ 'fabric.mod.json': JSON.stringify({ id: 'owo', version: '0.3.2' }) });
		const wrapped = join(directory, 'wrapped.jar');

		await Bun.write(wrapped, [
			'--boundary\r\ncontent-type: application/java-archive\r\n\r\n',
			await Bun.file(plain).arrayBuffer(),
			'\r\n--boundary--\r\n',
		]);

		expect((await readMods(wrapped)).map(mod => mod.id)).toEqual(['owo']);
	});
});

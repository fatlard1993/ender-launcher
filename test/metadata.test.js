import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { ICON_LIMIT, parseLeniently, readContent, readIcon, readLinks, readMods } from '../src/mods/metadata';
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
				suggests: ['jei'],
			},
		]);
	});

	test('what a mod works with, breaks and conflicts with, apart from what it needs, on every loader', async () => {
		const fabric = await jar({
			'fabric.mod.json': JSON.stringify({
				id: 'f',
				version: '1',
				depends: { 'fabric-api': '*' },
				recommends: { modmenu: '*' },
				suggests: { jei: '*' },
				breaks: { optifabric: '*', pandorical: ['<15.0.0', '>=20'] },
				conflicts: { sodium: '<0.6' },
			}),
		});
		const quilt = await jar({
			'quilt.mod.json': JSON.stringify({
				quilt_loader: {
					id: 'q',
					version: '1',
					depends: ['qsl', { id: 'emi', optional: true }],
					breaks: [{ id: 'optifabric', versions: '<2' }],
				},
			}),
		});
		const forge = await jar({
			'META-INF/mods.toml': [
				'modLoader = "javafml"',
				'[[mods]]',
				'modId = "g"',
				'version = "1"',
				'[[dependencies.g]]',
				'modId = "curios"',
				'mandatory = false',
				'[[dependencies.g]]',
				'modId = "architectury"',
				'mandatory = true',
				'[[dependencies.g]]',
				'modId = "optifine"',
				'type = "incompatible"',
				'versionRange = "[1.0,2.0)"',
				'[[dependencies.g]]',
				'modId = "rubidium"',
				'type = "discouraged"',
			].join('\n'),
		});

		expect((await readMods(fabric))[0]).toMatchObject({
			depends: ['fabric-api'],
			suggests: ['modmenu', 'jei'],
			breaks: ['optifabric', 'pandorical'],
			breaksVersions: { optifabric: '*', pandorical: '<15.0.0 || >=20' },
			conflicts: ['sodium'],
			conflictsVersions: { sodium: '<0.6' },
		});
		expect((await readMods(quilt))[0]).toMatchObject({
			depends: ['qsl'],
			suggests: ['emi'],
			breaks: ['optifabric'],
			breaksVersions: { optifabric: '<2' },
		});
		expect((await readMods(forge))[0]).toMatchObject({
			depends: ['architectury'],
			suggests: ['curios'],
			breaks: ['optifine'],
			breaksVersions: { optifine: '[1.0,2.0)' },
			conflicts: ['rubidium'],
			conflictsVersions: { rubidium: '*' },
		});
		expect((await readMods(forge))[0]).not.toHaveProperty('depends', expect.arrayContaining(['optifine']));
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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('the icon a jar declares', () => {
	test('a fabric icon, the smallest of its sizes at least 64 wide', async () => {
		const path = await jar({
			'fabric.mod.json': JSON.stringify({
				id: 'a',
				icon: { 16: 'assets/a/16.png', 128: 'assets/a/128.png', 64: 'assets/a/64.png' },
			}),
			'assets/a/16.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 16]),
			'assets/a/64.png': PNG,
			'assets/a/128.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 128]),
		});

		expect(await readIcon(path)).toEqual({ type: 'png', bytes: PNG });
	});

	test('a forge logo file, named from the root', async () => {
		const path = await jar({
			'META-INF/mods.toml': 'logoFile="/logo.png"\n[[mods]]\nmodId="b"\n',
			'logo.png': PNG,
		});

		expect(await readIcon(path)).toEqual({ type: 'png', bytes: PNG });
	});

	test('a quilt icon', async () => {
		const path = await jar({
			'quilt.mod.json': JSON.stringify({ quilt_loader: { id: 'c', metadata: { icon: 'icon.png' } } }),
			'icon.png': PNG,
		});

		expect((await readIcon(path)).type).toBe('png');
	});

	// An SVG can carry script; a page shows only the formats it can hold as a picture.
	test('none when the declared file is missing, too large, or not a picture', async () => {
		expect(await readIcon(await jar({ 'fabric.mod.json': JSON.stringify({ id: 'd', icon: 'gone.png' }) }))).toBe(
			undefined,
		);
		expect(
			await readIcon(
				await jar({
					'fabric.mod.json': JSON.stringify({ id: 'e', icon: 'icon.svg' }),
					'icon.svg': '<svg onload="x()"/>',
				}),
			),
		).toBe(undefined);
		expect(
			await readIcon(
				await jar({
					'fabric.mod.json': JSON.stringify({ id: 'f', icon: 'big.png' }),
					'big.png': Buffer.concat([PNG, Buffer.alloc(ICON_LIMIT)]),
				}),
			),
		).toBe(undefined);
		expect(await readIcon(await jar({ 'a/A.class': 'x' }))).toBe(undefined);
	});
});

describe('the links a jar gives', () => {
	test("are its contact entries and Mod Menu's, each by its key, web addresses only and each once", async () => {
		const path = await jar({
			'fabric.mod.json': JSON.stringify({
				id: 'm',
				contact: { sources: 'https://github.com/a/m', email: 'a@example.com', homepage: 'javascript:alert(1)' },
				custom: {
					modmenu: { links: { 'modmenu.kofi': 'https://ko-fi.com/a', 'modmenu.source': 'https://github.com/a/m' } },
				},
			}),
		});

		expect(await readLinks(path)).toEqual([
			{ name: 'sources', url: 'https://github.com/a/m' },
			{ name: 'modmenu.kofi', url: 'https://ko-fi.com/a' },
		]);
	});

	test("are Quilt's contact entries and its top-level Mod Menu links", async () => {
		const path = await jar({
			'quilt.mod.json': JSON.stringify({
				quilt_loader: { id: 'q', metadata: { contact: { issues: 'https://example.com/issues' } } },
				modmenu: { links: { donate: 'https://example.com/donate' } },
			}),
		});

		expect((await readLinks(path)).map(link => link.name)).toEqual(['issues', 'donate']);
	});
});

describe('what a jar adds', () => {
	test("its own names for what it adds, the data it ships and its shaders, and none of vanilla's", async () => {
		const path = await jar({
			'assets/boats/lang/en_us.json': JSON.stringify({
				'block.boats.helm': 'Ship Helm',
				'block.boats.helm.tooltip': 'Steers a ship',
				'item.boats.paddle': 'Paddle',
				'entity.boats.ship': 'Ship',
				'itemGroup.boats': 'Big Boats',
				'gui.boats.title': 'Christen your ship',
			}),
			'assets/minecraft/lang/en_us.json': JSON.stringify({ 'block.minecraft.stone': 'Smooth Stone' }),
			'assets/old/lang/en_us.lang': '# old style\ntile.old.rope.name=Rope\nitem.old.hook.name=Grappling Hook\n',
			'assets/boats/shaders/core/water.json': '{}',
			'data/boats/worldgen/structure/harbor.json': '{}',
			'data/boats/recipes/helm.json': '{}',
			'data/minecraft/tags/blocks/logs.json': '{}',
		});

		expect(await readContent(path)).toEqual({
			names: {
				block: ['Rope', 'Ship Helm'],
				item: ['Grappling Hook', 'Paddle'],
				entity: ['Ship'],
				group: ['Big Boats'],
			},
			data: ['recipe', 'worldgen'],
			shaders: true,
		});
	});

	test('a jar with no language file or data adds nothing it names', async () => {
		expect(await readContent(await jar({ 'a/A.class': 'x' }))).toEqual({ names: {}, data: [], shaders: false });
	});
});

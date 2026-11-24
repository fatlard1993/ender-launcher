import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { clone } from '../src/commands/instances';
import { packFrom } from '../src/instance/enderPack';
import * as kept from '../src/commands/kept';
import * as instances from '../src/instance';
import { paths } from '../src/paths';
import { rawZip } from './jars';

let home;
let previous;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), 'ender-instances-'));
	previous = process.env.ENDER_HOME;
	process.env.ENDER_HOME = home;
});

afterEach(async () => {
	if (previous === undefined) delete process.env.ENDER_HOME;
	else process.env.ENDER_HOME = previous;

	await rm(home, { recursive: true, force: true });
});

const quietly = async work => {
	const real = console.log;

	console.log = () => {};

	try {
		return await work();
	} finally {
		console.log = real;
	}
};

describe('instance names', () => {
	test('are a folder under the instances, and never a path or a flag', async () => {
		for (const name of ['--purge', '-y', '../escape', '.hidden', 'my pack', '']) {
			await expect(instances.create(name)).rejects.toThrow('cannot name an instance');
		}

		expect((await instances.create('family_1.2-b')).name).toBe('family_1.2-b');
	});

	test('a pack names one by what it is called, made into a name an instance takes', () => {
		expect(instances.instanceNameOf('My Pack!')).toBe('my-pack');
		expect(instances.instanceNameOf('../../../x')).toBe('x');
		expect(instances.instanceNameOf('--purge')).toBe('purge');
		expect(instances.instanceNameOf('   ')).toBe('pack');
	});
});

describe('deleting an instance', () => {
	test('keeps its game directory aside, worlds included, unless purged', async () => {
		const { gameDir } = await instances.create('family');

		await mkdir(join(gameDir, 'saves', 'Our World'), { recursive: true });

		const { kept } = await instances.remove('family');

		expect(kept).toStartWith(paths.kept);
		expect(await readdir(join(kept, 'saves'))).toEqual(['Our World']);
		expect(await instances.exists('family')).toBe(false);

		await instances.create('gone');

		expect((await instances.remove('gone', { purgeGameDir: true })).kept).toBeUndefined();
		expect(await readdir(paths.kept)).toHaveLength(1);

		await instances.create('family');

		expect((await instances.remove('family')).kept).not.toBe(kept);
		expect(await readdir(paths.kept)).toHaveLength(2);
	});

	test('leaves a game directory outside the instance where it is', async () => {
		const outside = join(home, 'elsewhere');

		await instances.create('shared', { gameDir: outside });

		expect((await instances.remove('shared')).kept).toBeUndefined();
		expect(await readdir(outside)).toEqual(['mods']);
	});
});

test('a clone publishes to a gist of its own, not to the one its original follows', async () => {
	await instances.create('original', { gist: 'abc' });
	await quietly(() => clone({ positionals: ['original', 'copy'], flags: {} }));

	expect((await instances.read('copy')).gist).toBeUndefined();
});

describe('what deleting kept', () => {
	const printed = async (run, args) => {
		const lines = [];
		const real = console.log;

		console.log = (...parts) => lines.push(parts.join(' '));

		try {
			await run(args);
		} finally {
			console.log = real;
		}

		return lines;
	};

	test('is listed by folder, and removed only when asked twice, or every one with --all', async () => {
		for (const name of ['one', 'two']) {
			await instances.create(name);
			await instances.remove(name);
		}

		const folders = await printed(kept.list, { flags: { names: true } });

		expect(folders).toHaveLength(2);
		expect(folders[0]).toStartWith('one-');
		expect(await quietly(() => kept.remove({ positionals: [folders[0]], flags: {} }))).toBe(1);
		expect(await kept.keptFolders()).toHaveLength(2);
		await quietly(() => kept.remove({ positionals: [folders[0]], flags: { yes: true } }));
		expect(await kept.keptFolders()).toEqual([folders[1]]);
		await expect(kept.remove({ positionals: ['nothing-such'], flags: { yes: true } })).rejects.toThrow(
			'Nothing kept as',
		);
		await quietly(() => kept.remove({ positionals: [], flags: { all: true, yes: true } }));
		expect(await kept.keptFolders()).toEqual([]);
	});
});

describe('an instance from ender 0.3', () => {
	// instance.json and its lock as 0.3 wrote them: no format, and none of the fields added since
	const made = async (name, extra = {}) => {
		const directory = join(home, 'instances', name);

		await mkdir(join(directory, 'game', 'mods'), { recursive: true });
		await writeFile(
			join(directory, 'instance.json'),
			JSON.stringify({
				name,
				type: 'client',
				minecraft: '1.21.1',
				loader: { type: 'fabric', version: '0.16.9' },
				gameDir: join(directory, 'game'),
				memory: { min: 512, max: 6144 },
				jvmArgs: [],
				env: {},
				mods: [
					{ source: 'modrinth', id: 'sodium' },
					{ source: 'github', id: 'fatlard1993/big-boats' },
				],
				...extra,
			}),
		);
		await writeFile(
			join(directory, 'instance.lock.json'),
			JSON.stringify({
				mods: [
					{
						key: 'modrinth:sodium',
						source: 'modrinth',
						id: 'sodium',
						name: 'Sodium',
						version: '0.6.0',
						filename: 'sodium.jar',
						url: 'https://cdn.modrinth.com/sodium.jar',
						checksum: { algo: 'sha1', value: 'a' },
						requested: true,
					},
				],
			}),
		);
	};

	test('is read, listed and exported as it was, and names its format once it is written again', async () => {
		await made('old');

		const manifest = await instances.read('old');

		expect(manifest).toMatchObject({ format: 1, minecraft: '1.21.1', memory: { min: 512, max: 6144 } });
		expect(manifest.mods).toHaveLength(2);
		expect((await instances.list()).map(({ name }) => name)).toEqual(['old']);
		expect((await instances.readLock('old')).mods[0].filename).toBe('sodium.jar');
		expect(packFrom(manifest).pack).toMatchObject({ format: 1, minecraft: '1.21.1', loader: 'fabric' });

		await instances.write({ ...manifest, memory: { min: 512, max: 8192 } });

		expect(await Bun.file(join(home, 'instances', 'old', 'instance.json')).json()).toMatchObject({
			format: 1,
			loader: { type: 'fabric', version: '0.16.9' },
			memory: { min: 512, max: 8192 },
		});
	});

	test('one a newer ender wrote is read as it is, and says so once', async () => {
		await made('newer', { format: 2, bowls: 'soup' });

		const warned = spyOn(console, 'warn').mockImplementation(() => {});

		try {
			expect(await instances.read('newer')).toMatchObject({ format: 2, bowls: 'soup' });
			await instances.list();
			expect(warned.mock.calls.map(([line]) => line)).toEqual([
				'!! The instance newer is instance format 2, and this ender reads format 1: ender upgrade reads it as it was meant',
			]);
		} finally {
			warned.mockRestore();
		}
	});
});

describe('an instance as a page reads it', () => {
	test('says which optional entries are on, its resource and shader packs, and the pack it follows', async () => {
		const { info_ } = await import('../src/commands/instances');

		await instances.create('packed', {
			mods: [{ source: 'modrinth', id: 'zoomify', optional: true, description: 'Zoom with C' }],
			chosen: ['modrinth:zoomify'],
			resourcepacks: [{ source: 'modrinth', id: 'faithful-32x' }],
			pack: { source: 'gh:me/pack', mods: ['modrinth:zoomify'] },
		});

		const lines = [];
		const real = console.log;

		console.log = line => lines.push(line);

		try {
			await info_({ positionals: ['packed'], flags: { json: true } });
		} finally {
			console.log = real;
		}

		expect(JSON.parse(lines.join(''))).toMatchObject({
			name: 'packed',
			mods: [{ source: 'modrinth', id: 'zoomify', optional: true, description: 'Zoom with C' }],
			installed: [],
			chosen: ['modrinth:zoomify'],
			resourcepacks: [{ source: 'modrinth', id: 'faithful-32x' }],
			shaderpacks: [],
			pack: { source: 'gh:me/pack', mods: ['modrinth:zoomify'] },
		});
	});
});

describe('settings', () => {
	test('a window size set on an instance is kept where the launch reads it, as numbers', async () => {
		const { set } = await import('../src/commands/instances');

		await instances.create('sized');
		await quietly(() => set({ positionals: ['window.width', '1280'], flags: { instance: 'sized' } }));
		await quietly(() => set({ positionals: ['window.height', '720'], flags: { instance: 'sized' } }));
		await quietly(() => set({ positionals: ['memory.max', '8192'], flags: { instance: 'sized' } }));

		const manifest = await instances.read('sized');

		expect(manifest.window).toEqual({ width: 1280, height: 720 });
		expect(manifest.memory).toEqual({ min: 512, max: 8192 });
		expect(manifest['window.width']).toBeUndefined();
		await expect(set({ positionals: ['window.width', 'wide'], flags: { instance: 'sized' } })).rejects.toThrow(
			'needs a number',
		);
	});

	test('a global switch is kept as a boolean, so "false" turns it off', async () => {
		const { config } = await import('../src/commands/settings');
		const { readConfig } = await import('../src/config');

		await quietly(() => config({ positionals: ['prerelease', 'true'] }));
		expect((await readConfig()).prerelease).toBe(true);
		await quietly(() => config({ positionals: ['prerelease', 'false'] }));
		expect((await readConfig()).prerelease).toBe(false);
		await quietly(() => config({ positionals: ['manageJava', 'false'] }));
		expect((await readConfig()).manageJava).toBe(false);
		await expect(config({ positionals: ['manageJava', 'off'] })).rejects.toThrow('true or false');
	});
});

describe('importing a pack', () => {
	const mrpack = () =>
		rawZip({
			'modrinth.index.json': JSON.stringify({
				name: 'Both Sides',
				dependencies: { minecraft: '26.3', 'fabric-loader': '0.19.5' },
				files: [
					{ path: 'mods/c.jar', downloads: ['https://e/c.jar'], env: { client: 'required', server: 'unsupported' } },
					{ path: 'mods/s.jar', downloads: ['https://e/s.jar'], env: { client: 'unsupported', server: 'required' } },
					{ path: 'mods/b.jar', downloads: ['https://e/b.jar'] },
				],
			}),
		});

	test('as a server takes the server side of it, and is a server instance; a client import takes the other', async () => {
		const { importAny } = await import('../src/commands/instances');
		const path = join(home, 'both.mrpack');

		await writeFile(path, mrpack());
		await quietly(() => importAny({ positionals: [path], flags: { server: true } }));

		const server = await instances.read('both-sides');

		expect(server.type).toBe('server');
		expect(server.mods.map(mod => mod.file).sort()).toEqual(['b.jar', 's.jar']);

		await quietly(() => importAny({ positionals: [path], flags: { name: 'client' } }));

		const client = await instances.read('client');

		expect(client.type).toBe('client');
		expect(client.mods.map(mod => mod.file).sort()).toEqual(['b.jar', 'c.jar']);
	});
});

test('export refuses a gist flag given without --gist, rather than ignoring it', async () => {
	const { exportPack } = await import('../src/commands/instances');

	await instances.create('shared');

	await expect(exportPack({ positionals: ['shared'], flags: { list: true } })).rejects.toThrow(
		'--list goes with --gist',
	);
	await expect(exportPack({ positionals: ['shared'], flags: { new: true } })).rejects.toThrow('--new goes with --gist');
});

test('deleting takes a name, and never the active instance for being in hand', async () => {
	const { remove } = await import('../src/commands/instances');
	const { updateConfig } = await import('../src/config');

	await instances.create('active');
	await updateConfig({ activeInstance: 'active' });

	await expect(remove({ positionals: [], flags: { yes: true } })).rejects.toThrow('ender delete <name>');
	expect(await instances.exists('active')).toBe(true);
	expect(await quietly(() => remove({ positionals: ['active'], flags: { yes: true } }))).toBe(0);
	expect(await instances.exists('active')).toBe(false);
});

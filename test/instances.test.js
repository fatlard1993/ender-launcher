import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { clone } from '../src/commands/instances';
import * as kept from '../src/commands/kept';
import * as instances from '../src/instance';
import { paths } from '../src/paths';

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

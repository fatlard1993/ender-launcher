import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

let home;
let previous;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), 'ender-listing-'));
	previous = process.env.ENDER_HOME;
	process.env.ENDER_HOME = home;
});

afterEach(async () => {
	if (previous === undefined) delete process.env.ENDER_HOME;
	else process.env.ENDER_HOME = previous;

	await rm(home, { recursive: true, force: true });
});

const manifest = (name, mods = []) => ({
	name,
	type: 'client',
	minecraft: '1.21.1',
	loader: { type: 'fabric', version: '0.16.0' },
	gameDir: join(home, name),
	jvmArgs: [],
	env: {},
	mods,
});

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

describe('instances as JSON, for a program to read', () => {
	test('ls --names is one name per line and nothing else, for a script to branch on', async () => {
		const instances = await import('../src/instance');
		const { ls } = await import('../src/commands/instances');

		await instances.write(manifest('beta'));
		await instances.write(manifest('alpha'));

		expect(await printed(ls, { flags: { names: true } })).toEqual(['alpha', 'beta']);
	});

	test('ls is one line holding every instance', async () => {
		const instances = await import('../src/instance');
		const { ls } = await import('../src/commands/instances');

		await instances.write(manifest('a'));
		await instances.write(manifest('b'));

		const lines = await printed(ls, { flags: { json: true } });

		expect(lines).toHaveLength(1);
		expect(
			JSON.parse(lines[0])
				.map(found => found.name)
				.sort(),
		).toEqual(['a', 'b']);
		expect(JSON.parse(lines[0])[0]).toMatchObject({ minecraft: '1.21.1', loader: { type: 'fabric' } });
	});

	test('ls with none is an empty list, not the guidance', async () => {
		const { ls } = await import('../src/commands/instances');

		expect(await printed(ls, { flags: { json: true } })).toEqual(['[]']);
	});

	test('info holds the mods asked for, as their specs read back', async () => {
		const instances = await import('../src/instance');
		const { info_ } = await import('../src/commands/instances');

		await instances.write(manifest('a', [{ source: 'github', id: 'owner/repo' }]));

		const [line] = await printed(info_, { positionals: ['a'], flags: { json: true } });
		const shown = JSON.parse(line);

		expect(shown.mods).toEqual([{ source: 'github', id: 'owner/repo' }]);
		expect(shown.installed).toEqual([]);
	});
});

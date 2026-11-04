import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { commands } from '../src/cli/commands';
import { run } from '../src/cli/index';
import { NO_INSTANCES, targetName } from '../src/commands/context';
import { commandHelp, usage } from '../src/cli/help';

const rendered = (name, command) => {
	const lines = [];
	const real = console.log;

	console.log = (...args) => lines.push(args.join(' '));

	try {
		commandHelp(name, command);
	} finally {
		console.log = real;
	}

	return lines;
};

const defaultOnBooleans = Object.entries(commands).flatMap(([name, command]) =>
	Object.entries(command.flags ?? {})
		.filter(([, spec]) => spec.type === 'boolean' && spec.default === true)
		.map(([flag, spec]) => ({ command: name, flag, spec })),
);

describe('flag help', () => {
	// Help renders a boolean that defaults on as its negation, so the sentence beside it has
	// to describe the negation too. It used to print the positive one, which made every such
	// row say the opposite of what typing it does.
	test('every default-on boolean carries the description of its negation', () => {
		expect(defaultOnBooleans.length).toBeGreaterThan(0);

		for (const { command, flag, spec } of defaultOnBooleans) {
			expect(spec.off, `${command} --no-${flag} has no "off" description`).toBeTruthy();
		}
	});

	// The invariant the renderer actually has to keep, asserted against its output rather than
	// its inputs: no --no- row may print the sentence describing the positive action.
	test('no --no- row prints its positive description', () => {
		for (const [name, command] of Object.entries(commands)) {
			for (const line of rendered(name, command)) {
				const negated = line.match(/--no-(\S+)/);

				if (!negated) continue;

				const spec = Object.entries(command.flags ?? {}).find(
					([flag]) => flag.replaceAll(/[A-Z]/g, letter => `-${letter.toLowerCase()}`) === negated[1],
				)?.[1];

				if (spec?.description === undefined || spec.off === undefined) continue;

				expect(line, `${name} --no-${negated[1]} printed its positive description`).not.toContain(spec.description);
				expect(line).toContain(spec.off);
			}
		}
	});
});

test('ender --help lists every command, so none is found only by reading the source', () => {
	const lines = [];
	const real = console.log;

	console.log = (...parts) => lines.push(parts.join(' '));

	try {
		usage();
	} finally {
		console.log = real;
	}

	const listed = new Set(lines.map(line => line.trim().split(/\s+/)[0]));

	expect(Object.keys(commands).filter(name => !listed.has(name))).toEqual([]);
});

describe('a first run, with no instance yet', () => {
	let home;
	let previous;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), 'ender-first-run-'));
		previous = process.env.ENDER_HOME;
		process.env.ENDER_HOME = home;
	});

	afterEach(async () => {
		if (previous === undefined) delete process.env.ENDER_HOME;
		else process.env.ENDER_HOME = previous;

		await rm(home, { recursive: true, force: true });
	});

	test('bare ender says only where to start, and asking is not a failure', async () => {
		const lines = [];
		const real = console.log;

		console.log = (...parts) => lines.push(parts.join(' '));

		try {
			expect(await run([])).toBe(0);
		} finally {
			console.log = real;
		}

		expect(lines[0]).toContain('Start here');
		expect(lines.some(line => line.includes('ender new survival'))).toBe(true);
		expect(lines.some(line => line.includes('ender help'))).toBe(true);
		expect(lines.some(line => line.includes('Instances'))).toBe(false);
	});

	test('ender help still lists every command with no instance yet', async () => {
		const lines = [];
		const real = console.log;

		console.log = (...parts) => lines.push(parts.join(' '));

		try {
			expect(await run(['help'])).toBe(0);
		} finally {
			console.log = real;
		}

		expect(lines.some(line => line.includes('Instances'))).toBe(true);
	});

	test('listing and launching with no instance say the same thing', async () => {
		const { ls } = await import('../src/commands/instances');
		const lines = [];
		const real = console.log;

		console.log = (...parts) => lines.push(parts.join(' '));

		try {
			await ls({ positionals: [], flags: {} });
		} finally {
			console.log = real;
		}

		expect(lines).toEqual([NO_INSTANCES]);
		await expect(targetName(undefined, {})).rejects.toThrow(NO_INSTANCES);
	});
});

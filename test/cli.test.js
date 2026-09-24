import { describe, expect, test } from 'bun:test';

import { commands } from '../src/cli/commands';
import { commandHelp } from '../src/cli/help';

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

				expect(line, `${name} --no-${negated[1]} printed its positive description`).not.toContain(
					spec.description,
				);
				expect(line).toContain(spec.off);
			}
		}
	});
});

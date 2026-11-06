/**
 * A command line is a command, some positionals, some flags, and anything after `--`.
 *
 * Flags are declared per command so an unknown one is an error the user hears about immediately
 * rather than a typo that silently does nothing.
 */
export const parseArgv = (argv, flagSpec = {}) => {
	const aliases = Object.fromEntries(
		Object.entries(flagSpec).flatMap(([name, spec]) =>
			[spec.alias]
				.flat()
				.filter(Boolean)
				.map(alias => [alias, name]),
		),
	);

	const positionals = [];
	const flags = {};
	const rest = [];
	let index = 0;

	// Flags are declared in camelCase but typed in kebab-case, so both spellings resolve.
	const camel = text => text.replaceAll(/-([a-z])/g, (whole, letter) => letter.toUpperCase());

	const nameOf = token => {
		const bare = token.replace(/^--?/, '');

		if (flagSpec[bare]) return bare;
		if (aliases[bare]) return aliases[bare];

		return flagSpec[camel(bare)] ? camel(bare) : undefined;
	};

	const typed = (name, token, value) => {
		if (flagSpec[name].type !== 'number') return value;

		const number = Number(value);

		if (value.trim() === '' || !Number.isFinite(number)) throw new Error(`${token} wants a number, not "${value}"`);

		return number;
	};

	const assign = (name, token) => {
		const spec = flagSpec[name];

		if (spec === undefined) throw new Error(`Unknown flag "${token}"`);

		if (spec.type === 'boolean') {
			flags[name] = true;

			return;
		}

		const value = argv[++index];

		if (value === undefined) throw new Error(`${token} needs a value`);

		flags[name] = typed(name, token, value);
	};

	for (; index < argv.length; ++index) {
		const token = argv[index];

		if (token === '--') {
			rest.push(...argv.slice(index + 1));

			break;
		}

		if (token.startsWith('--no-')) {
			const name = nameOf(token.slice(5)) ?? camel(token.slice(5));

			if (flagSpec[name]?.type !== 'boolean') throw new Error(`Unknown flag "${token}"`);

			flags[name] = false;

			continue;
		}

		if (token.startsWith('--')) {
			const equals = token.indexOf('=');
			const head = equals === -1 ? token : token.slice(0, equals);
			const name = nameOf(head);

			if (name === undefined) throw new Error(`Unknown flag "${head}"`);

			if (equals === -1) assign(name, head);
			else if (flagSpec[name].type === 'boolean') throw new Error(`${head} takes no value`);
			else flags[name] = typed(name, head, token.slice(equals + 1));

			continue;
		}

		// A short group is every boolean in it, with a value-taking flag allowed only in last place.
		if (token.startsWith('-') && token.length > 1) {
			const letters = [...token.slice(1)];

			for (const [position, letter] of letters.entries()) {
				const name = aliases[letter] ?? (flagSpec[letter] ? letter : undefined);

				if (name === undefined) throw new Error(`Unknown flag "-${letter}"`);
				if (flagSpec[name].type !== 'boolean' && position !== letters.length - 1) {
					throw new Error(`-${letter} needs a value, so it cannot sit inside "${token}"`);
				}

				assign(name, `-${letter}`);
			}

			continue;
		}

		positionals.push(token);
	}

	for (const [name, spec] of Object.entries(flagSpec)) {
		if (!(name in flags) && spec.default !== undefined) flags[name] = spec.default;
	}

	return { positionals, flags, rest };
};

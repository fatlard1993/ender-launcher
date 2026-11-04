import { readJson, writeJson } from '../json';
import { warn } from '../out';
import { paths } from '../paths';
import { NAME, ensureOffline } from './accounts';

/** The name a launch with no account plays as. */
export const DEFAULT_PLAYER = 'Player';

/**
 * A name stored as a bare username, globally or on one instance, becomes the offline account of that name: the same
 * player, since an offline uuid follows from the name alone. `who` says whose name it was, for the line that says so.
 */
export const adoptName = async (name, { activate, who }) => {
	if (name === DEFAULT_PLAYER) return false;

	if (!NAME.test(name)) {
		warn(
			`${who} played as "${name}", which Minecraft does not accept as a name; it plays as ${DEFAULT_PLAYER} until "ender account add --offline <name>"`,
		);

		return false;
	}

	await ensureOffline(name, { activate });
	warn(`${who} played as ${name}, which is now the offline account ${name}; "ender account" lists it`);

	return true;
};

/** A config holding a username from before accounts held who plays has it moved into one, and dropped from config. */
export const adoptConfiguredName = async () => {
	const { username, ...rest } = await readJson(paths.config, {});

	if (username === undefined) return;

	await adoptName(username, { activate: true, who: 'Instances with no account' });
	await writeJson(paths.config, rest);
};

import { offlineProfile } from './offline';
import { asProfile, resolveAccount } from './accounts';
import { DEFAULT_PLAYER } from './adopt';

export { offlineProfile, offlineUuid } from './offline';
export * as accounts from './accounts';

/**
 * Who an instance plays as.
 *
 * A named account wins, then whichever account is active, and failing both the offline identity
 * of the default name. Offline is not a fallback for a broken sign in: a token that cannot be
 * renewed is an error worth hearing, not a silent downgrade into a game that cannot join anything.
 */
export const profileFor = async ({ account, username } = {}) => {
	const resolved = await resolveAccount(account);

	if (resolved !== undefined) return asProfile(resolved);

	return { ...offlineProfile(username ?? DEFAULT_PLAYER), online: false };
};

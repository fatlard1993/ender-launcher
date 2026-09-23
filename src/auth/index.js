import { offlineProfile } from './offline';
import { asProfile, resolveAccount } from './accounts';

export { offlineProfile, offlineUuid } from './offline';
export * as accounts from './accounts';

/**
 * Who an instance plays as.
 *
 * A named account wins, then whichever account is active, and failing both the offline identity
 * derived from a name. Offline is not a fallback for a broken sign in: a token that cannot be
 * renewed is an error worth hearing, not a silent downgrade into a game that cannot join anything.
 */
export const profileFor = async ({ account, username } = {}) => {
	const resolved = await resolveAccount(account);

	if (resolved !== undefined) return { ...asProfile(resolved), online: true };

	return { ...offlineProfile(username ?? 'Player'), online: false };
};

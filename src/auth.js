/**
 * The identity an offline launch runs under.
 *
 * Vanilla derives an offline player's UUID from their name as a version 3 (MD5) UUID over
 * `OfflinePlayer:<name>`, so worlds and inventories follow the name rather than an account.
 * Matching that derivation is what lets an offline instance pick up a save an online one left.
 */
export const offlineUuid = name => {
	const bytes = new Bun.CryptoHasher('md5').update(`OfflinePlayer:${name}`).digest();

	bytes[6] = (bytes[6] & 0x0f) | 0x30;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;

	const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const offlineProfile = name => ({
	name,
	uuid: offlineUuid(name),
	accessToken: '0',
	userType: 'legacy',
	xuid: '0',
	clientId: '0',
});

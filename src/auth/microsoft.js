import { fetchWithRetry } from '../download';
import { detail, info, paint, step } from '../out';

const DEVICE_CODE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';

const TOKEN = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';

const XBOX_USER = 'https://user.auth.xboxlive.com/user/authenticate';

const XSTS = 'https://xsts.auth.xboxlive.com/xsts/authorize';

const MINECRAFT_LOGIN = 'https://api.minecraftservices.com/authentication/login_with_xbox';

const PROFILE = 'https://api.minecraftservices.com/minecraft/profile';

const SCOPE = 'XboxLive.signin offline_access';

const form = body => ({
	method: 'POST',
	headers: { 'content-type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams(body).toString(),
});

const json = body => ({
	method: 'POST',
	headers: { 'content-type': 'application/json', accept: 'application/json' },
	body: JSON.stringify(body),
});

/**
 * Minecraft refuses a token from an app registration it does not know, which is the state every
 * new registration starts in. The failure is a bare 403, so it is named here rather than left to
 * read as a network problem.
 */
class NotApprovedError extends Error {
	constructor(clientId) {
		super(
			[
				'Minecraft refused this app registration.',
				`  Azure app: ${clientId}`,
				'  A new registration cannot use the Minecraft API until it is reviewed.',
				'  Apply at https://aka.ms/mce-reviewappid, then try again.',
				'  Until then, instances launch offline.',
			].join('\n'),
		);
	}
}

/** Ask Microsoft for a code the user types into their browser, then wait for them to do it. */
export const signIn = async ({ clientId, onPrompt } = {}) => {
	if (!clientId) {
		throw new Error('No Azure client id configured. Set one with "ender config clientId <id>".');
	}

	const start = await (await fetchWithRetry(DEVICE_CODE, form({ client_id: clientId, scope: SCOPE }))).json();

	(onPrompt ?? defaultPrompt)(start);

	const deadline = Date.now() + start.expires_in * 1000;
	let interval = (start.interval ?? 5) * 1000;

	while (Date.now() < deadline) {
		await Bun.sleep(interval);

		const response = await fetch(
			TOKEN,
			form({
				client_id: clientId,
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
				device_code: start.device_code,
			}),
		);
		const body = await response.json();

		if (response.ok) return { refreshToken: body.refresh_token, accessToken: body.access_token, clientId };

		// Still waiting on the person is not a failure; being told to slow down is a instruction.
		if (body.error === 'authorization_pending') continue;
		if (body.error === 'slow_down') {
			interval += 5000;

			continue;
		}

		if (body.error === 'authorization_declined') throw new Error('Sign in was declined.');
		if (body.error === 'expired_token') break;

		throw new Error(`${body.error}: ${body.error_description?.split('\n')[0] ?? ''}`);
	}

	throw new Error('The sign in code expired before it was used.');
};

const defaultPrompt = start => {
	step('Sign in to Microsoft');
	info('');
	info(`  Open ${paint.cyan(start.verification_uri)}`);
	info(`  Enter the code ${paint.bold(start.user_code)}`);
	info('');
	info(paint.dim('  Waiting for you to finish, this window can stay open.'));
};

export const refresh = async ({ refreshToken, clientId }) => {
	const response = await fetch(
		TOKEN,
		form({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPE }),
	);
	const body = await response.json();

	if (!response.ok) {
		throw new Error(`Could not refresh the sign in (${body.error ?? response.status}). Sign in again.`);
	}

	// Microsoft rotates the refresh token, so the new one has to replace the old.
	return { refreshToken: body.refresh_token ?? refreshToken, accessToken: body.access_token, clientId };
};

/**
 * Microsoft to Minecraft is four exchanges, not one: the Microsoft token buys an Xbox Live token,
 * which buys an XSTS token, which buys a Minecraft token, which finally identifies a player.
 */
export const toMinecraft = async (accessToken, clientId) => {
	const xbox = await (
		await fetchWithRetry(
			XBOX_USER,
			json({
				Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${accessToken}` },
				RelyingParty: 'http://auth.xboxlive.com',
				TokenType: 'JWT',
			}),
		)
	).json();

	const xstsResponse = await fetch(
		XSTS,
		json({
			Properties: { SandboxId: 'RETAIL', UserTokens: [xbox.Token] },
			RelyingParty: 'rp://api.minecraftservices.com/',
			TokenType: 'JWT',
		}),
	);

	if (!xstsResponse.ok) {
		const reason = await xstsResponse.json().catch(() => ({}));

		// Xbox states its refusals as numbered cases; the common two are worth naming.
		if (reason.XErr === 2_148_916_233) throw new Error('That Microsoft account has no Xbox profile.');
		if (reason.XErr === 2_148_916_238) throw new Error('That account is a child and needs to be added to a family.');

		throw new Error(`Xbox refused the sign in (${reason.XErr ?? xstsResponse.status}).`);
	}

	const xsts = await xstsResponse.json();
	const userHash = xsts.DisplayClaims.xui[0].uhs;

	const loginResponse = await fetch(MINECRAFT_LOGIN, json({ identityToken: `XBL3.0 x=${userHash};${xsts.Token}` }));

	if (loginResponse.status === 403) throw new NotApprovedError(clientId);
	if (!loginResponse.ok) throw new Error(`Minecraft refused the sign in (${loginResponse.status}).`);

	const minecraft = await loginResponse.json();

	detail('auth', 'minecraft token acquired');

	return { token: minecraft.access_token, expiresAt: Date.now() + minecraft.expires_in * 1000 };
};

export const fetchProfile = async token => {
	const response = await fetch(PROFILE, { headers: { authorization: `Bearer ${token}` } });

	if (response.status === 404) {
		throw new Error('That account does not own Minecraft Java Edition.');
	}

	if (!response.ok) throw new Error(`Could not read the Minecraft profile (${response.status}).`);

	const profile = await response.json();

	return { id: profile.id, name: profile.name };
};

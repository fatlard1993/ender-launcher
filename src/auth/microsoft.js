// Called on the module rather than destructured: generate() reads its error correction level
// off `this`, and a loose reference to it throws.
import qrcode from 'qrcode-terminal';

import { fetchWithRetry } from '../download';
import { detail, info, paint, step } from '../out';

const DEVICE_CODE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';

const TOKEN = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';

const XBOX_USER = 'https://user.auth.xboxlive.com/user/authenticate';

const XSTS = 'https://xsts.auth.xboxlive.com/xsts/authorize';

const MINECRAFT_LOGIN = 'https://api.minecraftservices.com/authentication/login_with_xbox';

const PROFILE = 'https://api.minecraftservices.com/minecraft/profile';

const SCOPE = 'XboxLive.signin offline_access';

/** What Prism asks for. A refresh token renews only for the scopes it was granted, so one taken from Prism keeps these. */
export const PRISM_SCOPE = 'XboxLive.SignIn XboxLive.offline_access';

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

/** ender's own Azure app registration, approved by Mojang for Minecraft sign in. */
export const CLIENT_ID = '9e6c7319-cc03-4540-822c-1ed114a056bc';

/**
 * Minecraft refuses a token from an app registration it has not approved with a bare 403, so it is named here rather
 * than left to read as a network problem.
 */
class NotApprovedError extends Error {
	constructor(clientId) {
		super(
			[
				'Minecraft refused this sign in: its Azure app is not approved for Minecraft.',
				`  Azure app: ${clientId}`,
				'  Instances still launch offline.',
			].join('\n'),
		);
	}
}

/**
 * The lines a script or the page reads the sign in from: Microsoft's page as it gave it, and the code to type there.
 * Microsoft's link page takes a code as `otc` too, but a code handed over that way is refused for an app not its own,
 * and Mojang's approval of the app for the Minecraft API does not lift that refusal: the two are separate gates.
 */
export const signInLines = ({ verification_uri: uri, user_code: code }) => [`link ${uri}`, `code ${code}`];

/** Ask Microsoft for a code the user types into their browser, then wait for them to do it. */
export const signIn = async ({ clientId = CLIENT_ID, onPrompt, qr = true } = {}) => {
	const start = await (await fetchWithRetry(DEVICE_CODE, form({ client_id: clientId, scope: SCOPE }))).json();

	(onPrompt ?? printSignIn)(start, { qr });

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

		// Still waiting on the person is not a failure; being told to slow down is an instruction.
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

/** What a person signing in reads, ending in the link and code lines the page reads. */
export const printSignIn = (start, { qr = true } = {}) => {
	step('Sign in to Microsoft');
	info('');

	if (qr) {
		// Rendered before the code, so a phone can be pointed at it without reading anything first.
		qrcode.generate(start.verification_uri, { small: true }, rendered => info(rendered));
	}

	info(`  ${qr ? 'Scan the code above, or open' : 'Open'} ${paint.cyan(start.verification_uri)}`);
	info(`  and enter ${paint.bold(start.user_code)}`);

	for (const line of signInLines(start)) info(paint.dim(`  ${line}`));
	info('');
	info(paint.dim('  Waiting for you to finish. Leave this running: the account is only saved'));
	info(paint.dim('  once the browser is done and three more exchanges have completed.'));
};

export const refresh = async ({ refreshToken, clientId, scope = SCOPE }) => {
	const response = await fetch(
		TOKEN,
		form({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken, scope }),
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

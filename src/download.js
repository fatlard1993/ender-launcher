import { copyFile, link, mkdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { version } from '../package.json';
import { detail } from './out';

export const userAgent = `minecraft-manager/${version} (github.com/fatlard1993/minecraft-manager)`;

const digestOf = async (path, algorithm) => {
	const hasher = new Bun.CryptoHasher(algorithm);

	hasher.update(await Bun.file(path).arrayBuffer());

	return hasher.digest('hex');
};

export const sha1 = async path => digestOf(path, 'sha1');

export const checksumText = checksum => (checksum ? `${checksum.algorithm}:${checksum.value}` : undefined);

/** `sha1:abc` / `sha256:abc`, or a bare value taken as sha1. */
export const checksumOf = (value, algorithm = 'sha1') => {
	if (!value) return undefined;

	const [head, tail] = String(value).split(':');

	return tail ? { algorithm: head, value: tail.toLowerCase() } : { algorithm, value: head.toLowerCase() };
};

/**
 * Asset objects and their donors are stored under their own checksum, so for those the name is the
 * hash and a size check settles it. Re-reading a gigabyte of content-addressed files on every
 * launch buys nothing.
 */
const isContentAddressed = (path, checksum) => checksum !== undefined && basename(path) === checksum.value;

const isIntact = async (path, checksum, size) => {
	const file = Bun.file(path);

	if (!(await file.exists())) return false;
	if (size !== undefined && file.size !== size) return false;
	if (checksum === undefined || isContentAddressed(path, checksum)) return true;

	return (await digestOf(path, checksum.algorithm)) === checksum.value;
};

class HttpError extends Error {
	constructor(response, url) {
		super(`${response.status} ${response.statusText} :: ${url}`);

		this.status = response.status;
	}
}

export const fetchWithRetry = async (url, options = {}, attempts = 3) => {
	let lastError;

	for (let attempt = 1; attempt <= attempts; ++attempt) {
		try {
			const response = await fetch(url, {
				...options,
				headers: { 'user-agent': userAgent, ...options.headers },
			});

			if (response.ok) return response;

			const failure = new HttpError(response, url);

			// Anything the server answers definitively will answer the same way next time.
			if (response.status !== 429 && response.status < 500) throw failure;

			lastError = failure;
		} catch (error) {
			// Retryability is a property of the status, not of how the message happens to read.
			if (error instanceof HttpError) throw error;

			lastError = error;
		}

		if (attempt < attempts) await Bun.sleep(250 * 2 ** attempt);
	}

	throw lastError;
};

export const fetchJson = async (url, options) => (await fetchWithRetry(url, options)).json();

/**
 * Adopt an identical file from another launcher's cache instead of fetching it.
 * Hardlinks so the bytes are shared, copying only when the two are on different filesystems.
 */
const adoptDonor = async (path, donors, checksum, size) => {
	for (const donor of donors) {
		if (!(await isIntact(donor, checksum, size))) continue;

		try {
			await link(donor, path);
		} catch (error) {
			if (error.code === 'EEXIST') return false;
			if (error.code !== 'EXDEV') throw error;

			await copyFile(donor, path);
		}

		detail('adopted', donor);

		return true;
	}

	return false;
};

// The pid keeps two mcm processes apart; this keeps two tasks in one pool apart.
let scratchSequence = 0;

/**
 * Put a file at `path`, checked against whatever the source was willing to state about it, or
 * leave the intact one already there alone. Resolves true when bytes were actually fetched.
 */
export const ensureFile = async ({ url, path, checksum, size, donors = [] }) => {
	if (await isIntact(path, checksum, size)) return false;

	await mkdir(dirname(path), { recursive: true });

	if (donors.length > 0 && (await adoptDonor(path, donors, checksum, size))) return false;

	const temporary = `${path}.${process.pid}.${++scratchSequence}.part`;
	const response = await fetchWithRetry(url);

	// A source that publishes no checksum still publishes a length, either in the metadata or in
	// the response itself. Without one of them a body cannot be told apart from an error page.
	const declared = size ?? (Number(response.headers.get('content-length')) || undefined);

	// Stream to disk while hashing the same bytes: a large body handed to Bun.write whole stalls,
	// and hashing on the way past saves reading the file back again.
	const writer = Bun.file(temporary).writer();
	const hasher = checksum && new Bun.CryptoHasher(checksum.algorithm);
	let written = 0;

	try {
		for await (const chunk of response.body) {
			hasher?.update(chunk);
			writer.write(chunk);

			written += chunk.byteLength;
		}

		await writer.end();
	} catch (error) {
		await writer.end().catch(() => {});
		await unlink(temporary).catch(() => {});

		throw error;
	}

	const reject = async reason => {
		await unlink(temporary).catch(() => {});

		throw new Error(`${reason} :: ${url}`);
	};

	if (checksum) {
		if (hasher.digest('hex') !== checksum.value) await reject('Checksum mismatch');
	} else if (declared !== undefined) {
		if (written !== declared) await reject(`Expected ${declared} bytes, got ${written}`);
	} else {
		detail('unverified', `${path} (source published neither checksum nor length)`);
	}

	await rename(temporary, path);

	detail('fetched', path);

	return true;
};

/** Run tasks with a ceiling on how many are in flight, reporting each completion. */
export const pool = async (items, worker, { concurrency = 8, onProgress } = {}) => {
	const results = Array.from({ length: items.length });
	const errors = [];
	let next = 0;
	let finished = 0;

	const run = async () => {
		while (next < items.length) {
			const index = next++;

			try {
				results[index] = await worker(items[index], index);
			} catch (error) {
				errors.push(error);
			}

			onProgress?.(++finished, items.length);
		}
	};

	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));

	// The caller may need to know what did land, so the successes ride along with the failure.
	if (errors.length > 0) {
		const failure = new AggregateError(errors, `${errors.length} of ${items.length} downloads failed`);

		failure.results = results;

		throw failure;
	}

	return results;
};

import { copyFile, link, mkdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { detail } from './out';

export const userAgent = 'minecraft-manager/0.1.0 (github.com/fatlard1993/minecraft-manager)';

export const sha1 = async path => digestOf(path, 'sha1');

const digestOf = async (path, algorithm) => {
	const hasher = new Bun.CryptoHasher(algorithm);

	hasher.update(await Bun.file(path).arrayBuffer());

	return hasher.digest('hex');
};

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

export const fetchWithRetry = async (url, options = {}, attempts = 3) => {
	let lastError;

	for (let attempt = 1; attempt <= attempts; ++attempt) {
		try {
			const response = await fetch(url, {
				...options,
				headers: { 'user-agent': userAgent, ...options.headers },
			});

			if (response.ok) return response;

			// A missing or forbidden resource will not become present by asking again.
			if (response.status < 500 && response.status !== 429) {
				throw new Error(`${response.status} ${response.statusText} :: ${url}`);
			}

			lastError = new Error(`${response.status} ${response.statusText} :: ${url}`);
		} catch (error) {
			if (error.message?.startsWith('4')) throw error;

			lastError = error;
		}

		if (attempt < attempts) await Bun.sleep(250 * 2 ** attempt);
	}

	throw lastError;
};

export const fetchJson = async (url, options) => (await fetchWithRetry(url, options)).json();

/**
 * Adopt an identical file from another launcher's cache instead of fetching it.
 * Hardlinks so the bytes are shared, copying only when the donor is on another filesystem.
 */
const adoptDonor = async (path, donors, checksum, size) => {
	for (const donor of donors) {
		if (!(await isIntact(donor, checksum, size))) continue;

		try {
			await link(donor, path);
		} catch (error) {
			if (error.code === 'EEXIST') return false;

			await copyFile(donor, path);
		}

		detail('adopted', donor);

		return true;
	}

	return false;
};

/**
 * Put a verified file at `path`, or leave the intact one already there alone.
 * Resolves true when bytes were actually fetched over the network.
 */
export const ensureFile = async ({ url, path, checksum, size, donors = [] }) => {
	if (await isIntact(path, checksum, size)) return false;

	await mkdir(dirname(path), { recursive: true });

	if (donors.length > 0 && (await adoptDonor(path, donors, checksum, size))) return false;

	const temporary = `${path}.${process.pid}.part`;
	const response = await fetchWithRetry(url);

	// Stream to disk while hashing the same bytes: a large body handed to Bun.write whole stalls,
	// and hashing on the way past saves reading the file back again.
	const writer = Bun.file(temporary).writer();
	const hasher = new Bun.CryptoHasher(checksum?.algorithm ?? 'sha1');

	try {
		for await (const chunk of response.body) {
			hasher.update(chunk);
			writer.write(chunk);
		}

		await writer.end();
	} catch (error) {
		await writer.end().catch(() => {});
		await unlink(temporary).catch(() => {});

		throw error;
	}

	if (checksum !== undefined && hasher.digest('hex') !== checksum.value) {
		await unlink(temporary);

		throw new Error(`Checksum mismatch :: ${url}`);
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

	if (errors.length > 0) {
		throw new AggregateError(errors, `${errors.length} of ${items.length} downloads failed`);
	}

	return results;
};

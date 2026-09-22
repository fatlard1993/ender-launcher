import { inflateRawSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

const END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50;

const CENTRAL_ENTRY = 0x02_01_4b_50;

const STORED = 0;

const DEFLATED = 8;

/**
 * Enough of the zip format to read the archives this tool meets: the central directory, then
 * stored and deflated entries. Natives jars before 1.19, and modpacks in every shape, are all
 * zips, and Bun has no archive reader of its own.
 */
const centralDirectory = buffer => {
	// The end record sits at the tail, behind a comment of unknown length.
	let end = buffer.length - 22;

	while (end >= 0 && buffer.readUInt32LE(end) !== END_OF_CENTRAL_DIRECTORY) --end;

	if (end < 0) throw new Error('Not a zip archive (no end-of-central-directory record)');

	const count = buffer.readUInt16LE(end + 10);
	const entries = [];
	let offset = buffer.readUInt32LE(end + 16);

	for (let index = 0; index < count; ++index) {
		if (buffer.readUInt32LE(offset) !== CENTRAL_ENTRY) throw new Error('Corrupt zip central directory');

		const method = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

		entries.push({ name, method, compressedSize, localOffset });

		offset += 46 + nameLength + extraLength + commentLength;
	}

	return entries;
};

const contentOf = (buffer, entry) => {
	// The local header repeats the name and extra fields, at its own lengths.
	const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
	const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
	const start = entry.localOffset + 30 + nameLength + extraLength;
	const raw = buffer.subarray(start, start + entry.compressedSize);

	if (entry.method === STORED) return raw;
	if (entry.method === DEFLATED) return inflateRawSync(raw);

	throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}`);
};

const excluded = (name, rules) => rules.some(rule => name.startsWith(rule));

const openArchive = async path => {
	const buffer = Buffer.from(await Bun.file(path).arrayBuffer());

	return { buffer, entries: centralDirectory(buffer) };
};

/** Every file path inside the archive, directories omitted. */
export const listEntries = async path => {
	const { entries } = await openArchive(path);

	return entries.filter(entry => !entry.name.endsWith('/')).map(entry => entry.name);
};

/** One entry's bytes, or undefined when the archive has no such entry. */
export const readEntry = async (path, name) => {
	const { buffer, entries } = await openArchive(path);
	const entry = entries.find(candidate => candidate.name === name);

	return entry && contentOf(buffer, entry);
};

export const readEntryJson = async (path, name) => {
	const bytes = await readEntry(path, name);

	return bytes && JSON.parse(bytes.toString('utf8'));
};

/**
 * Unpack an archive into a directory, dropping entries the caller excludes and stripping a leading
 * path when one is given. Entry names come from a downloaded archive, so each one is checked to
 * land inside the target.
 */
export const extractArchive = async (archivePath, targetDirectory, { exclude = [], prefix } = {}) => {
	const { buffer, entries } = await openArchive(archivePath);
	const written = [];

	for (const entry of entries) {
		if (entry.name.endsWith('/') || excluded(entry.name, exclude)) continue;
		if (prefix !== undefined && !entry.name.startsWith(prefix)) continue;

		const relative = prefix === undefined ? entry.name : entry.name.slice(prefix.length);

		if (relative === '') continue;

		const destination = join(targetDirectory, normalize(relative));

		if (!destination.startsWith(`${targetDirectory}/`)) {
			throw new Error(`Archive entry escapes its directory: ${entry.name}`);
		}

		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, contentOf(buffer, entry));

		written.push(relative);
	}

	return written;
};

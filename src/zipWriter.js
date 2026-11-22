/**
 * Enough of the zip format to write the archives this tool makes: each file deflated, or stored when deflating does
 * not make it smaller, under a local header, then the central directory. Names are UTF-8, and no file is past four gigabytes.
 */
const DEFLATED = 8;
const STORED = 0;
const UTF8 = 0x0800;

const u2 = value => {
	const bytes = new Uint8Array(2);

	new DataView(bytes.buffer).setUint16(0, value, true);

	return bytes;
};

const u4 = value => {
	const bytes = new Uint8Array(4);

	new DataView(bytes.buffer).setUint32(0, value >>> 0, true);

	return bytes;
};

/** A DOS date and time, as zip keeps when a file was written. */
const dosTime = date => [
	u2((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)),
	u2(((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()),
];

/** A zip of these files, each { name, bytes }, as one array of bytes. */
export const writeZip = (files, { now = new Date() } = {}) => {
	const parts = [];
	const central = [];
	let offset = 0;
	const [time, day] = dosTime(now);

	for (const { name, bytes } of files) {
		const encodedName = new TextEncoder().encode(name);
		const deflated = Bun.deflateSync(bytes);
		const method = deflated.length < bytes.length ? DEFLATED : STORED;
		const body = method === DEFLATED ? deflated : bytes;
		const checksum = Bun.hash.crc32(bytes);
		const shared = [u2(20), u2(UTF8), u2(method), time, day, u4(checksum), u4(body.length), u4(bytes.length)];
		const local = [u4(0x04034b50), ...shared, u2(encodedName.length), u2(0), encodedName];

		central.push([
			u4(0x02014b50),
			u2(20),
			...shared,
			u2(encodedName.length),
			u2(0),
			u2(0),
			u2(0),
			u2(0),
			u4(0),
			u4(offset),
			encodedName,
		]);
		parts.push(...local, body);
		offset += local.reduce((sum, part) => sum + part.length, 0) + body.length;
	}

	const directory = central.flat();
	const size = directory.reduce((sum, part) => sum + part.length, 0);
	const end = [u4(0x06054b50), u2(0), u2(0), u2(files.length), u2(files.length), u4(size), u4(offset), u2(0)];
	const all = [...parts, ...directory, ...end];
	const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
	let at = 0;

	for (const part of all) {
		out.set(part, at);
		at += part.length;
	}

	return out;
};

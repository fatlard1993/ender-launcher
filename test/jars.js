import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const u2 = value => Buffer.from([value >> 8, value & 0xff]);

/** The smallest class file the reader accepts: a constant pool, then empty everything else. */
export const classFile = ({ name, superName = 'java/lang/Object', members = [], strings = [], long = false }) => {
	const pool = [];
	const add = (bytes, slots = 1) => {
		const index = pool.reduce((sum, entry) => sum + entry.slots, 1);

		pool.push({ bytes, slots });

		return index;
	};
	const utf8 = text => {
		const bytes = Buffer.from(text);

		return add(Buffer.concat([Buffer.from([1]), u2(bytes.length), bytes]));
	};
	const classRef = className => add(Buffer.concat([Buffer.from([7]), u2(utf8(className))]));

	if (long) add(Buffer.from([5, 0, 0, 0, 0, 0, 0, 0, 42]), 2);

	const self = classRef(name);
	const parent = classRef(superName);

	for (const member of members) {
		const [owner, memberName] = member.split('.');
		const nameAndType = add(Buffer.concat([Buffer.from([12]), u2(utf8(memberName)), u2(utf8('()V'))]));

		add(Buffer.concat([Buffer.from([10]), u2(classRef(owner)), u2(nameAndType)]));
	}

	for (const string of strings) add(Buffer.concat([Buffer.from([8]), u2(utf8(string))]));

	const count = pool.reduce((sum, entry) => sum + entry.slots, 1);

	return Buffer.concat([
		Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 65]),
		u2(count),
		...pool.map(entry => entry.bytes),
		u2(0x21),
		u2(self),
		u2(parent),
		u2(0),
		u2(0),
		u2(0),
		u2(0),
	]);
};

let counter = 0;

/** A jar from a map of entry name to bytes, zipped by the system zip as the pack tests do. */
export const jar = async (directory, files) => {
	const staging = join(directory, `jar-${++counter}`);

	for (const [name, bytes] of Object.entries(files)) {
		await mkdir(dirname(join(staging, name)), { recursive: true });

		await writeFile(join(staging, name), bytes);
	}

	const archive = join(directory, `jar-${counter}.jar`);

	await zipped(staging, archive);

	return archive;
};

/** Zip a directory's contents with the system zip, deflated as published jars are, or say what is missing. */
export const zipped = async (directory, archive) => {
	if (Bun.which('zip') === null) throw new Error('These tests build jars with the system zip; install zip to run them');

	const child = Bun.spawn(['zip', '-qr', archive, '.'], { cwd: directory, stdout: 'ignore', stderr: 'pipe' });
	const said = await new Response(child.stderr).text();

	if ((await child.exited) !== 0) throw new Error(`zip could not write ${archive}: ${said.trim()}`);
};

const u4 = value => {
	const bytes = Buffer.alloc(4);

	bytes.writeUInt32LE(value);

	return bytes;
};

/** A zip written byte by byte, stored, so an entry can carry a name the system zip would refuse, such as `../x`. */
export const rawZip = entries => {
	const locals = [];
	const central = [];
	let offset = 0;

	for (const [name, text] of Object.entries(entries)) {
		const nameBytes = Buffer.from(name);
		const data = Buffer.from(text);
		const check = u4(Bun.hash.crc32(data));
		const fixed = Buffer.concat([u2(0).reverse(), u2(0), u2(0), u2(0), u2(0), check, u4(data.length), u4(data.length)]);

		locals.push(Buffer.concat([u4(0x04_03_4b_50), fixed, u2(nameBytes.length).reverse(), u2(0), nameBytes, data]));
		central.push(
			Buffer.concat([
				u4(0x02_01_4b_50),
				u2(0),
				fixed,
				u2(nameBytes.length).reverse(),
				u2(0),
				u2(0),
				u2(0),
				u2(0),
				u4(0),
				u4(offset),
				nameBytes,
			]),
		);
		offset += locals.at(-1).length;
	}

	const directory = Buffer.concat(central);
	const count = u2(central.length).reverse();

	return Buffer.concat([
		...locals,
		directory,
		u4(0x06_05_4b_50),
		u2(0),
		u2(0),
		count,
		count,
		u4(directory.length),
		u4(offset),
		u2(0),
	]);
};

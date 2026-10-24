const MAGIC = 0xca_fe_ba_be;

const UTF8 = 1;
const CLASS = 7;
const STRING = 8;
const FIELD = 9;
const METHOD = 10;
const INTERFACE_METHOD = 11;
const NAME_AND_TYPE = 12;

/** Bytes each constant occupies after its tag, for the tags whose length is fixed. */
const FIXED = {
	3: 4,
	4: 4,
	5: 8,
	6: 8,
	7: 2,
	8: 2,
	9: 4,
	10: 4,
	11: 4,
	12: 4,
	15: 3,
	16: 2,
	17: 4,
	18: 4,
	19: 2,
	20: 2,
};

/** Class files spell text in modified UTF-8: a null is two bytes, and astral characters arrive as surrogate pairs. */
const decode = (bytes, start, end) => {
	let ascii = true;

	for (let index = start; index < end && ascii; ++index) ascii = bytes[index] < 0x80;

	if (ascii) return bytes.toString('latin1', start, end);

	const units = [];

	for (let index = start; index < end; ) {
		const a = bytes[index++];

		if (a < 0x80) units.push(a);
		else if ((a & 0xe0) === 0xc0) units.push(((a & 0x1f) << 6) | (bytes[index++] & 0x3f));
		else units.push(((a & 0x0f) << 12) | ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f));
	}

	return Buffer.from(new Uint16Array(units).buffer).toString('utf16le');
};

/**
 * What a class names: itself, its superclass, every class and member it refers to (written
 * `owner.member`), and its string constants. All of it is in the constant pool, so nothing past
 * the pool is read.
 */
export const readClass = bytes => {
	if (bytes.length < 10 || bytes.readUInt32BE(0) !== MAGIC) throw new Error('Not a class file');

	const count = bytes.readUInt16BE(8);
	const pool = [];
	let offset = 10;

	for (let index = 1; index < count; ++index) {
		const tag = bytes[offset];

		if (tag === UTF8) {
			const length = bytes.readUInt16BE(offset + 1);

			pool[index] = { tag, text: decode(bytes, offset + 3, offset + 3 + length) };
			offset += 3 + length;

			continue;
		}

		if (FIXED[tag] === undefined) throw new Error(`Unknown constant pool tag ${tag}`);

		pool[index] = { tag, a: bytes.readUInt16BE(offset + 1), b: bytes.readUInt16BE(offset + 3) };
		offset += 1 + FIXED[tag];

		// A long or a double occupies two pool indices, by the JVM spec.
		if (tag === 5 || tag === 6) ++index;
	}

	const text = index => (pool[index]?.tag === UTF8 ? pool[index].text : undefined);
	const className = index => (pool[index]?.tag === CLASS ? text(pool[index].a) : undefined);
	const references = [];
	const strings = [];

	for (const entry of pool) {
		if (entry === undefined) continue;

		if (entry.tag === CLASS) references.push(text(entry.a));
		else if (entry.tag === STRING) strings.push(text(entry.a));
		else if (entry.tag === FIELD || entry.tag === METHOD || entry.tag === INTERFACE_METHOD) {
			const member = pool[entry.b];

			if (member?.tag === NAME_AND_TYPE) references.push(`${className(entry.a)}.${text(member.a)}`);
		}
	}

	return {
		name: className(bytes.readUInt16BE(offset + 2)),
		superName: className(bytes.readUInt16BE(offset + 4)),
		references: references.filter(Boolean),
		strings: strings.filter(value => value !== undefined),
	};
};

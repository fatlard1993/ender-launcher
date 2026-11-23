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

/** The annotations a NeoForge or Forge mod's main class carries, by their descriptors. */
const MOD_ANNOTATIONS = new Set(['Lnet/neoforged/fml/common/Mod;', 'Lnet/minecraftforge/fml/common/Mod;']);

/** Instructions whose operand is a constant pool index: one byte wide for ldc, two for the rest. */
const POOL_OPERAND = new Set([
	0x12, 0x13, 0x14, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xbb, 0xbd, 0xc0, 0xc1, 0xc5,
]);

/** Bytes of operands after each opcode, for those with any and a fixed width; switches and wide are measured apart. */
const OPERANDS = new Map([
	[0x10, 1],
	[0x11, 2],
	[0x12, 1],
	[0x13, 2],
	[0x14, 2],
	...[0x15, 0x16, 0x17, 0x18, 0x19, 0x36, 0x37, 0x38, 0x39, 0x3a, 0xa9, 0xbc].map(op => [op, 1]),
	[0x84, 2],
	...Array.from({ length: 0xa8 - 0x99 + 1 }, (_, at) => [0x99 + at, 2]),
	...[0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xbb, 0xbd, 0xc0, 0xc1, 0xc6, 0xc7].map(op => [op, 2]),
	[0xb9, 4],
	[0xba, 4],
	[0xc5, 3],
	[0xc8, 4],
	[0xc9, 4],
]);

/** The pool indices one method's bytecode refers to, walking its instructions by their widths. */
const poolIndicesIn = (bytes, start, length) => {
	const found = new Set();

	for (let at = start; at < start + length;) {
		const opcode = bytes[at];

		if (POOL_OPERAND.has(opcode)) found.add(opcode === 0x12 ? bytes[at + 1] : bytes.readUInt16BE(at + 1));

		if (opcode === 0xaa || opcode === 0xab) {
			const aligned = at + 1 + ((4 - ((at + 1 - start) % 4)) % 4);

			if (opcode === 0xaa) {
				const low = bytes.readInt32BE(aligned + 4);
				const high = bytes.readInt32BE(aligned + 8);

				at = aligned + 12 + (high - low + 1) * 4;
			} else at = aligned + 8 + bytes.readInt32BE(aligned + 4) * 8;
		} else if (opcode === 0xc4) at += bytes[at + 1] === 0x84 ? 6 : 4;
		else at += 1 + (OPERANDS.get(opcode) ?? 0);
	}

	return found;
};

/** Class files spell text in modified UTF-8: a null is two bytes, and astral characters arrive as surrogate pairs. */
const decode = (bytes, start, end) => {
	let ascii = true;

	for (let index = start; index < end && ascii; ++index) ascii = bytes[index] < 0x80;

	if (ascii) return bytes.toString('latin1', start, end);

	const units = [];

	for (let index = start; index < end;) {
		const a = bytes[index++];

		if (a < 0x80) units.push(a);
		else if ((a & 0xe0) === 0xc0) units.push(((a & 0x1f) << 6) | (bytes[index++] & 0x3f));
		else units.push(((a & 0x0f) << 12) | ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f));
	}

	return Buffer.from(new Uint16Array(units).buffer).toString('utf16le');
};

/**
 * What a class names: itself, its superclass, every class and member it refers to (written `owner.member`), and its
 * string constants, all from the constant pool; then, from its methods' bytecode, which method uses each reference,
 * and whether it is a NeoForge or Forge mod's main class. A class whose methods do not parse is still read for its pool.
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
	const referenceAt = index => {
		const entry = pool[index];

		if (entry?.tag === CLASS) return text(entry.a);
		if (entry?.tag === FIELD || entry?.tag === METHOD || entry?.tag === INTERFACE_METHOD) {
			const member = pool[entry.b];

			return member?.tag === NAME_AND_TYPE ? `${className(entry.a)}.${text(member.a)}` : undefined;
		}

		return undefined;
	};
	const references = [];
	const strings = [];

	for (const [index, entry] of pool.entries()) {
		if (entry === undefined) continue;

		if (entry.tag === STRING) strings.push(text(entry.a));
		else references.push(referenceAt(index));
	}

	let methods;

	try {
		methods = methodsOf(bytes, offset, text, referenceAt);
	} catch {
		methods = {};
	}

	return {
		name: className(bytes.readUInt16BE(offset + 2)),
		superName: className(bytes.readUInt16BE(offset + 4)),
		references: references.filter(Boolean),
		strings: strings.filter(value => value !== undefined),
		methods,
		modClass: pool.some(entry => entry?.tag === UTF8 && MOD_ANNOTATIONS.has(entry.text)),
	};
};

/** Skip one field's or method's attributes, answering the offset past them and calling `each` with each one's place. */
const attributes = (bytes, at, each = () => {}) => {
	const count = bytes.readUInt16BE(at);
	let offset = at + 2;

	for (let index = 0; index < count; ++index) {
		const length = bytes.readUInt32BE(offset + 2);

		each(bytes.readUInt16BE(offset), offset + 6, length);
		offset += 6 + length;
	}

	return offset;
};

/** Each method by name, with the references its bytecode uses; methods of one name share an entry. */
const methodsOf = (bytes, poolEnd, text, referenceAt) => {
	let offset = poolEnd + 6;

	offset += 2 + bytes.readUInt16BE(offset) * 2;

	const fields = bytes.readUInt16BE(offset);

	offset += 2;

	for (let index = 0; index < fields; ++index) offset = attributes(bytes, offset + 6);

	const count = bytes.readUInt16BE(offset);
	const methods = new Map();

	offset += 2;

	for (let index = 0; index < count; ++index) {
		const name = text(bytes.readUInt16BE(offset + 2));
		const used = methods.get(name) ?? new Set();

		methods.set(name, used);

		offset = attributes(bytes, offset + 6, (attribute, start) => {
			if (text(attribute) !== 'Code') return;

			const length = bytes.readUInt32BE(start + 4);

			for (const poolIndex of poolIndicesIn(bytes, start + 8, length)) {
				const reference = referenceAt(poolIndex);

				if (reference) used.add(reference);
			}
		});
	}

	return Object.fromEntries([...methods].map(([name, used]) => [name, [...used]]));
};

import { join } from 'node:path';

/**
 * The game's multiplayer list, servers.dat: uncompressed big-endian NBT, a root compound holding a list `servers` of
 * compounds, each a `name` and an `ip` among whatever else the game keeps. Read and written whole, so tags this does
 * not know, such as a server's icon, go back as they came.
 */
const TAG = {
	end: 0,
	byte: 1,
	short: 2,
	int: 3,
	long: 4,
	float: 5,
	double: 6,
	bytes: 7,
	string: 8,
	list: 9,
	compound: 10,
	ints: 11,
	longs: 12,
};

/** A value with the tag it was read as, so writing it gives back the same bytes. */
const tagged = (type, value) => ({ type, value });

/** An NBT file's root compound, as [name, { type, value }] entries. */
export const readNbt = bytes => decode(bytes);

const decode = bytes => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let at = 0;
	const text = () => {
		const length = view.getUint16(at);
		const value = new TextDecoder().decode(bytes.subarray(at + 2, at + 2 + length));

		at += 2 + length;

		return value;
	};
	const payload = type => {
		switch (type) {
			case TAG.byte:
				return view.getInt8(at++);
			case TAG.short:
				return ((at += 2), view.getInt16(at - 2));
			case TAG.int:
				return ((at += 4), view.getInt32(at - 4));
			case TAG.long:
				return ((at += 8), view.getBigInt64(at - 8));
			case TAG.float:
				return ((at += 4), view.getFloat32(at - 4));
			case TAG.double:
				return ((at += 8), view.getFloat64(at - 8));
			case TAG.bytes: {
				const length = view.getInt32(at);
				const value = bytes.slice(at + 4, at + 4 + length);

				at += 4 + length;

				return value;
			}
			case TAG.string:
				return text();
			case TAG.list: {
				const inner = view.getInt8(at);
				const length = view.getInt32(at + 1);

				at += 5;

				return { inner, items: Array.from({ length }, () => payload(inner)) };
			}
			case TAG.compound: {
				const entries = [];

				for (let inner = view.getInt8(at++); inner !== TAG.end; inner = view.getInt8(at++)) {
					const name = text();

					entries.push([name, tagged(inner, payload(inner))]);
				}

				return entries;
			}
			case TAG.ints:
			case TAG.longs: {
				const length = view.getInt32(at);
				const size = type === TAG.ints ? 4 : 8;
				const value = Array.from({ length }, (_, index) =>
					size === 4 ? view.getInt32(at + 4 + index * 4) : view.getBigInt64(at + 4 + index * 8),
				);

				at += 4 + length * size;

				return value;
			}
			default:
				throw new Error(`servers.dat holds a tag of type ${type}, which is not NBT`);
		}
	};
	const type = view.getInt8(at++);

	if (type !== TAG.compound) throw new Error('servers.dat does not begin with a compound');

	text();

	return payload(TAG.compound);
};

/** An NBT file of a root compound, as readNbt gives one. */
export const writeNbt = root => encode(root);

const encode = root => {
	const parts = [];
	const push = (size, write) => {
		const buffer = new DataView(new ArrayBuffer(size));

		write(buffer);
		parts.push(new Uint8Array(buffer.buffer));
	};
	const text = value => {
		const encoded = new TextEncoder().encode(value);

		push(2, view => view.setUint16(0, encoded.length));
		parts.push(encoded);
	};
	const payload = (type, value) => {
		switch (type) {
			case TAG.byte:
				return push(1, view => view.setInt8(0, value));
			case TAG.short:
				return push(2, view => view.setInt16(0, value));
			case TAG.int:
				return push(4, view => view.setInt32(0, value));
			case TAG.long:
				return push(8, view => view.setBigInt64(0, value));
			case TAG.float:
				return push(4, view => view.setFloat32(0, value));
			case TAG.double:
				return push(8, view => view.setFloat64(0, value));
			case TAG.bytes:
				push(4, view => view.setInt32(0, value.length));

				return parts.push(value);
			case TAG.string:
				return text(value);
			case TAG.list:
				push(5, view => {
					view.setInt8(0, value.items.length === 0 ? TAG.end : value.inner);
					view.setInt32(1, value.items.length);
				});

				return value.items.forEach(item => payload(value.inner, item));
			case TAG.compound:
				for (const [name, inner] of value) {
					push(1, view => view.setInt8(0, inner.type));
					text(name);
					payload(inner.type, inner.value);
				}

				return push(1, view => view.setInt8(0, TAG.end));
			case TAG.ints:
			case TAG.longs:
				push(4, view => view.setInt32(0, value.length));

				return value.forEach(item => payload(type === TAG.ints ? TAG.int : TAG.long, item));
			default:
				throw new Error(`No NBT tag of type ${type}`);
		}
	};

	push(1, view => view.setInt8(0, TAG.compound));
	text('');
	payload(TAG.compound, root);

	return new Uint8Array(parts.reduce((all, part) => [...all, ...part], []));
};

const field = (compound, name) => compound.find(([key]) => key === name)?.[1]?.value;

/** The servers a servers.dat lists, as { name, address }, in its order. */
export const serversIn = bytes =>
	(field(decode(bytes), 'servers')?.items ?? []).map(server => ({
		name: field(server, 'name') ?? '',
		address: field(server, 'ip') ?? '',
	}));

/** A server address as the game compares it: without case or a default port. */
const sameAddress = (a, b) =>
	a
		.trim()
		.toLowerCase()
		.replace(/:25565$/, '') ===
	b
		.trim()
		.toLowerCase()
		.replace(/:25565$/, '');

/**
 * The game's multiplayer list with a pack's servers in it: each the pack names that is not listed yet is added at the
 * end, and each it added before and no longer names is taken off. A player's own servers, and their order, are never
 * touched. Answers what was added and removed.
 */
export const placeServers = async (gameDir, wanted, { before = [] } = {}) => {
	if (wanted.length === 0 && before.length === 0) return { added: [], removed: [] };

	const file = Bun.file(join(gameDir, 'servers.dat'));
	const root = (await file.exists()) ? decode(new Uint8Array(await file.arrayBuffer())) : [];
	const listed = root.find(([key]) => key === 'servers')?.[1]?.value ?? { inner: TAG.compound, items: [] };
	const dropped = before.filter(address => !wanted.some(server => sameAddress(server.address, address)));
	const items = listed.items.filter(
		server => !dropped.some(address => sameAddress(field(server, 'ip') ?? '', address)),
	);
	const added = wanted.filter(server => !items.some(item => sameAddress(field(item, 'ip') ?? '', server.address)));

	if (added.length === 0 && items.length === listed.items.length) return { added: [], removed: [] };

	items.push(
		...added.map(server => [
			['name', tagged(TAG.string, server.name)],
			['ip', tagged(TAG.string, server.address)],
		]),
	);

	const list = ['servers', tagged(TAG.list, { inner: TAG.compound, items })];
	const at = root.findIndex(([key]) => key === 'servers');

	await Bun.write(file, encode(at === -1 ? [...root, list] : root.with(at, list)));

	return {
		added,
		removed: dropped.filter(address => listed.items.some(server => sameAddress(field(server, 'ip') ?? '', address))),
	};
};

/** What a pack's `servers` say, checked: each a name and an address, or the problem with it. */
export const serversOf = (pack, problems) => {
	if (pack?.servers === undefined) return [];
	if (!Array.isArray(pack.servers)) {
		problems.push('"servers" is not a list');

		return [];
	}

	return pack.servers.flatMap((server, at) => {
		const name = typeof server?.name === 'string' ? server.name.trim() : '';
		const address = typeof server?.address === 'string' ? server.address.trim() : '';

		if (name === '' || !/^[\w.-]+(:\d{1,5})?$/.test(address)) {
			problems.push(`servers[${at}] is not { "name", "address" } with an address like play.example.com:25565`);

			return [];
		}

		return [{ name, address }];
	});
};

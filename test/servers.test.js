import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';

import { parseEnderPack } from '../src/instance/enderPack';
import { placeServers, readNbt, serversIn, writeNbt } from '../src/instance/servers';

let gameDir;

beforeEach(async () => {
	gameDir = await mkdtemp(join(tmpdir(), 'ender-servers-'));
});

afterEach(async () => {
	await rm(gameDir, { recursive: true, force: true });
});

const string = value => ({ type: 8, value });
const byte = value => ({ type: 1, value });

/** A multiplayer list as the game writes one: a player's server with its icon and choices, and a tag of its own. */
const players = writeNbt([
	[
		'servers',
		{
			type: 9,
			value: {
				inner: 10,
				items: [
					[
						['icon', string('iVBORw0KGgo=')],
						['ip', string('home.example.net')],
						['name', string('Our world')],
						['acceptTextures', byte(1)],
						['hidden', byte(0)],
					],
				],
			},
		},
	],
	['extra', { type: 3, value: 7 }],
]);

test('reads and writes NBT back to the same bytes', () => {
	expect(writeNbt(readNbt(players))).toEqual(players);
});

test("adds a pack's servers after a player's own, keeps every tag of theirs, and takes off only what the pack dropped", async () => {
	await Bun.write(join(gameDir, 'servers.dat'), players);

	const first = await placeServers(gameDir, [
		{ name: 'Family', address: 'play.family.example:25570' },
		{ name: 'Ours again', address: 'HOME.example.net:25565' },
	]);
	const after = new Uint8Array(await Bun.file(join(gameDir, 'servers.dat')).arrayBuffer());

	expect(first.added).toEqual([{ name: 'Family', address: 'play.family.example:25570' }]);
	expect(serversIn(after)).toEqual([
		{ name: 'Our world', address: 'home.example.net' },
		{ name: 'Family', address: 'play.family.example:25570' },
	]);
	expect(readNbt(after)[0][1].value.items[0]).toEqual(readNbt(players)[0][1].value.items[0]);
	expect(readNbt(after).find(([key]) => key === 'extra')).toEqual(['extra', { type: 3, value: 7 }]);

	const second = await placeServers(gameDir, [], { before: ['play.family.example:25570', 'home.example.net'] });

	// home.example.net was the player's before the pack named it, but the pack named it too; it goes with the pack
	expect(second.removed).toEqual(['play.family.example:25570', 'home.example.net']);
	expect(serversIn(new Uint8Array(await Bun.file(join(gameDir, 'servers.dat')).arrayBuffer()))).toEqual([]);
});

test('begins a multiplayer list when the game has made none yet', async () => {
	await placeServers(gameDir, [{ name: 'Family', address: 'play.family.example' }]);

	expect(serversIn(new Uint8Array(await Bun.file(join(gameDir, 'servers.dat')).arrayBuffer()))).toEqual([
		{ name: 'Family', address: 'play.family.example' },
	]);
});

test("an ender pack's servers are each a name and an address", () => {
	const pack = servers => JSON.stringify({ minecraft: '26.3', loader: 'fabric', mods: [], servers });

	expect(parseEnderPack(pack([{ name: 'Family', address: 'play.family.example:25570' }])).servers).toEqual([
		{ name: 'Family', address: 'play.family.example:25570' },
	]);

	for (const bad of [[{ name: 'x' }], [{ name: '', address: 'a.b' }], [{ name: 'x', address: 'a b' }], 'a.b']) {
		expect(() => parseEnderPack(pack(bad))).toThrow('servers');
	}
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';

import { listEntries, readEntry, readEntryJson } from '../src/archive';
import { mrpackFrom } from '../src/instance/mrpack';
import { writeZip } from '../src/zipWriter';
import { jar } from './jars';

let gameDir;

beforeEach(async () => {
	gameDir = await mkdtemp(join(tmpdir(), 'ender-mrpack-'));
});

afterEach(async () => {
	await rm(gameDir, { recursive: true, force: true });
});

test('writes a zip that reads back, deflating what shrinks and storing what does not', async () => {
	const random = crypto.getRandomValues(new Uint8Array(300));
	const path = join(gameDir, 'out.zip');

	await Bun.write(
		path,
		writeZip([
			{ name: 'a/é.txt', bytes: new TextEncoder().encode('a'.repeat(5000)) },
			{ name: 'r', bytes: random },
		]),
	);

	expect(await listEntries(path)).toEqual(['a/é.txt', 'r']);
	expect((await readEntry(path, 'a/é.txt')).toString()).toBe('a'.repeat(5000));
	expect(new Uint8Array(await readEntry(path, 'r'))).toEqual(random);
});

test('writes an instance as a Modrinth pack of what it installed, with hashes, sides and its files', async () => {
	const place = async (folder, name, bytes) => {
		await mkdir(join(gameDir, folder), { recursive: true });
		await writeFile(join(gameDir, folder, name), bytes);
	};
	const clientJar = await Bun.file(
		await jar(gameDir, { 'fabric.mod.json': JSON.stringify({ id: 'zoom', environment: 'client' }) }),
	).bytes();

	await place('mods', 'zoom.jar', clientJar);
	await place('mods', 'lib.jar', 'lib');
	await place('mods', 'mine.jar', 'mine');
	await place('mods', 'far.jar', 'far');
	await place('resourcepacks', 'look.zip', 'look');
	await place('config', 'a.json', '{"a":1}');

	const { archive, index, left, outside } = await mrpackFrom({
		manifest: {
			name: 'House',
			minecraft: '26.3',
			loader: { type: 'fabric', version: '0.20.1' },
			gameDir,
			mods: [{ source: 'modrinth', id: 'zoom', optional: true }],
			chosen: ['modrinth:zoom'],
		},
		lock: {
			mods: [
				{ key: 'modrinth:zoom', filename: 'zoom.jar', url: 'https://cdn.modrinth.com/zoom.jar' },
				{ key: 'github:a/lib', filename: 'lib.jar', url: 'https://github.com/a/lib/releases/download/1/lib.jar' },
				{ key: 'local:/x', filename: 'mine.jar', url: undefined },
				{ key: 'url:https://example.com/far.jar', filename: 'far.jar', url: 'https://example.com/far.jar' },
			],
			assets: {
				resourcepacks: [{ key: 'modrinth:look', filename: 'look.zip', url: 'https://cdn.modrinth.com/look.zip' }],
			},
			overrides: { 'config/a.json': 'x', 'config/gone.json': 'y' },
		},
		version: '2.0',
	});
	const path = join(gameDir, 'House.mrpack');

	await Bun.write(path, archive);

	expect(await readEntryJson(path, 'modrinth.index.json')).toEqual(index);
	expect(index).toMatchObject({ formatVersion: 1, game: 'minecraft', versionId: '2.0', name: 'House' });
	expect(index.dependencies).toEqual({ minecraft: '26.3', 'fabric-loader': '0.20.1' });
	expect(index.files.map(file => [file.path, file.env])).toEqual([
		['mods/zoom.jar', { client: 'optional', server: 'unsupported' }],
		['mods/lib.jar', { client: 'required', server: 'required' }],
		['mods/far.jar', { client: 'required', server: 'required' }],
		['resourcepacks/look.zip', { client: 'required', server: 'unsupported' }],
	]);
	expect(index.files[1].hashes.sha1).toBe(new Bun.CryptoHasher('sha1').update('lib').digest('hex'));
	expect(index.files[1].fileSize).toBe(3);
	expect(left).toEqual(['mine.jar']);
	expect(outside).toEqual(['far.jar']);
	expect((await readEntry(path, 'overrides/config/a.json')).toString()).toBe('{"a":1}');
	expect(await listEntries(path)).not.toContain('overrides/config/gone.json');
});

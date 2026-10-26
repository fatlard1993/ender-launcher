import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { fromPrism } from '../src/instance/import';

let directory;

const prismInstance = async (name, gameDirName) => {
	const instance = join(directory, name);

	await mkdir(join(instance, gameDirName, 'mods'), { recursive: true });
	await writeFile(
		join(instance, 'mmc-pack.json'),
		JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.21.1' }] }),
	);

	return instance;
};

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), 'ender-import-'));
});

afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe('prism import', () => {
	test('finds a .minecraft game directory', async () => {
		const { manifest } = await fromPrism(await prismInstance('dotted', '.minecraft'));

		expect(manifest.gameDir).toEndWith(join('dotted', '.minecraft'));
	});

	test('finds a game directory Prism named without the dot', async () => {
		const { manifest } = await fromPrism(await prismInstance('plain', 'minecraft'));

		expect(manifest.gameDir).toEndWith(join('plain', 'minecraft'));
	});
});

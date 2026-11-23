import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';

import { writeJson } from '../src/json';

test('writes to one file at once, each through a temporary file of its own, leaving the last whole and none behind', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ender-json-'));
	const path = join(directory, 'kept.json');

	try {
		await Promise.all(Array.from({ length: 20 }, (_, at) => writeJson(path, { at })));

		expect(typeof (await Bun.file(path).json()).at).toBe('number');
		expect(await readdir(directory)).toEqual(['kept.json']);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

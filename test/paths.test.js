import { describe, expect, test } from 'bun:test';

import { parseModSpec } from '../src/commands/context';
import { REPOSITORY } from '../src/commands/packSource';
import { parseEnderPack } from '../src/instance/enderPack';
import { namesThisMachine, safeId } from '../src/mods/spec';

/** Names a request or a pack from anywhere could carry, each one a way out of the path it would be put in. */
const CLIMBING = ['../x', 'a/..', './a', 'a/./b', 'a//b', '/abs', 'a\\b', '..', '.', ''];

describe('a name that becomes a path', () => {
	test('is an id only with no empty, "." or ".." part and no backslash', () => {
		for (const id of CLIMBING) expect({ id, safe: safeId(id) }).toEqual({ id, safe: false });
		for (const id of ['sodium', 'CaffeineMC/sodium', 'group/sub/project', 'a.b/c-d_e']) {
			expect({ id, safe: safeId(id) }).toEqual({ id, safe: true });
		}
	});

	test('is refused as a mod spec on any host, and read as one when safe', () => {
		for (const prefix of ['gh:', 'cb:', 'gl:', 'mr:', 'cf:']) {
			for (const id of ['../x', 'a/..', 'a/./b', 'a\\b']) {
				expect(() => parseModSpec(`${prefix}${id}`)).toThrow('names no mod');
			}
		}

		// Without a prefix, ../x is a jar on the player's own disk, which a pack may not name; a/.. is a repository
		expect(parseModSpec('../x.jar')).toEqual({ source: 'local', path: '../x.jar' });
		expect(() => parseModSpec('a/..')).toThrow('names no mod');

		expect(parseModSpec('gh:a/b@1.0')).toEqual({ source: 'github', id: 'a/b', version: '1.0' });
		expect(parseModSpec('gl:group/sub/p')).toEqual({ source: 'gitlab', id: 'group/sub/p' });
		expect(parseModSpec('./build/libs/mod.jar')).toEqual({ source: 'local', path: './build/libs/mod.jar' });
	});

	test("is refused as a pack's repository", () => {
		for (const id of ['../x', 'a/..', './a', 'a/.', '../..']) expect(REPOSITORY.test(`gh:${id}`)).toBe(false);
		expect(REPOSITORY.test('gh:me/pack')).toBe(true);
		expect(REPOSITORY.test('gh:me/.github')).toBe(true);
	});
});

describe('a pack from anywhere', () => {
	const pack = mods => JSON.stringify({ name: 'p', minecraft: '26.3', loader: 'fabric', mods });

	test('names no jar or project on the machine that imports it', () => {
		for (const spec of [
			'./x.jar',
			'../x.jar',
			'/home/me/x.jar',
			'~/x.jar',
			'C:\\x.jar',
			'x.jar',
			'gradle:../proj',
			'gradle:/proj',
		]) {
			expect(namesThisMachine(spec)).toBe(true);
			expect(() => parseEnderPack(pack([spec]))).toThrow('names a jar or project on this machine');
		}
	});

	test('names mods where they are published, and links', () => {
		const mods = ['gh:a/b', 'mr:sodium', 'sodium', { spec: 'cf:jei', version: '1' }, 'https://example.com/x.jar'];

		for (const spec of ['gh:a/b', 'mr:sodium', 'https://example.com/x.jar']) expect(namesThisMachine(spec)).toBe(false);
		expect(parseEnderPack(pack(mods)).mods).toHaveLength(5);
	});
});

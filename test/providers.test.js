import { describe, expect, test } from 'bun:test';

import { parseModSpec } from '../src/commands/context';
import { checksumOf, checksumText } from '../src/download';
import { downloadUrl } from '../src/mods/curseforge';
import { chooseAsset, parseRepository } from '../src/mods/github';

describe('checksums', () => {
	test('reads a bare value as sha1', () => {
		expect(checksumOf('ABC123')).toEqual({ algorithm: 'sha1', value: 'abc123' });
	});

	test('reads a prefixed value as its own algorithm', () => {
		expect(checksumOf('sha256:DEAD')).toEqual({ algorithm: 'sha256', value: 'dead' });
	});

	test('round trips through its text form', () => {
		expect(checksumText(checksumOf('sha256:dead'))).toBe('sha256:dead');
	});

	test('nothing in, nothing out', () => {
		expect(checksumOf(undefined)).toBeUndefined();
		expect(checksumText(undefined)).toBeUndefined();
	});
});

describe('curseforge download urls', () => {
	// The keyless route publishes no url, so this derivation is the whole download path.
	// Every id below is a real file, and each form was checked against the CDN itself.
	test('splits a file id into thousands and remainder', () => {
		expect(downloadUrl(8941416, 'jei-26.3-neoforge-31.4.0.19.jar')).toBe(
			'https://mediafilez.forgecdn.net/files/8941/416/jei-26.3-neoforge-31.4.0.19.jar',
		);
	});

	test('handles an older, smaller id', () => {
		expect(downloadUrl(2267755, 'jei_1.8-1.0.1.jar')).toBe(
			'https://mediafilez.forgecdn.net/files/2267/755/jei_1.8-1.0.1.jar',
		);
	});

	// 8880/075 and 8851/009 are both refused by the CDN; the unpadded forms are served.
	test('does not pad the remainder', () => {
		expect(downloadUrl(8880075, 'a.jar')).toContain('/files/8880/75/');
		expect(downloadUrl(8851009, 'a.jar')).toContain('/files/8851/9/');
	});

	// A literal + is refused where %2B is served, and + is ordinary in a Fabric jar name.
	test('escapes a name that would otherwise be refused', () => {
		expect(downloadUrl(8888037, 'sodium-fabric-0.9.2+mc26.3.jar')).toBe(
			'https://mediafilez.forgecdn.net/files/8888/37/sodium-fabric-0.9.2%2Bmc26.3.jar',
		);
	});
});

describe('github release assets', () => {
	test('ignores the artifacts gradle ships beside the mod', () => {
		const assets = [{ name: 'mod-1.0-sources.jar' }, { name: 'mod-1.0.jar' }, { name: 'mod-1.0-javadoc.jar' }];

		expect(chooseAsset(assets).name).toBe('mod-1.0.jar');
	});

	test('prefers the jar built for this game version', () => {
		const assets = [{ name: 'mod-1.20.1.jar' }, { name: 'mod-26.3.jar' }];

		expect(chooseAsset(assets, { minecraft: '26.3' }).name).toBe('mod-26.3.jar');
	});

	test('falls back to the shortest name when no version matches', () => {
		const assets = [{ name: 'mod-extras.jar' }, { name: 'mod.jar' }];

		expect(chooseAsset(assets, { minecraft: '99.9' }).name).toBe('mod.jar');
	});

	test('an explicit pattern overrides the guessing', () => {
		const assets = [{ name: 'mod-fabric.jar' }, { name: 'mod-forge.jar' }];

		expect(chooseAsset(assets, { pattern: 'forge' }).name).toBe('mod-forge.jar');
	});

	test('gives nothing rather than a wrong jar', () => {
		expect(chooseAsset([{ name: 'mod.zip' }])).toBeUndefined();
		expect(chooseAsset([{ name: 'mod-sources.jar' }])).toBeUndefined();
		expect(chooseAsset([{ name: 'mod.jar' }], { pattern: 'nope' })).toBeUndefined();
	});

	test('rejects a reference that is not owner/repo', () => {
		expect(parseRepository('FabricMC/fabric')).toEqual({ owner: 'FabricMC', repository: 'fabric' });
		expect(() => parseRepository('fabric')).toThrow('owner/repo');
	});
});

describe('mod specs for the new sources', () => {
	test('reads github references, slash and all', () => {
		expect(parseModSpec('gh:FabricMC/fabric')).toEqual({ source: 'github', id: 'FabricMC/fabric' });
		expect(parseModSpec('github:FabricMC/fabric@0.160.6+26.3')).toEqual({
			source: 'github',
			id: 'FabricMC/fabric',
			version: '0.160.6+26.3',
		});
	});

	test('still treats a bare name as modrinth', () => {
		expect(parseModSpec('sodium').source).toBe('modrinth');
	});
});

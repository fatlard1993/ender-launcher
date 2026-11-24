import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { syncMods } from '../src/mods';
import { readMods } from '../src/mods/metadata';
import { meetRequirements, unmetMessage, unmetRequirements } from '../src/mods/requirements';
import { jar as jarIn } from './jars';

let root;
let modsDir;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'ender-test-'));
	modsDir = join(root, 'mods');

	await mkdir(modsDir, { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const fabric = (id, version, depends = {}) => ({ 'fabric.mod.json': JSON.stringify({ id, version, depends }) });

const installed = (source, id, mods) => ({ source, id, key: `${source}:${id}`, version: mods[0].version, file: { filename: `${id}.jar` }, mods });

const webs = installed('github', 'fatlard1993/better-webs', [
	{ id: 'better-webs', version: '1.0.0', provides: [], dependsVersions: { pandorical: '>=15.36.0', minecraft: '>=26.3' } },
]);

describe('a requirement narrowed to versions the provider is not', () => {
	test('is unmet beside an older provider, and met beside one new enough', () => {
		const old = installed('github', 'fatlard1993/pandorical', [{ id: 'pandorical', version: '15.35.4', provides: [] }]);
		const current = installed('github', 'fatlard1993/pandorical', [{ id: 'pandorical', version: '15.36.0', provides: [] }]);

		expect(unmetRequirements([webs, old]).map(({ modId, have }) => [modId, have])).toEqual([['pandorical', '15.35.4']]);
		expect(unmetRequirements([webs, current])).toEqual([]);
	});

	test('counts a provider by what it says it provides, and ignores what the game itself provides', () => {
		const bundle = installed('github', 'someone/bundle', [{ id: 'bundle', version: '1', provides: ['pandorical'] }]);

		bundle.mods[0].version = '15.36.0';

		expect(unmetRequirements([webs, bundle])).toEqual([]);
	});

	test('is left to the unplaced report when nothing installed provides it, and taken as met when unreadable', () => {
		const odd = installed('github', 'fatlard1993/pandorical', [{ id: 'pandorical', version: 'nightly', provides: [] }]);

		expect(unmetRequirements([webs])).toEqual([]);
		expect(unmetRequirements([webs, odd])).toEqual([]);
	});

	test('compares a module nested in a jar by its own version, not the jar it ships in', () => {
		const api = installed('modrinth', 'fabric-api', [
			{
				id: 'fabric-api',
				version: '0.167.0+26.3',
				provides: ['fabric-rendering-fluids-v1'],
				bundled: { 'fabric-rendering-fluids-v1': '6.0.7+3434d6d95d' },
			},
		]);
		const sodium = installed('modrinth', 'sodium', [
			{ id: 'sodium', version: '0.9.2+mc26.3', provides: [], dependsVersions: { 'fabric-rendering-fluids-v1': '>=2.0.0' } },
		]);
		const tooNew = installed('local', 'mine', [
			{ id: 'mine', version: '1', provides: [], dependsVersions: { 'fabric-rendering-fluids-v1': '>=7.0.0' } },
		]);

		expect(unmetRequirements([sodium, api])).toEqual([]);
		expect(unmetRequirements([tooNew, api]).map(({ modId, have }) => [modId, have])).toEqual([
			['fabric-rendering-fluids-v1', '6.0.7+3434d6d95d'],
		]);
	});

	test('ignores build metadata, as the loader does', () => {
		const api = installed('github', 'FabricMC/fabric', [{ id: 'fabric-api', version: '0.160.6+26.3', provides: [] }]);
		const needsApi = installed('local', 'mine', [{ id: 'mine', version: '1', provides: [], dependsVersions: { 'fabric-api': '>=0.160.6' } }]);

		expect(unmetRequirements([needsApi, api])).toEqual([]);
	});
});

describe('meeting a requirement the index is behind on', () => {
	const options = (releases, extra = {}) => ({
		modsDir,
		context: {},
		readMods: async path => releases[basename(path)] ?? [],
		install: async () => {},
		...extra,
	});

	test('takes the provider newest release from GitHub when it meets the requirement, in place', async () => {
		const old = { ...installed('github', 'fatlard1993/pandorical', [{ id: 'pandorical', version: '15.35.4', provides: [] }]), requested: true };
		const list = [{ ...webs, mods: undefined, file: { filename: 'better-webs.jar' } }, { ...old, mods: undefined, file: { filename: 'pandorical-15.35.4.jar' } }];
		const live = { source: 'github', id: 'fatlard1993/pandorical', version: 'v15.36.0', file: { filename: 'pandorical-15.36.0.jar' } };
		const asked = [];

		const unmet = await meetRequirements(
			list,
			options(
				{
					'better-webs.jar': webs.mods,
					'pandorical-15.35.4.jar': [{ id: 'pandorical', version: '15.35.4', provides: [] }],
					'pandorical-15.36.0.jar': [{ id: 'pandorical', version: '15.36.0', provides: [] }],
				},
				{ resolveLive: async entry => (asked.push(entry.id), live) },
			),
		);

		expect(unmet).toEqual([]);
		expect(asked).toEqual(['fatlard1993/pandorical']);
		expect(list[1].file.filename).toBe('pandorical-15.36.0.jar');
		expect(list[1].key).toBe('github:fatlard1993/pandorical');
		expect(list[1].requested).toBe(true);
		expect(list[1].ahead).toEqual({ of: '15.35.4', because: ['github:fatlard1993/better-webs'] });
	});

	test('keeps what it had and reports the requirement when GitHub has nothing newer that meets it', async () => {
		const list = [
			{ ...webs, mods: undefined, file: { filename: 'better-webs.jar' } },
			{ ...installed('github', 'fatlard1993/pandorical', [{ id: 'pandorical', version: '15.35.4', provides: [] }]), mods: undefined, file: { filename: 'pandorical-15.35.4.jar' } },
		];

		await writeFile(join(modsDir, 'pandorical-15.35.5.jar'), 'still too old');

		const unmet = await meetRequirements(
			list,
			options(
				{
					'better-webs.jar': webs.mods,
					'pandorical-15.35.4.jar': [{ id: 'pandorical', version: '15.35.4', provides: [] }],
					'pandorical-15.35.5.jar': [{ id: 'pandorical', version: '15.35.5', provides: [] }],
				},
				{ resolveLive: async () => ({ source: 'github', id: 'fatlard1993/pandorical', file: { filename: 'pandorical-15.35.5.jar' } }) },
			),
		);

		expect(list[1].file.filename).toBe('pandorical-15.35.4.jar');
		expect(await readdir(modsDir)).toEqual([]);
		expect(unmet).toHaveLength(1);
		expect(unmetMessage(unmet[0])).toBe(
			'github:fatlard1993/better-webs 1.0.0 requires pandorical >=15.36.0, but github:fatlard1993/pandorical is 15.35.4, and its newest release on GitHub does not meet it either; left out until it does, since the game refuses to start with both',
		);
	});

	test('does not ask GitHub about a provider that came from anywhere else', async () => {
		const list = [
			{ ...webs, mods: undefined, file: { filename: 'better-webs.jar' } },
			{ ...installed('modrinth', 'pandorical', [{ id: 'pandorical', version: '15.35.4', provides: [] }]), mods: undefined, file: { filename: 'pandorical.jar' } },
		];
		let asked = false;

		const unmet = await meetRequirements(
			list,
			options(
				{ 'better-webs.jar': webs.mods, 'pandorical.jar': [{ id: 'pandorical', version: '15.35.4', provides: [] }] },
				{ resolveLive: async () => ((asked = true), undefined) },
			),
		);

		expect(asked).toBe(false);
		expect(unmet.map(({ tried }) => tried)).toEqual([false]);
	});
});

describe('a sync whose jars the loader would refuse to start together', () => {
	test('leaves out the mod whose requirement cannot be met, says why, and installs the rest', async () => {
		const webs = await jarIn(root, fabric('better-webs', '1.0.0', { pandorical: '>=15.36.0' }));
		const pandorical = await jarIn(root, fabric('pandorical', '15.35.4'));
		const at = async (path, name) => {
			const destination = join(root, name);

			await writeFile(destination, await Bun.file(path).bytes());

			return { source: 'local', path: destination };
		};

		const result = await syncMods({
			entries: [await at(webs, 'better-webs.jar'), await at(pandorical, 'pandorical.jar')],
			modsDir,
			lock: { mods: [] },
			context: {},
			withDependencies: true,
		});

		expect(result.failures.map(({ error }) => error.message)).toEqual([
			`local:${join(root, 'better-webs.jar')} local requires pandorical >=15.36.0, but local:${join(root, 'pandorical.jar')} is 15.35.4; left out until it does, since the game refuses to start with both`,
		]);
		expect(await readdir(modsDir)).toEqual(['pandorical.jar']);
		expect(result.lock.mods.map(({ filename }) => filename)).toEqual(['pandorical.jar']);
	});
});

describe('what a jar says it needs', () => {
	test('keeps the versions a requirement narrows to, and leaves out the ones it does not', async () => {
		const path = await jarIn(root, fabric('better-webs', '1.0.0', { pandorical: '>=15.36.0', 'fabric-api': '*' }));

		expect((await readMods(path))[0].dependsVersions).toEqual({ pandorical: '>=15.36.0' });
	});
});

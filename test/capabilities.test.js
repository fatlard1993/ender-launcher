import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';

import { scan } from '../src/commands/mods';
import { SCANNER_VERSION, entryClasses, gainedSince, scanJar } from '../src/mods/capabilities';
import { readClass } from '../src/mods/classfile';
import { classFile, jar as jarIn, rawZip } from './jars';

let directory;

const jar = files => jarIn(directory, files);
const scanOne = async options => scanJar(await jar({ 'a/A.class': classFile({ name: 'a/A', ...options }) }));

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), 'ender-scan-'));
});

afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe('class files', () => {
	test('reads the name, superclass, references and strings out of the constant pool', () => {
		const parsed = readClass(
			classFile({ name: 'a/A', superName: 'a/Base', members: ['java/lang/Runtime.exec'], strings: ['héllo'] }),
		);

		expect(parsed.name).toBe('a/A');
		expect(parsed.superName).toBe('a/Base');
		expect(parsed.references).toContain('java/lang/Runtime.exec');
		expect(parsed.strings).toEqual(['héllo']);
	});

	test('a long constant takes two pool indices and the rest still resolve', () => {
		const parsed = readClass(classFile({ name: 'a/A', members: ['java/net/Socket.<init>'], long: true }));

		expect(parsed.name).toBe('a/A');
		expect(parsed.references).toContain('java/net/Socket.<init>');
	});

	test('refuses bytes that are not a class file', () => {
		expect(() => readClass(Buffer.from('PK\u0003\u0004 not a class'))).toThrow('Not a class file');
	});
});

describe('capabilities', () => {
	test('a class that reaches nothing has no findings', async () => {
		const findings = await scanOne({ members: ['java/util/List.add'] });

		expect(findings.classes).toBe(1);
		expect(findings.capabilities).toEqual({});
		expect(findings.unreadable).toEqual([]);
	});

	test('names the class and the reference that granted each capability', async () => {
		const findings = await scanOne({ members: ['java/lang/Runtime.exec', 'java/lang/System.loadLibrary'] });

		expect(findings.capabilities.exec).toEqual({ 'a/A.class': ['java/lang/Runtime.exec'] });
		expect(findings.capabilities.native).toEqual({ 'a/A.class': ['java/lang/System.loadLibrary'] });
	});

	test('a member is the evidence, not the class reference that comes with it', async () => {
		const findings = await scanOne({ members: ['java/net/Socket.<init>'] });

		expect(findings.capabilities.network).toEqual({ 'a/A.class': ['java/net/Socket.<init>'] });
	});

	// ModMenu asks Runtime for its processor count; that is not running a process.
	test('another member of a granting class grants nothing', async () => {
		const findings = await scanOne({
			members: ['java/lang/Runtime.availableProcessors', 'java/lang/System.loadLibraryX'],
		});

		expect(findings.capabilities).toEqual({});
	});

	// The fractureiser stage 0 shape: a URL assembled from bytes, so no string names a host.
	test('loading classes from a URL is found with no URL in sight', async () => {
		const findings = await scanOne({ members: ['java/net/URLClassLoader.<init>', 'java/net/URL.<init>'] });

		expect(findings.capabilities.classloading).toEqual({ 'a/A.class': ['java/net/URLClassLoader.<init>'] });
		expect(findings.hosts).toEqual({});
	});

	test('a class loader subclass is found by what it extends', async () => {
		const findings = await scanOne({ superName: 'java/lang/ClassLoader' });

		expect(findings.capabilities.classloading).toEqual({ 'a/A.class': ['extends java/lang/ClassLoader'] });
	});

	test('reading a resource through a class loader is not loading classes', async () => {
		const findings = await scanOne({ members: ['java/lang/ClassLoader.getResource'] });

		expect(findings.capabilities).toEqual({});
	});

	test('a granting class reached by its name is found, wherever in the jar the lookup and the name sit', async () => {
		const findings = scanJar(
			await jar({
				'a/Load.class': classFile({ name: 'a/Load', members: ['java/lang/Class.forName'] }),
				'a/Names.class': classFile({
					name: 'a/Names',
					strings: ['java.lang.ProcessBuilder', 'java/net/URLClassLoader'],
				}),
			}),
		);

		expect((await findings).capabilities).toEqual({
			exec: { 'a/Names.class': ['"java.lang.ProcessBuilder" by name'] },
			classloading: { 'a/Names.class': ['"java.net.URLClassLoader" by name'] },
		});
	});

	test('a class named by a lookup counts as every capability that class could grant, as a name says nothing of the method', async () => {
		const findings = await scanOne({ members: ['java/lang/Class.forName'], strings: ['java.lang.Runtime'] });

		expect(findings.capabilities).toEqual({
			exec: { 'a/A.class': ['"java.lang.Runtime" by name'] },
			native: { 'a/A.class': ['"java.lang.Runtime" by name'] },
		});
	});

	test('a granting class is found by name in its array and descriptor spellings too', async () => {
		const findings = await scanOne({
			members: ['java/lang/Class.forName'],
			strings: ['[Ljava.lang.ProcessBuilder;', 'Ljava/net/Socket;'],
		});

		expect(Object.keys(findings.capabilities).sort()).toEqual(['exec', 'network']);
	});

	test('a lookup inside a nested jar holds the outer jar to the granting classes its strings name', async () => {
		const inner = await jar({
			'b/Load.class': classFile({ name: 'b/Load', members: ['java/lang/ClassLoader.loadClass'] }),
		});
		const findings = await scanJar(
			await jar({
				'a/Names.class': classFile({ name: 'a/Names', strings: ['java/lang/ProcessBuilder'] }),
				'META-INF/jars/inner.jar': await Bun.file(inner).bytes(),
			}),
		);

		expect(findings.capabilities.exec).toEqual({ 'a/Names.class': ['"java.lang.ProcessBuilder" by name'] });
	});

	test('the name of a granting class is not a finding in a jar that looks nothing up by name', async () => {
		expect((await scanOne({ strings: ['java.lang.Runtime'] })).capabilities).toEqual({});
	});

	test('a string that names a property every object has is not mistaken for a granting class', async () => {
		const findings = await scanOne({
			members: ['java/lang/Class.forName'],
			strings: ['__proto__', 'constructor', 'toString'],
		});

		expect(findings.capabilities).toEqual({});
	});

	test('a lookup by name finds nothing when the names it could reach grant nothing', async () => {
		expect(
			(await scanOne({ members: ['java/lang/Class.forName'], strings: ['com.example.Config'] })).capabilities,
		).toEqual({});
	});

	test('a host named like a property every object has is recorded, not taken for one, and the class is still read', async () => {
		const findings = await scanOne({
			members: ['java/lang/Runtime.exec'],
			strings: ['http://__proto__/x', 'http://constructor/y', 'https://evil.example/'],
		});

		expect(Object.keys(findings.hosts).sort()).toEqual(['__proto__', 'constructor', 'evil.example']);
		expect(findings.unreadable).toEqual([]);
		expect(findings.capabilities.exec).toEqual({ 'a/A.class': ['java/lang/Runtime.exec'] });
	});

	test('an update that names a host like constructor has gained it, whatever an older scan read back from JSON holds', () => {
		const before = JSON.parse('{"capabilities":{},"hosts":{},"unreadable":[]}');
		const after = { capabilities: {}, hosts: { constructor: ['a/A.class'] }, unreadable: [] };

		expect(gainedSince(before, after).hosts).toEqual({ constructor: ['a/A.class'] });
	});

	test('collects the hosts named in string constants', async () => {
		const findings = await scanOne({ strings: ['see https://API.Modrinth.com/v2/project and http://10.0.0.1:8080/x'] });

		expect(findings.hosts).toEqual({ 'api.modrinth.com': ['a/A.class'], '10.0.0.1': ['a/A.class'] });
	});
});

describe('jars', () => {
	test('follows nested jars and says where inside them a finding sits', async () => {
		const inner = await jar({ 'b/B.class': classFile({ name: 'b/B', members: ['java/lang/ProcessBuilder.start'] }) });
		const outer = await jar({
			'a/A.class': classFile({ name: 'a/A' }),
			'META-INF/jars/inner.jar': await Bun.file(inner).bytes(),
		});
		const findings = await scanJar(outer);

		expect(findings.classes).toBe(2);
		expect(findings.jars).toEqual(['META-INF/jars/inner.jar']);
		expect(findings.capabilities.exec).toEqual({
			'META-INF/jars/inner.jar!b/B.class': ['java/lang/ProcessBuilder.start'],
		});
	});

	test('a class that cannot be read is listed, and the rest is still scanned', async () => {
		const path = await jar({
			'a/A.class': 'not a class at all',
			'a/B.class': classFile({ name: 'a/B', members: ['java/lang/Runtime.exec'] }),
			'META-INF/jars/broken.jar': 'not a zip either',
		});
		const findings = await scanJar(path);

		expect(findings.unreadable.toSorted()).toEqual(['META-INF/jars/broken.jar', 'a/A.class']);
		expect(Object.keys(findings.capabilities.exec)).toEqual(['a/B.class']);
	});

	// Inside a nested jar too: the limit is not just another unreadable entry.
	test('refuses to finish a scan that unpacks past its limit', async () => {
		const inner = await jar({ 'b/B.class': classFile({ name: 'b/B', strings: ['x'.repeat(4096)] }) });
		const outer = await jar({ 'META-INF/jars/inner.jar': await Bun.file(inner).bytes() });

		await expect(scanJar(outer, { limit: 2048 })).rejects.toThrow('unpacks past 2048 bytes');
	});
});

describe('ender scan', () => {
	const run = async (positionals, flags = {}) => {
		const logged = spyOn(console, 'log').mockImplementation(() => {});

		try {
			const status = await scan({ positionals, flags });

			return { status, lines: logged.mock.calls.map(([line]) => line) };
		} finally {
			logged.mockRestore();
		}
	};

	test('names each capability with its evidence', async () => {
		const path = await jar({ 'a/A.class': classFile({ name: 'a/A', members: ['java/lang/Runtime.exec'] }) });
		const { status, lines } = await run([path]);

		expect(status).toBe(0);
		expect(lines).toContain('  exec         a/A.class (java/lang/Runtime.exec)');
	});

	test("shows an installed mod's author's explanation under the finding it answers, as theirs", async () => {
		const previousHome = process.env.ENDER_HOME;
		const home = await mkdtemp(join(tmpdir(), 'ender-home-'));
		const index = join(home, 'index');

		process.env.ENDER_HOME = home;

		try {
			const instances = await import('../src/instance');
			const { updateConfig } = await import('../src/config');
			const manifest = await instances.create('explained');
			const modsDir = instances.modsDir(manifest);
			const jarPath = await jar({ 'a/A.class': classFile({ name: 'a/A', members: ['java/net/Socket.<init>'] }) });

			await Bun.write(join(modsDir, 'mod.jar'), Bun.file(jarPath));
			await instances.writeLock('explained', {
				mods: [{ key: 'k', source: 'github', id: 'Author/mod', filename: 'mod.jar' }],
			});
			await Bun.write(
				join(index, 'explanations.json'),
				JSON.stringify({
					'github:Author/mod': { network: { text: 'It finds LAN games.', by: 'Author', release: '1.0' } },
				}),
			);
			await updateConfig({ index });

			const { lines } = await run(['Author/mod'], { instance: 'explained' });

			expect(lines).toContain('  network      a/A.class (java/net/Socket.<init>)');
			expect(
				lines.some(line =>
					line.includes('its author, Author, for 1.0: It finds LAN games. (their words, not checked)'),
				),
			).toBe(true);
		} finally {
			if (previousHome === undefined) delete process.env.ENDER_HOME;
			else process.env.ENDER_HOME = previousHome;
			await rm(home, { recursive: true, force: true });
		}
	});

	test('says plainly when a jar reaches none of them', async () => {
		const path = await jar({ 'a/A.class': classFile({ name: 'a/A' }) });
		const { lines } = await run([path]);

		expect(lines[0]).toEndWith('reaches none of exec, classloading, native, network, unsafe');
	});

	test('--json prints the findings keyed by path, for scripts', async () => {
		const path = await jar({ 'a/A.class': classFile({ name: 'a/A', members: ['java/net/Socket.<init>'] }) });
		const { lines } = await run([path], { json: true });

		expect(JSON.parse(lines[0])[path].capabilities).toEqual({ network: { 'a/A.class': ['java/net/Socket.<init>'] } });
	});
});

describe('the scan, as versioned', () => {
	test('says which version of the scanner read it', async () => {
		expect((await scanOne({})).version).toBe(SCANNER_VERSION);
	});

	test('finds native code through Java 22 and the libraries Minecraft provides, not only System.load', async () => {
		const findings = await scanOne({
			members: [
				'java/lang/foreign/Linker.nativeLinker',
				'org/lwjgl/system/Library.loadNative',
				'io/netty/bootstrap/Bootstrap.connect',
				'java/net/ServerSocket.<init>',
				'java/awt/Desktop.browse',
				'com/sun/tools/attach/VirtualMachine.attach',
			],
		});

		expect(findings.capabilities.native['a/A.class']).toEqual([
			'java/lang/foreign/Linker.nativeLinker',
			'org/lwjgl/system/Library.loadNative',
		]);
		expect(findings.capabilities.network['a/A.class']).toEqual([
			'io/netty/bootstrap/Bootstrap.connect',
			'java/net/ServerSocket.<init>',
		]);
		expect(findings.capabilities.exec['a/A.class']).toEqual(['java/awt/Desktop.browse']);
		expect(findings.capabilities.classloading['a/A.class']).toEqual(['com/sun/tools/attach/VirtualMachine.attach']);
	});

	test('reads hosts from websocket and ftp addresses too', async () => {
		const findings = await scanOne({ strings: ['wss://voice.example.net/room', 'ftp://files.example.org'] });

		expect(Object.keys(findings.hosts).sort()).toEqual(['files.example.org', 'voice.example.net']);
	});

	test('warns of a webhook, the session token, persistence and the clipboard, by what names each', async () => {
		const findings = await scanOne({
			members: ['net/minecraft/client/User.getAccessToken', 'java/awt/Toolkit.getSystemClipboard'],
			strings: [
				'https://discord.com/api/webhooks/1/abc',
				'\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
				'launcher_accounts.json',
			],
		});

		expect(findings.signals).toEqual({
			session: { 'a/A.class': ['net/minecraft/client/User.getAccessToken', 'launcher_accounts.json'] },
			clipboard: { 'a/A.class': ['java/awt/Toolkit.getSystemClipboard'] },
			webhook: { 'a/A.class': ['https://discord.com/api/webhooks/1/abc'] },
			persistence: { 'a/A.class': ['\\Microsoft\\Windows\\Start Menu\\Programs\\Startup'] },
		});
		expect(findings.secrets).toEqual({});
	});

	test("reads the session token by Fabric's names before Minecraft 26, and Forge's SRG names, as well", async () => {
		for (const member of [
			'net/minecraft/class_320.method_1674',
			'net/minecraft/client/User.m_92547_',
			'net/minecraft/util/Session.func_148254_d',
		]) {
			expect((await scanOne({ members: [member] })).signals.session).toEqual({ 'a/A.class': [member] });
		}
	});

	test('names where other programs keep their logins as secrets, apart from every warning', async () => {
		const findings = await scanOne({
			strings: ['\\discord\\Local Storage\\leveldb', 'Login Data', 'Exodus\\exodus.wallet', 'a login screen'],
		});

		expect(findings.secrets).toEqual({
			discord: { 'a/A.class': ['\\discord\\Local Storage\\leveldb'] },
			browser: { 'a/A.class': ['Login Data'] },
			wallet: { 'a/A.class': ['Exodus\\exodus.wallet'] },
		});
	});

	test('finds a jar or a class kept under another name, and leaves plain resources alone', async () => {
		const path = await jar({
			'a/A.class': classFile({ name: 'a/A' }),
			'assets/a/data.bin': classFile({ name: 'x/Payload' }),
			'assets/a/textures/block.png': Buffer.from('\x89PNG not code'),
			'assets/a/lang/en_us.json': '{}',
		});

		expect((await scanJar(path)).hidden).toEqual(['assets/a/data.bin']);
	});

	test('an update gaining a warning, a secret or hidden code is news, as a capability is', () => {
		const before = { capabilities: {}, signals: {}, secrets: {}, hidden: [], hosts: {}, unreadable: [] };
		const after = {
			capabilities: {},
			signals: { webhook: { 'a/A.class': ['https://discord.com/api/webhooks/1'] } },
			secrets: { discord: { 'a/A.class': ['Local Storage/leveldb'] } },
			hidden: ['data.bin'],
			hosts: {},
			unreadable: [],
		};

		expect(gainedSince(before, after)).toMatchObject({
			signals: after.signals,
			secrets: after.secrets,
			hidden: ['data.bin'],
		});
		expect(gainedSince({ capabilities: {}, hosts: {}, unreadable: [] }, before)).toMatchObject({
			signals: {},
			hidden: [],
		});
	});
});

describe('where a call is', () => {
	test('names the method each call is made in', async () => {
		const findings = await scanOne({ code: { checkForUpdates: ['java/net/http/HttpClient.send'] } });

		expect(findings.capabilities.network['a/A.class']).toEqual(['java/net/http/HttpClient.send in checkForUpdates']);
	});

	test('warns of a Fabric entry point reaching anything in its static initializer, which runs as the class loads', async () => {
		const path = await jar({
			'fabric.mod.json': JSON.stringify({ entrypoints: { main: ['a.Main'], client: [{ value: 'a.Other::init' }] } }),
			'a/Main.class': classFile({ name: 'a/Main', code: { '<clinit>': ['java/net/URLClassLoader.<init>'] } }),
			'a/Plain.class': classFile({ name: 'a/Plain', code: { '<clinit>': ['java/net/URLClassLoader.<init>'] } }),
		});
		const findings = await scanJar(path);

		expect(findings.signals.initializer).toEqual({ 'a/Main.class': ['java/net/URLClassLoader.<init> in <clinit>'] });
	});

	test("warns the same of a NeoForge mod's main class, found by its annotation", async () => {
		const findings = await scanOne({
			annotations: ['Lnet/neoforged/fml/common/Mod;'],
			code: { '<clinit>': ['java/lang/Runtime.exec'] },
		});

		expect(findings.signals.initializer).toEqual({ 'a/A.class': ['java/lang/Runtime.exec in <clinit>'] });
	});

	test('reads the entry points a Quilt mod names, and none from metadata that does not parse', () => {
		expect(entryClasses(JSON.stringify({ quilt_loader: { entrypoints: { init: 'a.b.Init' } } }))).toEqual([
			'a/b/Init.class',
		]);
		expect(entryClasses('{ not json')).toEqual([]);
	});
});

describe('an archive read two ways', () => {
	const named = classFile({ name: 'a/A' });

	test('warns of an entry named twice, and a class in the file its directory does not list', async () => {
		const path = join(directory, 'tricked.jar');

		await Bun.write(
			path,
			rawZip(
				[
					['a/A.class', named],
					['a/A.class', named],
					['x/Payload.class', classFile({ name: 'x/Payload' })],
				],
				{ unlisted: ['x/Payload.class'] },
			),
		);

		expect((await scanJar(path)).signals.zip).toEqual({
			'(the jar)': ['a/A.class is named twice', 'x/Payload.class is in the file but not in its directory'],
		});
	});

	test("takes no notice of the headers inside a jar it carries stored, which are the inner jar's own", async () => {
		const path = join(directory, 'carrier.jar');

		await Bun.write(path, rawZip({ 'a/A.class': named, 'META-INF/jars/lib.jar': rawZip({ 'b/B.class': named }) }));

		expect((await scanJar(path)).signals.zip).toBeUndefined();
	});
});

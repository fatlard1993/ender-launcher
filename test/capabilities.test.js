import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { scanJar } from '../src/mods/capabilities';
import { readClass } from '../src/mods/classfile';
import { classFile, jar as jarIn } from './jars';

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

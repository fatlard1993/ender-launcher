import { zipEntries } from '../archive';
import { readClass } from './classfile';

/**
 * What a jar's code can reach, by the references that grant it: a bare class name covers every
 * member of that class, and `owner.member` covers that member alone.
 */
export const CAPABILITIES = {
	exec: ['java/lang/Runtime.exec', 'java/lang/ProcessBuilder'],
	classloading: [
		'java/lang/ClassLoader.defineClass',
		'java/security/SecureClassLoader.defineClass',
		'java/net/URLClassLoader',
		'java/lang/invoke/MethodHandles$Lookup.defineClass',
		'java/lang/invoke/MethodHandles$Lookup.defineHiddenClass',
	],
	native: [
		'java/lang/System.load',
		'java/lang/System.loadLibrary',
		'java/lang/Runtime.load',
		'java/lang/Runtime.loadLibrary',
	],
	network: [
		'java/net/URL.openConnection',
		'java/net/URL.openStream',
		'java/net/Socket',
		'java/net/DatagramSocket',
		'java/net/http/HttpClient',
		'java/nio/channels/SocketChannel',
	],
	unsafe: ['sun/misc/Unsafe', 'jdk/internal/misc/Unsafe'],
};

/** A subclass calls defineClass on itself, so the call names the subclass and only the superclass gives it away. */
const LOADERS = new Set(['java/lang/ClassLoader', 'java/security/SecureClassLoader', 'java/net/URLClassLoader']);

const URL_HOST = /\bhttps?:\/\/([\w.-]+)/gi;

const DEFAULT_LIMIT = 512 * 1024 * 1024;

const NESTING = 4;

const grants = (reference, rule) => reference === rule || reference.startsWith(`${rule}.`);

/**
 * Scan a jar for what its code can reach, following jars nested inside it. Findings are evidence,
 * not a verdict. Capabilities map each class that has one (`inner.jar!a/B.class` inside a nested
 * jar) to the references that granted it, and hosts map each URL host to the classes naming it.
 */
export const scanJar = async (path, { limit = DEFAULT_LIMIT } = {}) => {
	const findings = { classes: 0, jars: [], capabilities: {}, hosts: {}, unreadable: [] };
	let remaining = limit;

	const read = (entry, where) => {
		let bytes;

		try {
			bytes = entry.read(remaining);
		} catch (error) {
			if (error.code !== 'ERR_BUFFER_TOO_LARGE') throw error;

			throw Object.assign(new Error(`${path} unpacks past ${limit} bytes at ${where}; not scanned`), {
				code: 'SCAN_LIMIT',
			});
		}

		remaining -= bytes.length;

		return bytes;
	};

	const note = (record, key, value) => {
		const list = (record[key] ??= []);

		if (!list.includes(value)) list.push(value);
	};

	const inspect = (parsed, where) => {
		for (const [capability, rules] of Object.entries(CAPABILITIES)) {
			const matched = parsed.references.filter(reference => rules.some(rule => grants(reference, rule)));

			for (const reference of matched) {
				if (!matched.some(other => other.startsWith(`${reference}.`))) {
					note((findings.capabilities[capability] ??= {}), where, reference);
				}
			}
		}

		if (LOADERS.has(parsed.superName)) {
			note((findings.capabilities.classloading ??= {}), where, `extends ${parsed.superName}`);
		}

		for (const string of parsed.strings) {
			for (const [, host] of string.matchAll(URL_HOST)) note(findings.hosts, host.toLowerCase(), where);
		}
	};

	const walk = (buffer, prefix, depth) => {
		for (const entry of zipEntries(buffer)) {
			const where = `${prefix}${entry.name}`;
			const isClass = entry.name.endsWith('.class');
			const isJar = entry.name.endsWith('.jar');

			if (!isClass && !isJar) continue;

			if (isJar) findings.jars.push(where);

			try {
				if (isJar && depth >= NESTING) throw new Error('nested too deep');

				const bytes = read(entry, where);

				if (isJar) walk(bytes, `${where}!`, depth + 1);
				else {
					inspect(readClass(bytes), where);

					++findings.classes;
				}
			} catch (error) {
				if (error.code === 'SCAN_LIMIT') throw error;

				findings.unreadable.push(where);
			}
		}
	};

	walk(Buffer.from(await Bun.file(path).arrayBuffer()), '', 0);

	return findings;
};

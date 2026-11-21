import { zipEntries } from '../archive';
import { readClass } from './classfile';
import { SCANNER_VERSION } from './scannerVersion';

export { SCANNER_VERSION };

/**
 * What a jar's code can reach, by the references that grant it: a bare class name covers every
 * member of that class, and `owner.member` covers that member alone.
 */
export const CAPABILITIES = {
	exec: [
		'java/lang/Runtime.exec',
		'java/lang/ProcessBuilder',
		'java/awt/Desktop.browse',
		'java/awt/Desktop.open',
		'java/awt/Desktop.edit',
	],
	classloading: [
		'java/lang/ClassLoader.defineClass',
		'java/security/SecureClassLoader.defineClass',
		'java/net/URLClassLoader',
		'java/lang/invoke/MethodHandles$Lookup.defineClass',
		'java/lang/invoke/MethodHandles$Lookup.defineHiddenClass',
		'java/lang/instrument/Instrumentation',
		'com/sun/tools/attach/VirtualMachine',
		'javax/script/ScriptEngineManager',
	],
	native: [
		'java/lang/System.load',
		'java/lang/System.loadLibrary',
		'java/lang/Runtime.load',
		'java/lang/Runtime.loadLibrary',
		'java/lang/foreign/Linker',
		'java/lang/foreign/SymbolLookup.libraryLookup',
		'com/sun/jna/Native',
		'com/sun/jna/NativeLibrary',
		'org/lwjgl/system/Library.loadNative',
		'org/lwjgl/system/Library.loadSystem',
	],
	network: [
		'java/net/URL.openConnection',
		'java/net/URL.openStream',
		'java/net/Socket',
		'java/net/DatagramSocket',
		'java/net/http/HttpClient',
		'java/net/URL.getContent',
		'java/net/ServerSocket',
		'java/net/MulticastSocket',
		'java/nio/channels/SocketChannel',
		'java/nio/channels/ServerSocketChannel',
		'java/nio/channels/DatagramChannel',
		'java/nio/channels/AsynchronousSocketChannel',
		'java/nio/channels/AsynchronousServerSocketChannel',
		'com/sun/net/httpserver/HttpServer',
		'io/netty/bootstrap/Bootstrap',
		'io/netty/bootstrap/ServerBootstrap',
	],
	unsafe: ['sun/misc/Unsafe', 'jdk/internal/misc/Unsafe'],
};

/** A subclass calls defineClass on itself, so the call names the subclass and only the superclass gives it away. */
const LOADERS = new Set(['java/lang/ClassLoader', 'java/security/SecureClassLoader', 'java/net/URLClassLoader']);

/** Calls that reach a class by a name given as a string, which hides it from the references above. */
const BY_NAME = [
	'java/lang/Class.forName',
	'java/lang/ClassLoader.loadClass',
	'java/lang/invoke/MethodHandles$Lookup.findClass',
];

/** Each granting class as a string would name it, with the capabilities it grants. */
const NAMED = new Map();

for (const [capability, rules] of Object.entries(CAPABILITIES)) {
	for (const rule of rules) {
		const owner = rule.split('.')[0].replaceAll('/', '.');

		NAMED.set(owner, [...new Set([...(NAMED.get(owner) ?? []), capability])]);
	}
}

const URL_HOST = /\b(?:https?|wss?|ftp):\/\/([\w.-]+)/gi;

/**
 * What code can do that has an innocent reason as often as not, so each is a warning to weigh, not a verdict: by the
 * references that grant it, or the strings that name it. Strings are matched in lower case, with backslashes as slashes.
 */
export const SIGNALS = {
	webhook: { strings: [/discord(app)?\.com\/api\/webhooks/, /api\.telegram\.org\/bot/] },
	session: {
		references: [
			'net/minecraft/client/User.getAccessToken',
			'net/minecraft/client/User.getSessionId',
			'net/minecraft/class_320.method_1674',
			'net/minecraft/class_320.method_1675',
			// Forge 1.17 to 1.20.4 runs Mojang's class names with SRG member names, and before 1.17 SRG names throughout
			'net/minecraft/client/User.m_92547_',
			'net/minecraft/client/User.m_92544_',
			'net/minecraft/util/Session.func_148254_d',
			'net/minecraft/util/Session.func_111286_b',
		],
		strings: [/(^|\/)launcher_accounts(_microsoft_store)?\.json$/],
	},
	persistence: {
		strings: [
			/start menu\/programs\/startup/,
			/currentversion\/run(once)?($|\/)/,
			/\.config\/autostart/,
			/systemd\/user/,
			/library\/launchagents/,
		],
	},
	clipboard: { references: ['java/awt/Toolkit.getSystemClipboard', 'java/awt/datatransfer/Clipboard'] },
	// Found apart, by where a call is rather than what it is: a mod's entry point reaching anything in its static
	// initializer, and an archive the zip tools and the game would read differently
	initializer: {},
	zip: {},
};

/**
 * Where other programs keep what lets someone sign in as their user: saved logins, session tokens, wallets. No mod has
 * a reason to name these, so a jar that does is held back until its player allows it by its hash.
 */
export const SECRETS = {
	discord: [/discord(canary|ptb)?\/local storage/, /local storage\/leveldb/],
	browser: [
		/(^|\/)(login data|web data|login data for account)$/,
		/os_crypt/,
		/(^|\/)(logins\.json|key4\.db|cookies\.sqlite)$/,
		/google\/chrome\/user data/,
		/microsoft\/edge\/user data/,
		/bravesoftware\/brave-browser/,
		/mozilla\/firefox\/profiles/,
	],
	wallet: [/wallet\.dat/, /exodus\.wallet/, /electrum\/wallets/, /nkbihfbeogaeaoehlefnkodbefgpgknn/],
	telegram: [/telegram desktop\/tdata/],
	steam: [/loginusers\.vdf/],
};

/** Files a mod carries that are what they are named: an entry of any other name holding a jar or class is hidden code. */
const PLAIN_FILES =
	/\.(png|jpe?g|gif|webp|svg|ogg|wav|mp3|json|json5|mcmeta|lang|txt|md|nbt|snbt|glsl|fsh|vsh|csh|toml|properties|cfg|yml|yaml|xml|html|css|js|ttf|otf|obj|mtl|bbmodel|accesswidener|classtweaker|mf|sf|rsa|dsa|ec|kotlin_module|kotlin_builtins|so|dll|dylib|jnilib|zip)$/i;

const HIDDEN_LIMIT = 64 * 1024 * 1024;

/** The classes a Fabric or Quilt mod's metadata names as its entry points, as paths inside the jar. */
export const entryClasses = text => {
	let metadata;

	try {
		metadata = JSON.parse(text);
	} catch {
		return [];
	}

	const entrypoints = metadata.entrypoints ?? metadata.quilt_loader?.entrypoints ?? {};

	return Object.values(entrypoints)
		.flat()
		.map(entry => (typeof entry === 'string' ? entry : entry?.value))
		.filter(value => typeof value === 'string')
		.map(value => `${value.split('::')[0].replaceAll('.', '/')}.class`);
};

const ZIP_ENTRY = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * What in an archive two readers would disagree about: an entry named twice, which tools settle differently, and a
 * jar or class in a local header the central directory does not list, which a reader going through the file entry by
 * entry finds and one using the directory, as this scan does, does not.
 */
export const zipTricks = (buffer, entries) => {
	const tricks = [];
	const listed = new Set();
	const spans = entries.map(({ span }) => span).filter(Boolean);
	const insideAnother = at => spans.some(([start, end]) => at > start && at < end);

	for (const { name } of entries) {
		if (listed.has(name)) tricks.push(`${name} is named twice`);
		listed.add(name);
	}

	for (let at = buffer.indexOf(ZIP_ENTRY); at !== -1; at = buffer.indexOf(ZIP_ENTRY, at + 4)) {
		if (at + 30 > buffer.length) break;
		if (insideAnother(at)) continue;

		const length = buffer.readUInt16LE(at + 26);
		const name = buffer.toString('utf8', at + 30, at + 30 + length);

		if (
			length > 0 &&
			length < 1024 &&
			/\.(class|jar)$/.test(name) &&
			![...name].some(character => character < ' ') &&
			!listed.has(name)
		) {
			tricks.push(`${name} is in the file but not in its directory`);
			listed.add(name);
		}
	}

	return tricks;
};

const looksLikeCode = bytes =>
	bytes.length >= 4 &&
	((bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) ||
		bytes.readUInt32BE(0) === 0xca_fe_ba_be);

const DEFAULT_LIMIT = 512 * 1024 * 1024;

const NESTING = 4;

/** Each rule to the capabilities it grants. */
const RULES = new Map();

for (const [capability, rules] of Object.entries(CAPABILITIES)) {
	for (const rule of rules) RULES.set(rule, [...(RULES.get(rule) ?? []), capability]);
}

/** The capabilities a reference is granted by: a rule naming it whole, or naming what comes before one of its dots. */
const grantedTo = reference => {
	const granted = new Set(RULES.get(reference));

	for (let dot = reference.indexOf('.'); dot !== -1; dot = reference.indexOf('.', dot + 1)) {
		for (const capability of RULES.get(reference.slice(0, dot)) ?? []) granted.add(capability);
	}

	return granted;
};

/**
 * Scan a jar for what its code can reach, following jars nested inside it. Findings are evidence,
 * not a verdict. Capabilities map each class that has one (`inner.jar!a/B.class` inside a nested
 * jar) to the references that granted it, and hosts map each URL host to the classes naming it.
 */
export const scanJar = async (path, { limit = DEFAULT_LIMIT } = {}) => {
	const findings = {
		version: SCANNER_VERSION,
		classes: 0,
		jars: [],
		capabilities: {},
		signals: {},
		secrets: {},
		hidden: [],
		hosts: Object.create(null),
		unreadable: [],
	};
	const named = [];
	let looksUp = false;
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

	/** Whether an entry named as something else holds a jar or a class; one past the hidden limit is left unread. */
	const hidesCode = entry => {
		try {
			const bytes = entry.read(Math.min(HIDDEN_LIMIT, remaining));

			remaining -= bytes.length;

			return looksLikeCode(bytes);
		} catch {
			return false;
		}
	};

	const note = (record, key, value) => {
		const list = (record[key] ??= []);

		if (!list.includes(value)) list.push(value);
	};

	const inspect = (parsed, where, entry) => {
		const granting = {};
		const usedIn = new Map();

		for (const [method, used] of Object.entries(parsed.methods ?? {})) {
			for (const reference of used) usedIn.set(reference, [...(usedIn.get(reference) ?? []), method]);
		}

		const said = reference =>
			usedIn.has(reference) ? `${reference} in ${usedIn.get(reference).join(', ')}` : reference;

		for (const reference of parsed.references) {
			for (const capability of grantedTo(reference)) (granting[capability] ??= []).push(reference);
		}

		for (const capability of Object.keys(CAPABILITIES)) {
			const matched = granting[capability] ?? [];

			for (const reference of matched) {
				if (!matched.some(other => other.startsWith(`${reference}.`))) {
					note((findings.capabilities[capability] ??= Object.create(null)), where, said(reference));
				}
			}
		}

		if (entry || parsed.modClass) {
			for (const reference of parsed.methods?.['<clinit>'] ?? []) {
				if (grantedTo(reference).size > 0)
					note((findings.signals.initializer ??= Object.create(null)), where, `${reference} in <clinit>`);
			}
		}

		if (LOADERS.has(parsed.superName)) {
			note((findings.capabilities.classloading ??= Object.create(null)), where, `extends ${parsed.superName}`);
		}

		if (parsed.references.some(reference => BY_NAME.includes(reference))) looksUp = true;

		for (const [signal, { references = [] }] of Object.entries(SIGNALS)) {
			for (const reference of parsed.references) {
				if (references.some(rule => reference === rule || reference.startsWith(`${rule}.`)))
					note((findings.signals[signal] ??= Object.create(null)), where, reference);
			}
		}

		for (const string of parsed.strings) {
			for (const [, host] of string.matchAll(URL_HOST)) note(findings.hosts, host.toLowerCase(), where);

			const plain = string.replaceAll('\\', '/').toLowerCase();

			for (const [signal, { strings = [] }] of Object.entries(SIGNALS)) {
				if (strings.some(pattern => pattern.test(plain)))
					note((findings.signals[signal] ??= Object.create(null)), where, string);
			}

			for (const [store, patterns] of Object.entries(SECRETS)) {
				if (patterns.some(pattern => pattern.test(plain)))
					note((findings.secrets[store] ??= Object.create(null)), where, string);
			}

			const owner = string.replace(/^\[*L(.+);$/, '$1').replaceAll('/', '.');

			if (NAMED.has(owner)) named.push({ owner, where });
		}
	};

	const walk = (buffer, prefix, depth) => {
		const entries = zipEntries(buffer);
		const metadata = entries.find(({ name }) => name === 'fabric.mod.json' || name === 'quilt.mod.json');
		let entryPoints = new Set();

		try {
			if (metadata) entryPoints = new Set(entryClasses(metadata.read(1024 * 1024).toString('utf8')));
		} catch {
			// Metadata past a megabyte, or unreadable, names no entry point the scan can trust
		}

		const tricks = zipTricks(buffer, entries);

		if (tricks.length > 0) findings.signals.zip = { ...findings.signals.zip, [prefix || '(the jar)']: tricks };

		for (const entry of entries) {
			const where = `${prefix}${entry.name}`;
			const isClass = entry.name.endsWith('.class');
			const isJar = entry.name.endsWith('.jar');

			if (!isClass && !isJar) {
				if (!PLAIN_FILES.test(entry.name) && hidesCode(entry)) findings.hidden.push(where);

				continue;
			}

			if (isJar) findings.jars.push(where);

			try {
				if (isJar && depth >= NESTING) throw new Error('nested too deep');

				const bytes = read(entry, where);

				if (isJar) walk(bytes, `${where}!`, depth + 1);
				else {
					inspect(readClass(bytes), where, entryPoints.has(entry.name));

					++findings.classes;
				}
			} catch (error) {
				if (error.code === 'SCAN_LIMIT') throw error;

				findings.unreadable.push(where);
			}
		}
	};

	walk(Buffer.from(await Bun.file(path).arrayBuffer()), '', 0);

	if (looksUp) {
		for (const { owner, where } of named) {
			for (const capability of NAMED.get(owner))
				note((findings.capabilities[capability] ??= Object.create(null)), where, `"${owner}" by name`);
		}
	}

	return findings;
};

/**
 * What a newer scan of a mod has that an older one lacked: whole capabilities and hosts, not
 * classes, since a refactor moves code between classes without the mod reaching anything new.
 * Unreadable classes count only when the older jar had none.
 */
export const gainedSince = (before, after) => {
	const fresh = (record, known) =>
		Object.fromEntries(Object.entries(record).filter(([key]) => !Object.hasOwn(known, key)));

	return {
		capabilities: fresh(after.capabilities, before.capabilities),
		signals: fresh(after.signals ?? {}, before.signals ?? {}),
		secrets: fresh(after.secrets ?? {}, before.secrets ?? {}),
		hidden: (before.hidden ?? []).length === 0 ? (after.hidden ?? []) : [],
		hosts: fresh(after.hosts, before.hosts),
		unreadable: before.unreadable.length === 0 ? after.unreadable : [],
	};
};

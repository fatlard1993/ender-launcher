import { listEntries, readEntry, zipEntries } from '../archive';

const text = async (jar, name) => (await readEntry(jar, name))?.toString('utf8');

const CONTROL = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * Parse mod metadata as JSON, and failing that, again with line breaks and tabs inside strings
 * escaped: published jars carry multi-line descriptions written raw, and the loaders read them.
 */
export const parseLeniently = source => {
	try {
		return JSON.parse(source);
	} catch (error) {
		let inString = false;
		let escaped = false;
		let repaired = '';

		for (const character of source) {
			if (inString && !escaped && CONTROL[character]) {
				repaired += CONTROL[character];

				continue;
			}

			if (character === '"' && !escaped) inString = !inString;

			escaped = character === '\\' && !escaped;
			repaired += character;
		}

		try {
			return JSON.parse(repaired);
		} catch {
			throw error;
		}
	}
};

/** A line of a jar manifest, which wraps long values onto lines that begin with a space. */
const manifestValue = (manifest, key) => {
	const unwrapped = manifest.replaceAll(/\r?\n /g, '');

	return unwrapped.match(new RegExp(`^${key}: *(.*)$`, 'm'))?.[1]?.trim();
};

/**
 * The mods a mod names besides those it needs: ones it works with (suggests), ones the loader refuses to run beside
 * it (breaks), and ones it warns about (conflicts). Each is listed only when it names any.
 */
const relations = ({ suggests = [], breaks = [], conflicts = [] }) => ({
	...(suggests.length > 0 ? { suggests: [...new Set(suggests)] } : {}),
	...(breaks.length > 0 ? { breaks: [...new Set(breaks)] } : {}),
	...(conflicts.length > 0 ? { conflicts: [...new Set(conflicts)] } : {}),
});

const fabric = (json, loader = 'fabric', bundled = []) => ({
	loader,
	id: json.id,
	version: json.version,
	name: json.name,
	description: json.description,
	minecraft: [json.depends?.minecraft].flat().filter(Boolean).join(' || ') || undefined,
	environment: json.environment ?? '*',
	depends: Object.keys(json.depends ?? {}),
	provides: [...(json.provides ?? []), ...bundled],
	...relations({
		suggests: [...Object.keys(json.recommends ?? {}), ...Object.keys(json.suggests ?? {})],
		breaks: Object.keys(json.breaks ?? {}),
		conflicts: Object.keys(json.conflicts ?? {}),
	}),
});

const quilt = (json, bundled = []) => {
	const loader = json.quilt_loader ?? {};
	const listed = dependencies =>
		(dependencies ?? []).map(dependency => (typeof dependency === 'string' ? { id: dependency } : dependency));
	const depends = listed(loader.depends);

	return {
		loader: 'quilt',
		id: loader.id,
		version: loader.version,
		name: loader.metadata?.name,
		description: loader.metadata?.description,
		minecraft:
			[depends.find(dependency => dependency.id === 'minecraft')?.versions].flat().filter(Boolean).join(' || ') ||
			undefined,
		environment: json.minecraft?.environment ?? '*',
		depends: depends.filter(dependency => !dependency.optional).map(dependency => dependency.id),
		provides: [...(loader.provides ?? []).map(provided => provided.id ?? provided), ...bundled],
		...relations({
			suggests: depends.filter(dependency => dependency.optional).map(dependency => dependency.id),
			breaks: listed(loader.breaks).map(dependency => dependency.id),
		}),
	};
};

const NESTED_LIMIT = 64 * 1024 * 1024;

/**
 * The mod ids of the jars Fabric and Quilt load from inside this one. Fabric API is one release jar
 * holding dozens of modules, and other mods depend on those modules by their own ids.
 */
const bundledIds = async (jar, entries) => {
	const ids = [];

	for (const name of entries) {
		if (!name.startsWith('META-INF/jars/') || !name.endsWith('.jar')) continue;

		try {
			for (const entry of zipEntries(await readEntry(jar, name))) {
				if (entry.name === 'fabric.mod.json') ids.push(parseLeniently(entry.read(NESTED_LIMIT).toString('utf8')).id);
				if (entry.name === 'quilt.mod.json')
					ids.push(parseLeniently(entry.read(NESTED_LIMIT).toString('utf8')).quilt_loader?.id);
			}
		} catch {
			// A nested jar that cannot be read provides nothing that can be named; the scan reports it as unreadable.
		}
	}

	return ids.filter(Boolean);
};

/** NeoForge names a dependency's kind; Forge before it said only whether one was mandatory. */
const kindOf = dependency =>
	dependency.type?.toLowerCase() ?? (dependency.mandatory === false ? 'optional' : 'required');

/**
 * Forge and NeoForge describe their mods in TOML, one jar sometimes carrying several. A version of
 * `${file.jarVersion}` is filled from the jar manifest at load time, so it is filled from there here.
 */
const toml = (source, loader, manifest) => {
	const parsed = Bun.TOML.parse(source);

	return (parsed.mods ?? []).map(mod => {
		const dependencies = parsed.dependencies?.[mod.modId] ?? [];
		const minecraft = dependencies.find(dependency => dependency.modId === 'minecraft');
		const version =
			mod.version === '${file.jarVersion}'
				? (manifestValue(manifest ?? '', 'Implementation-Version') ?? mod.version)
				: mod.version;

		return {
			loader,
			id: mod.modId,
			version,
			name: mod.displayName,
			description: mod.description?.trim(),
			minecraft: minecraft?.versionRange,
			environment: minecraft?.side?.toLowerCase() === 'client' ? 'client' : '*',
			depends: dependencies.filter(dependency => kindOf(dependency) === 'required').map(dependency => dependency.modId),
			...relations({
				suggests: dependencies
					.filter(dependency => kindOf(dependency) === 'optional')
					.map(dependency => dependency.modId),
				breaks: dependencies
					.filter(dependency => kindOf(dependency) === 'incompatible')
					.map(dependency => dependency.modId),
				conflicts: dependencies
					.filter(dependency => kindOf(dependency) === 'discouraged')
					.map(dependency => dependency.modId),
			}),
		};
	});
};

/**
 * The mods a built jar says it holds. Read from the jar rather than the source tree, because only the
 * build has filled in the version and the game versions it supports.
 */
export const readMods = async jar => {
	const entries = new Set(await listEntries(jar));
	const manifest = entries.has('META-INF/MANIFEST.MF') ? await text(jar, 'META-INF/MANIFEST.MF') : undefined;
	const bundled = await bundledIds(jar, entries);
	const mods = [];

	if (entries.has('fabric.mod.json'))
		mods.push(fabric(parseLeniently(await text(jar, 'fabric.mod.json')), 'fabric', bundled));
	if (entries.has('quilt.mod.json')) mods.push(quilt(parseLeniently(await text(jar, 'quilt.mod.json')), bundled));
	if (entries.has('META-INF/neoforge.mods.toml'))
		mods.push(...toml(await text(jar, 'META-INF/neoforge.mods.toml'), 'neoforge', manifest));
	if (entries.has('META-INF/mods.toml')) mods.push(...toml(await text(jar, 'META-INF/mods.toml'), 'forge', manifest));

	return mods;
};

/** Larger than an icon has reason to be; a jar declaring one past it is shown without. */
export const ICON_LIMIT = 256 * 1024;

/** The image formats a page shows, by their first bytes. SVG is left out: it is a document, and can carry script. */
const IMAGE_TYPES = {
	png: bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
	jpg: bytes => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
	gif: bytes => bytes.subarray(0, 4).toString('latin1') === 'GIF8',
	webp: bytes =>
		bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
};

/** Fabric and Quilt give one icon or several by width; the smallest at least 64 wide reads well in a list. */
const iconBySize = icon => {
	if (typeof icon === 'string') return [icon];
	if (icon === null || typeof icon !== 'object') return [];

	const sizes = Object.keys(icon)
		.map(Number)
		.filter(Number.isFinite)
		.sort((a, b) => a - b);
	const chosen = sizes.find(size => size >= 64) ?? sizes.at(-1);

	return chosen === undefined ? [] : [icon[chosen]];
};

const declaredIcons = async (jar, entries) => {
	const paths = [];

	if (entries.has('fabric.mod.json'))
		paths.push(...iconBySize(parseLeniently(await text(jar, 'fabric.mod.json')).icon));
	if (entries.has('quilt.mod.json'))
		paths.push(...iconBySize(parseLeniently(await text(jar, 'quilt.mod.json')).quilt_loader?.metadata?.icon));

	for (const name of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']) {
		if (!entries.has(name)) continue;

		const parsed = Bun.TOML.parse(await text(jar, name));

		paths.push(...(parsed.mods ?? []).map(mod => mod.logoFile), parsed.logoFile);
	}

	return paths.filter(path => typeof path === 'string').map(path => path.replace(/^\.?\/+/, ''));
};

/** The picture a jar declares for its mod, when it is an image a page can show: its format and bytes. */
export const readIcon = async jar => {
	const entries = new Set(await listEntries(jar));

	for (const path of await declaredIcons(jar, entries)) {
		if (!entries.has(path)) continue;

		let bytes;

		try {
			bytes = await readEntry(jar, path, ICON_LIMIT);
		} catch {
			continue;
		}

		const type = Object.keys(IMAGE_TYPES).find(name => IMAGE_TYPES[name](bytes));

		if (type) return { type, bytes };
	}
};

const webLink = value => {
	try {
		const url = new URL(value);

		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
	} catch {
		return undefined;
	}
};

/** A metadata object's string values that are web addresses, each with the key it was given under. */
const linksIn = object =>
	Object.entries(object ?? {})
		.map(([name, value]) => ({ name, url: typeof value === 'string' ? webLink(value) : undefined }))
		.filter(({ url }) => url !== undefined);

/**
 * The web links a jar's mods give: Fabric's and Quilt's contact entries, and the links Mod Menu shows on a mod's page,
 * which mods declare under custom.modmenu.links (Quilt's at the top as modmenu.links). Each keeps its key, which says
 * what it is for: sources, discord, modmenu.kofi.
 */
export const readLinks = async jar => {
	const entries = new Set(await listEntries(jar));
	const links = [];

	if (entries.has('fabric.mod.json')) {
		const json = parseLeniently(await text(jar, 'fabric.mod.json'));

		links.push(...linksIn(json.contact), ...linksIn(json.custom?.modmenu?.links));
	}

	if (entries.has('quilt.mod.json')) {
		const json = parseLeniently(await text(jar, 'quilt.mod.json'));

		links.push(...linksIn(json.quilt_loader?.metadata?.contact), ...linksIn(json.modmenu?.links));
	}

	const seen = new Set();

	return links.filter(({ url }) => !seen.has(url) && seen.add(url));
};

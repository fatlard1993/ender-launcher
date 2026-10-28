import { join, sep } from 'node:path';

const OUT = join(import.meta.dir, '..', 'src', 'commands', 'site.generated.js');

/** The index's built pages as a module, path -> base64, for a release to compile into ender web. */
export const siteModule = async directory => {
	const files = {};

	for (const path of [...new Bun.Glob('**/*').scanSync({ cwd: directory })].sort()) {
		files[path.split(sep).join('/')] = Buffer.from(await Bun.file(join(directory, path)).arrayBuffer()).toString(
			'base64',
		);
	}

	if (!files['index.html']) throw new Error(`${directory} has no index.html: build the index's site first`);

	return `export default ${JSON.stringify(files)};\n`;
};

if (import.meta.main) {
	const [directory] = process.argv.slice(2);

	if (!directory) throw new Error('bun scripts/embedSite.js <the index site build directory>');

	await Bun.write(OUT, await siteModule(directory));
	console.log(`Built ${directory} into ${OUT}`);
}

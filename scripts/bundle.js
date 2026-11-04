/**
 * The Ender.app a macOS disk image carries: the released binary as the bundle's executable, which starts ender web when
 * double-clicked. bun scripts/bundle.js <ender-darwin binary> <out>/Ender.app
 */
import { chmod } from 'node:fs/promises';

import { writeAppBundle } from '../src/desktop';

const [binary, app] = process.argv.slice(2);

if (!binary || !app) throw new Error('bun scripts/bundle.js <ender-darwin binary> <out>/Ender.app');

await writeAppBundle(app, {
	executable: 'ender',
	write: async path => {
		await Bun.write(path, Bun.file(binary));
		await chmod(path, 0o755);
	},
});
console.log(`Wrote ${app}`);

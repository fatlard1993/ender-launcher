/**
 * The desktop icons, drawn from assets/ender.svg: a png for Linux, an icns for macOS and an ico for Windows, each holding
 * pngs at the sizes its system asks for. Run when the svg changes: bun scripts/icons.js
 */
import { join } from 'node:path';

const ICNS_TYPES = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** An icns: its magic and length, then each png under the four letters naming its size. */
export const icns = pngs => {
	const entries = Object.entries(ICNS_TYPES)
		.filter(([size]) => pngs[size])
		.map(([size, type]) => {
			const header = Buffer.alloc(8);

			header.write(type, 0, 'latin1');
			header.writeUInt32BE(8 + pngs[size].length, 4);

			return Buffer.concat([header, pngs[size]]);
		});
	const header = Buffer.alloc(8);
	const body = Buffer.concat(entries);

	header.write('icns', 0, 'latin1');
	header.writeUInt32BE(8 + body.length, 4);

	return Buffer.concat([header, body]);
};

/** An ico: a directory of sizes, each entry pointing at its png; a width or height of 256 is written as 0. */
export const ico = pngs => {
	const sizes = ICO_SIZES.filter(size => pngs[size]);
	const header = Buffer.alloc(6);

	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(sizes.length, 4);

	let offset = 6 + 16 * sizes.length;
	const directory = sizes.map(size => {
		const entry = Buffer.alloc(16);

		entry.writeUInt8(size % 256, 0);
		entry.writeUInt8(size % 256, 1);
		entry.writeUInt16LE(1, 4);
		entry.writeUInt16LE(32, 6);
		entry.writeUInt32LE(pngs[size].length, 8);
		entry.writeUInt32LE(offset, 12);
		offset += pngs[size].length;

		return entry;
	});

	return Buffer.concat([header, ...directory, ...sizes.map(size => pngs[size])]);
};

const render = async (svg, size) => {
	const drawn = Bun.spawn(['rsvg-convert', '-w', String(size), '-h', String(size), svg], { stdout: 'pipe' });
	const png = Buffer.from(await new Response(drawn.stdout).arrayBuffer());

	if ((await drawn.exited) !== 0) throw new Error(`rsvg-convert could not draw ${svg} at ${size}px`);

	return png;
};

if (import.meta.main) {
	const svg = join(import.meta.dir, '..', 'assets', 'ender.svg');
	const sizes = [...new Set([...Object.keys(ICNS_TYPES).map(Number), ...ICO_SIZES])];
	const pngs = Object.fromEntries(await Promise.all(sizes.map(async size => [size, await render(svg, size)])));
	const out = name => join(import.meta.dir, '..', 'assets', name);

	await Bun.write(out('ender.png'), pngs[512]);
	await Bun.write(out('ender.icns'), icns(pngs));
	await Bun.write(out('ender.ico'), ico(pngs));
	console.log('Wrote assets/ender.png, ender.icns and ender.ico');
}

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const readJson = async (path, fallback) => {
	const file = Bun.file(path);

	if (!(await file.exists())) {
		if (fallback === undefined) throw new Error(`No such file: ${path}`);

		return structuredClone(fallback);
	}

	return await file.json();
};

let writes = 0;

/**
 * Write via a temp file and rename, so an interrupted write cannot leave a half-parsed manifest behind. Each write has
 * a temp file of its own: two at once to one file, as concurrent resolutions make, would otherwise rename one away.
 */
export const writeText = async (path, text) => {
	await mkdir(dirname(path), { recursive: true });

	const temporary = `${path}.${process.pid}.${(writes += 1)}.tmp`;

	await writeFile(temporary, text);
	await rename(temporary, path);
};

export const writeJson = (path, value) => writeText(path, `${JSON.stringify(value, undefined, '\t')}\n`);

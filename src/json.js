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

/** Write via a temp file and rename, so an interrupted write cannot leave a half-parsed manifest behind. */
export const writeText = async (path, text) => {
	await mkdir(dirname(path), { recursive: true });

	const temporary = `${path}.${process.pid}.tmp`;

	await writeFile(temporary, text);
	await rename(temporary, path);
};

export const writeJson = (path, value) => writeText(path, `${JSON.stringify(value, undefined, '\t')}\n`);

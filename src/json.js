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

/** Each file's writes in this process, one after another: Windows refuses a rename onto a file another is renaming onto. */
const writing = new Map();

/**
 * Write via a temp file and rename, so an interrupted write cannot leave a half-parsed manifest behind. Two writes to
 * one file at once, as concurrent resolutions make, wait their turn, each through a temp file of its own.
 */
export const writeText = (path, text) => {
	const write = async () => {
		await mkdir(dirname(path), { recursive: true });

		const temporary = `${path}.${process.pid}.${(writes += 1)}.tmp`;

		await writeFile(temporary, text);
		await rename(temporary, path);
	};
	const turn = (writing.get(path) ?? Promise.resolve()).then(write, write);
	const settled = turn.then(
		() => undefined,
		() => undefined,
	);

	writing.set(path, settled);
	settled.then(() => writing.get(path) === settled && writing.delete(path));

	return turn;
};

export const writeJson = (path, value) => writeText(path, `${JSON.stringify(value, undefined, '\t')}\n`);

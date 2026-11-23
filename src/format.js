import { warn } from './out';

const said = new Set();

/**
 * Say, once for each file, that it was written in a newer format than this ender reads. It is read anyway, as fields
 * are added without raising a format: a raise means something this ender relies on may have changed meaning.
 */
export const sayIfNewer = ({ file, kind, format, reads }) => {
	if (!(format > reads) || said.has(file)) return;

	said.add(file);
	warn(
		`${file} is ${kind} format ${format}, and this ender reads format ${reads}: ender upgrade reads it as it was meant`,
	);
};

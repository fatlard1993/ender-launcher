// A coordinate arrives inside a loader profile, so every segment of it is remote input on its way
// into a path. Anything that could climb out of the repository root is refused rather than cleaned.
const UNSAFE = /[/\\]|^\.{1,2}$|^\s*$/;

const safe = (segment, coordinate) => {
	if (segment === undefined || UNSAFE.test(segment)) {
		throw new Error(`Unusable maven coordinate "${coordinate}"`);
	}

	return segment;
};

/** Turn a maven coordinate (`group:artifact:version[:classifier][@ext]`) into its repository path. */
export const coordinateToPath = coordinate => {
	const [withoutExtension, extension = 'jar'] = String(coordinate).split('@');
	const [group, artifact, version, classifier] = withoutExtension.split(':');

	safe(group, coordinate);
	safe(artifact, coordinate);
	safe(version, coordinate);

	if (classifier !== undefined) safe(classifier, coordinate);

	safe(extension, coordinate);

	const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${extension}`;

	return `${group
		.split('.')
		.map(part => safe(part, coordinate))
		.join('/')}/${artifact}/${version}/${fileName}`;
};

export const coordinateToUrl = (coordinate, repository) =>
	`${repository.replace(/\/$/, '')}/${coordinateToPath(coordinate)}`;

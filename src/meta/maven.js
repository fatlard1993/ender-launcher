/** Turn a maven coordinate (`group:artifact:version[:classifier][@ext]`) into its repository path. */
export const coordinateToPath = coordinate => {
	const [withoutExtension, extension = 'jar'] = coordinate.split('@');
	const [group, artifact, version, classifier] = withoutExtension.split(':');

	const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${extension}`;

	return `${group.replaceAll('.', '/')}/${artifact}/${version}/${fileName}`;
};

export const coordinateToUrl = (coordinate, repository) =>
	`${repository.replace(/\/$/, '')}/${coordinateToPath(coordinate)}`;

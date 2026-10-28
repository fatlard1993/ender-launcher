const OPENERS = { darwin: ['open'], win32: ['cmd', '/c', 'start', ''] };

/** Open a page in the system's browser; false when none opened, so the caller can print where it is instead. */
export const openInBrowser = async url => {
	try {
		const opened = Bun.spawn([...(OPENERS[process.platform] ?? ['xdg-open']), url], {
			stdout: 'ignore',
			stderr: 'ignore',
		});

		return (await opened.exited) === 0;
	} catch {
		return false;
	}
};

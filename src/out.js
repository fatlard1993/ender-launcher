import Log from 'log';

const supportsColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;

const code = (open, close) => text => (supportsColor ? `\u001B[${open}m${text}\u001B[${close}m` : String(text));

export const paint = {
	bold: code(1, 22),
	dim: code(2, 22),
	red: code(31, 39),
	green: code(32, 39),
	yellow: code(33, 39),
	blue: code(34, 39),
	magenta: code(35, 39),
	cyan: code(36, 39),
};

// `log` prepends its reset code unconditionally, so the reset is blanked rather than the colour
// flag trusted. Colour here is decided by `paint`, which knows whether anyone is watching a tty.
export const log = new Log({
	tag: 'ender',
	silentTag: true,
	verbosity: 1,
	color: false,
	colorMap: { __reset: '' },
});

/** Raise the gate so `log(1)(...)` style verbose lines become visible. */
export const setVerbosity = verbosity => {
	log.options.verbosity = verbosity;
};

export const info = (...args) => console.log(...args);

export const detail = (...args) => log(1)(paint.dim(args.join(' ')));

export const step = message => console.log(`${paint.cyan('::')} ${message}`);

export const done = message => console.log(`${paint.green('ok')} ${message}`);

export const warn = message => console.warn(`${paint.yellow('!!')} ${message}`);

export const fail = message => console.error(`${paint.red('xx')} ${message}`);

/** A single rewritten line, so a thousand downloads do not become a thousand lines of scrollback. */
export const progress = () => {
	const live = Boolean(process.stderr.isTTY);
	let width = 0;

	return {
		update(message) {
			if (!live) return;

			process.stderr.write(`\r${message.padEnd(width)}`);

			width = Math.max(width, message.length);
		},
		clear() {
			if (!live || width === 0) return;

			process.stderr.write(`\r${' '.repeat(width)}\r`);

			width = 0;
		},
	};
};

export const plural = (count, word, suffix = 's') => `${count} ${word}${count === 1 ? '' : suffix}`;

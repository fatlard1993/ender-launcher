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

export const QUIET_PROGRESS_EVERY = 2000;

/**
 * A single rewritten line on a terminal, so a thousand downloads do not become a thousand lines of scrollback. Without
 * one, as when ender web runs it, a line at most every two seconds and a last one at the end, so a long download is
 * seen moving; a step that finishes sooner says nothing.
 */
export const progress = ({
	live = Boolean(process.stderr.isTTY),
	now = Date.now,
	write = text => process.stderr.write(text),
} = {}) => {
	let width = 0;
	let last = now();
	let latest;
	let printed;

	return {
		update(message) {
			latest = message;

			if (live) {
				write(`\r${message.padEnd(width)}`);
				width = Math.max(width, message.length);

				return;
			}

			if (now() - last < QUIET_PROGRESS_EVERY) return;

			write(`${message}\n`);
			last = now();
			printed = message;
		},
		clear() {
			if (!live) {
				if (printed !== undefined && latest !== printed) write(`${latest}\n`);

				printed = undefined;

				return;
			}

			if (width === 0) return;

			write(`\r${' '.repeat(width)}\r`);

			width = 0;
		},
	};
};

export const plural = (count, word, suffix = 's') => `${count} ${word}${count === 1 ? '' : suffix}`;

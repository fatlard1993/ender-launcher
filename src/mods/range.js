const VERSION = /^(\d+(?:\.\d+)*)(?:-(.*))?$/;

/** `26.4-` is the lowest prerelease of 26.4, which is how Fabric writes "below every 26.4". */
const parse = text => {
	const match = VERSION.exec(text.trim());

	return match && { release: match[1].split('.').map(Number), pre: match[2] };
};

const comparePre = (a, b) => {
	if (a === b) return 0;
	if (a === undefined) return 1;
	if (b === undefined) return -1;

	const left = a.split('.');
	const right = b.split('.');

	for (let index = 0; index < Math.max(left.length, right.length); ++index) {
		const [x, y] = [left[index], right[index]];

		if (x === y) continue;
		if (x === undefined || x === '') return -1;
		if (y === undefined || y === '') return 1;

		const [m, n] = [Number(x), Number(y)];

		if (Number.isInteger(m) && Number.isInteger(n)) return m - n;
		if (Number.isInteger(m)) return -1;
		if (Number.isInteger(n)) return 1;

		return x < y ? -1 : 1;
	}

	return 0;
};

export const compareVersions = (a, b) => {
	for (let index = 0; index < Math.max(a.release.length, b.release.length); ++index) {
		const difference = (a.release[index] ?? 0) - (b.release[index] ?? 0);

		if (difference !== 0) return difference;
	}

	return comparePre(a.pre, b.pre);
};

const bump = (release, position) => ({ release: [...release.slice(0, position), release[position] + 1], pre: '' });

/** One Fabric comparator: `>=1.2`, `~26.3`, `^1.2`, `1.21.x`, `*`, or a bare exact version. */
const fabricTerm = (version, term) => {
	if (term === '*') return true;

	const [, operator, operand] = /^(>=|<=|>|<|=|~|\^)?(.*)$/.exec(term);

	if (/(^|\.)[x*X]$/.test(operand)) {
		const prefix = parse(operand.replace(/\.[x*X]$/, ''));

		return prefix ? prefix.release.every((segment, index) => version.release[index] === segment) : undefined;
	}

	const target = parse(operand);

	if (target === null) return undefined;

	const order = compareVersions(version, target);

	switch (operator) {
		case '>=': {
			return order >= 0;
		}
		case '<=': {
			return order <= 0;
		}
		case '>': {
			return order > 0;
		}
		case '<': {
			return order < 0;
		}
		case '~': {
			return order >= 0 && compareVersions(version, bump(target.release, Math.min(1, target.release.length - 1))) < 0;
		}
		case '^': {
			return order >= 0 && compareVersions(version, bump(target.release, 0)) < 0;
		}
		default: {
			return order === 0;
		}
	}
};

const fabric = (version, range) => {
	const alternatives = range.split('||').map(alternative => {
		const terms = alternative
			.trim()
			.replaceAll(/([<>=~^]+)\s+/g, '$1')
			.split(/\s+/)
			.filter(Boolean);
		const results = terms.map(term => fabricTerm(version, term));

		if (results.includes(false)) return false;

		return results.includes(undefined) ? undefined : true;
	});

	if (alternatives.includes(true)) return true;

	return alternatives.includes(undefined) ? undefined : false;
};

/** Maven ranges, as Forge and NeoForge write them: `[1.21.1,1.21.2)`, `[26.1,)`, `(,1.20]`, `[1.20]`, unions of these. */
const maven = (version, range) => {
	return [...range.matchAll(/([[(])([^\])]*)([\])])/g)].some(([, open, body, close]) => {
		const [low, high = low] = body.split(',').map(bound => bound.trim());
		const lower = low === '' ? undefined : parse(low);
		const upper = high === '' ? undefined : parse(high);

		if (lower === null || upper === null) return false;
		if (lower && (open === '[' ? compareVersions(version, lower) < 0 : compareVersions(version, lower) <= 0))
			return false;
		if (upper && (close === ']' ? compareVersions(version, upper) > 0 : compareVersions(version, upper) >= 0))
			return false;

		return true;
	});
};

/**
 * Whether a game version falls in the range a mod declares: true, false, or undefined when either
 * cannot be read, which callers treat as a weaker match than true rather than as a refusal.
 */
export const satisfies = (version, range) => {
	if (typeof range !== 'string' || range.trim() === '') return undefined;

	const parsed = parse(version);

	if (parsed === null) return undefined;

	return /^\s*[[(]/.test(range) ? maven(parsed, range) : fabric(parsed, range);
};

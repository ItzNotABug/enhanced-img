import path from 'node:path';

const OPTION_NAMES = new Set(['dynamic']);

/**
 * @typedef {{ dynamic?: readonly string[] }} NormalizedEnhancedImagesOptions
 */

/**
 * Validate the public plugin options without consulting Vite configuration.
 * Filesystem-relative validation is deliberately deferred until Vite has
 * resolved its root.
 *
 * @param {unknown} [options]
 * @returns {Readonly<NormalizedEnhancedImagesOptions>}
 */
export function normalize_options(options) {
	if (options === undefined) return Object.freeze({});

	if (!is_plain_object(options)) {
		throw option_error('options must be an object');
	}

	for (const key of Reflect.ownKeys(options)) {
		if (typeof key !== 'string' || !OPTION_NAMES.has(key)) {
			throw option_error(`unknown option ${JSON.stringify(String(key))}; expected "dynamic"`);
		}
	}

	if (!Object.hasOwn(options, 'dynamic') || options.dynamic === undefined) {
		return Object.freeze({});
	}

	const input = typeof options.dynamic === 'string' ? [options.dynamic] : options.dynamic;
	if (!Array.isArray(input)) {
		throw option_error('"dynamic" must be a glob string or an array of glob strings');
	}
	if (input.length === 0) {
		throw option_error('"dynamic" must contain at least one positive glob pattern');
	}

	/** @type {string[]} */
	const patterns = [];
	let positive_count = 0;
	for (const [index, value] of input.entries()) {
		if (typeof value !== 'string') {
			throw option_error(`"dynamic[${index}]" must be a string`);
		}

		// Configuration is the only place where Windows separators are accepted.
		const pattern = value.replaceAll('\\', '/');
		if (pattern.length === 0 || pattern === '!') {
			throw option_error(`"dynamic[${index}]" must not be empty`);
		}

		const negative = is_negative_pattern(pattern);
		if (negative && positive_count === 0) {
			throw option_error(
				`negative "dynamic[${index}]" pattern must follow at least one positive pattern`
			);
		}

		patterns.push(pattern);
		if (!negative) positive_count += 1;
	}

	if (positive_count === 0) {
		throw option_error('"dynamic" must contain at least one positive glob pattern');
	}

	return Object.freeze({ dynamic: Object.freeze(patterns) });
}

/**
 * Convert normalized patterns to the Vite-root-relative spelling consumed by
 * tinyglobby, and reject positive patterns that can escape the resolved root.
 * A leading slash is intentionally stripped: it means Vite-root-relative in
 * this API, never filesystem-root-relative.
 *
 * @param {Readonly<NormalizedEnhancedImagesOptions>} options
 * @param {string} root
 * @returns {readonly string[] | undefined}
 */
export function resolve_dynamic_patterns(options, root) {
	if (!options.dynamic) return undefined;

	const resolved_root = path.resolve(root);
	let positive_count = 0;
	return Object.freeze(
		options.dynamic.map((input, index) => {
			const negative = is_negative_pattern(input);
			const prefix = negative ? '!' : '';
			let pattern = negative ? input.slice(1) : input;

			pattern = pattern.replace(/^\/+/, '');
			if (!pattern) {
				throw option_error(`"dynamic[${index}]" must not resolve to an empty pattern`);
			}
			if (/^[A-Za-z]:\//.test(pattern)) {
				throw option_error(`"dynamic[${index}]" must be relative to the Vite root`);
			}

			if (negative && positive_count === 0) {
				throw option_error(
					`negative "dynamic[${index}]" pattern must follow at least one positive pattern`
				);
			}
			if (!negative && contains_parent_expansion(pattern)) {
				throw option_error(
					`"dynamic[${index}]" contains a brace or extglob expansion that can escape the Vite root: ${JSON.stringify(input)}`
				);
			}

			const absolute_pattern = path.resolve(resolved_root, pattern);
			if (!negative && !is_path_inside(resolved_root, absolute_pattern)) {
				throw option_error(
					`"dynamic[${index}]" resolves outside the Vite root: ${JSON.stringify(input)}`
				);
			}

			if (!negative) positive_count += 1;

			return prefix + pattern;
		})
	);
}

/**
 * @param {string} pattern
 */
export function is_negative_pattern(pattern) {
	// `!(...)` is an extglob, not a negative pattern.
	return pattern.startsWith('!') && pattern[1] !== '(';
}

/**
 * Parent segments inside brace/extglob alternatives are not visible to
 * path.resolve until after glob expansion. Reject them conservatively before
 * tinyglobby can select a scan root.
 *
 * @param {string} pattern
 */
function contains_parent_expansion(pattern) {
	if (!/[{(]/.test(pattern)) return false;
	return pattern.split(/[/{},()|]/).some((segment) => segment === '..');
}

/**
 * @param {string} root
 * @param {string} candidate
 */
function is_path_inside(root, candidate) {
	const relative = path.relative(root, candidate);
	return (
		relative === '' ||
		(!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
	);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function is_plain_object(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * @param {string} message
 */
function option_error(message) {
	return new TypeError(`@itznotabug/enhanced-img: ${message}`);
}

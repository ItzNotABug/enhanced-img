export const RASTER_EXTENSION = /\.(?:avif|heif|gif|jpe?g|png|tiff|webp)$/i;

/**
 * @typedef {{ type: 'string', find: string, replacement: string } | { type: 'regex', source: string, flags: string, replacement: string }} SerializableAlias
 * @typedef {{ aliases?: readonly SerializableAlias[] }} RuntimePathOptions
 * @typedef {{ kind: 'local', path: string, query: string, source: string } | { kind: 'external', source: string } | { kind: 'invalid', source: string, reason: string }} CanonicalRuntimeSource
 */

/**
 * Canonicalize a runtime `src` without touching the filesystem. The importer is
 * a Vite-root key such as `/src/pages/home.js`, never an absolute path.
 *
 * @param {string} value
 * @param {string} importer
 * @param {RuntimePathOptions} [options]
 * @returns {CanonicalRuntimeSource}
 */
export function canonicalize_runtime_source(value, importer, options = {}) {
	if (typeof value !== 'string') {
		return invalid_source(String(value), 'source is not a string');
	}

	if (is_drive_path(value)) return invalid_source(value, 'drive-letter paths are not supported');
	if (value.startsWith('//') || has_explicit_scheme(value)) {
		return { kind: 'external', source: value };
	}
	if (value.includes('\0')) return invalid_source(value, 'NUL is not allowed');
	if (value.includes('\\')) return invalid_source(value, 'backslashes are not allowed');
	if (value.includes('#')) return invalid_source(value, 'fragments are not supported');

	const query_index = value.indexOf('?');
	const raw_path = query_index === -1 ? value : value.slice(0, query_index);
	const query = query_index === -1 ? '' : value.slice(query_index + 1);
	const canonical = canonicalize_runtime_path(raw_path, importer, options);
	if (canonical.kind === 'invalid') return { ...canonical, source: value };
	if (canonical.kind === 'external') return { kind: 'external', source: value };

	return { kind: 'local', path: canonical.path, query, source: value };
}

/**
 * Canonicalize only the path portion of a local source.
 *
 * @param {string} value
 * @param {string} importer
 * @param {RuntimePathOptions} [options]
 * @returns {{ kind: 'local', path: string } | { kind: 'external' } | { kind: 'invalid', reason: string }}
 */
export function canonicalize_runtime_path(value, importer, options = {}) {
	let path_value = value;
	if (!path_value) return { kind: 'invalid', reason: 'path is empty' };
	if (is_drive_path(path_value)) {
		return { kind: 'invalid', reason: 'drive-letter paths are not supported' };
	}
	if (path_value.startsWith('//') || has_explicit_scheme(path_value)) return { kind: 'external' };
	if (path_value.includes('\0')) return { kind: 'invalid', reason: 'NUL is not allowed' };
	if (path_value.includes('\\')) return { kind: 'invalid', reason: 'backslashes are not allowed' };

	path_value = apply_aliases(path_value, options.aliases ?? []);
	if (is_drive_path(path_value)) {
		return { kind: 'invalid', reason: 'alias resolves to a drive-letter path' };
	}
	if (path_value.startsWith('//') || has_explicit_scheme(path_value)) return { kind: 'external' };
	if (path_value.includes('\0') || path_value.includes('\\')) {
		return { kind: 'invalid', reason: 'alias resolves to an invalid path' };
	}

	const is_relative =
		path_value === '.' ||
		path_value === '..' ||
		path_value.startsWith('./') ||
		path_value.startsWith('../');
	const decoded = decode_segments(path_value, is_relative);
	if (decoded.kind === 'invalid') return decoded;

	/** @type {string[]} */
	let output;
	if (is_relative) {
		const importer_segments = normalize_importer(importer);
		if (!importer_segments)
			return { kind: 'invalid', reason: 'importer is not a root-relative key' };
		output = importer_segments.slice(0, -1);
	} else {
		output = [];
	}

	for (const segment of decoded.segments) {
		if (segment === '.') continue;
		if (segment === '..') {
			if (!is_relative || output.length === 0) {
				return { kind: 'invalid', reason: 'path escapes the Vite root' };
			}
			output.pop();
			continue;
		}
		output.push(segment);
	}

	if (output.length === 0) return { kind: 'invalid', reason: 'path is empty' };
	if (/^[A-Za-z]:$/.test(output[0])) {
		return { kind: 'invalid', reason: 'drive-letter paths are not supported' };
	}

	return { kind: 'local', path: '/' + output.join('/') };
}

/**
 * Derive the two URL keys used during candidate discovery. Filesystem names
 * intentionally pass through the same canonical URL spelling as runtime keys,
 * making percent/NFC collisions build errors instead of ambiguous lookups.
 *
 * @param {string} root_relative_path
 * @param {string | undefined} public_relative_path
 */
export function canonicalize_candidate_path(root_relative_path, public_relative_path) {
	const root_result = canonicalize_runtime_path(
		'/' + strip_leading_slashes(root_relative_path),
		'/'
	);
	if (root_result.kind !== 'local') {
		throw new Error(
			`invalid dynamic candidate path ${JSON.stringify(root_relative_path)}: ${reason(root_result)}`
		);
	}

	let key = root_result.path;
	if (public_relative_path !== undefined) {
		const public_result = canonicalize_runtime_path(
			'/' + strip_leading_slashes(public_relative_path),
			'/'
		);
		if (public_result.kind !== 'local') {
			throw new Error(
				`invalid dynamic public path ${JSON.stringify(public_relative_path)}: ${reason(public_result)}`
			);
		}
		key = public_result.path;
	}

	return { key, rootKey: root_result.path };
}

/**
 * Create the root-relative module key embedded in generated adapter code.
 *
 * @param {string} filename
 * @param {string} root
 */
export function module_runtime_key(filename, root) {
	const clean_filename = normalize_filesystem_path(filename.split('?', 1)[0]);
	const clean_root = trim_trailing_slash(normalize_filesystem_path(root));
	const relative = relative_to(clean_root, clean_filename);
	if (relative === null || relative === '') {
		throw new Error(
			`@itznotabug/emage-core: module is outside the Vite root: ${JSON.stringify(filename)}`
		);
	}
	return '/' + normalize_plain_segments(relative).join('/');
}

/**
 * Convert Vite aliases into a JSON-safe runtime configuration. Absolute alias
 * replacements become Vite-root/public URL paths so generated bundles never
 * contain absolute filesystem paths.
 *
 * @param {{ root: string, publicDir?: string | false, resolve?: { alias?: unknown } }} config
 * @param {{ warn?: (message: string) => void }} [hooks]
 */
export function runtime_path_config(config, hooks = {}) {
	return {
		aliases: serialize_aliases(config.resolve?.alias, {
			root: config.root,
			publicDir: config.publicDir || undefined,
			warn: hooks.warn
		})
	};
}

/**
 * @param {unknown} aliases
 * @param {{ root: string, publicDir?: string, warn?: (message: string) => void }} options
 * @returns {SerializableAlias[]}
 */
export function serialize_aliases(aliases, options) {
	const entries = normalize_alias_entries(aliases);
	/** @type {SerializableAlias[]} */
	const result = [];

	for (const entry of entries) {
		if (entry.customResolver !== undefined && entry.customResolver !== null) {
			options.warn?.(
				`@itznotabug/emage-core dynamic: alias ${format_alias_find(entry.find)} uses a custom resolver and cannot be used in runtime image paths`
			);
			continue;
		}
		if (typeof entry.replacement !== 'string') continue;

		const replacement = replacement_to_runtime_path(
			entry.replacement,
			options.root,
			options.publicDir
		);
		if (replacement === null) continue;

		if (typeof entry.find === 'string') {
			result.push({ type: 'string', find: entry.find, replacement });
		} else if (entry.find instanceof RegExp) {
			result.push({
				type: 'regex',
				source: entry.find.source,
				flags: entry.find.flags,
				replacement
			});
		}
	}

	return result;
}

/**
 * Apply the serializable subset of Vite's first-match alias behavior.
 *
 * @param {string} value
 * @param {readonly SerializableAlias[]} aliases
 */
export function apply_aliases(value, aliases) {
	for (const alias of aliases) {
		if (alias.type === 'string') {
			if (value === alias.find || value.startsWith(alias.find + '/')) {
				return join_alias_replacement(alias.replacement, value.slice(alias.find.length));
			}
			continue;
		}

		let expression;
		try {
			expression = new RegExp(alias.source, alias.flags);
		} catch {
			continue;
		}
		expression.lastIndex = 0;
		if (expression.test(value)) {
			expression.lastIndex = 0;
			return value.replace(expression, alias.replacement);
		}
	}
	return value;
}

/**
 * Collision identity used in discovery. It is deliberately stricter than
 * runtime URL matching so builds remain portable to case-insensitive hosts.
 *
 * @param {string} key
 */
export function canonical_collision_key(key) {
	return key
		.normalize('NFKC')
		.toLocaleLowerCase('en-US')
		.replaceAll('ß', 'ss')
		.replaceAll('ς', 'σ')
		.normalize('NFC');
}

/**
 * @param {string} value
 */
export function is_external_source(value) {
	return !is_drive_path(value) && (value.startsWith('//') || has_explicit_scheme(value));
}

/**
 * @param {string} value
 * @param {boolean} relative
 * @returns {{ kind: 'segments', segments: string[] } | { kind: 'invalid', reason: string }}
 */
function decode_segments(value, relative) {
	const raw_segments = strip_leading_slashes(value).split('/');
	/** @type {string[]} */
	const segments = [];

	for (const raw_segment of raw_segments) {
		if (!raw_segment) continue;

		let segment;
		try {
			segment = decodeURIComponent(raw_segment).normalize('NFC');
		} catch {
			return {
				kind: 'invalid',
				reason: 'path contains invalid percent encoding'
			};
		}

		if (segment.includes('\0')) return { kind: 'invalid', reason: 'NUL is not allowed' };
		if (segment.includes('/') || segment.includes('\\')) {
			return {
				kind: 'invalid',
				reason: 'encoded path separators are not allowed'
			};
		}
		if (segment === '.' || segment === '..') {
			if (!relative || raw_segment !== segment) {
				return {
					kind: 'invalid',
					reason: 'encoded or root-relative traversal is not allowed'
				};
			}
		}
		segments.push(segment);
	}

	return { kind: 'segments', segments };
}

/**
 * @param {string} importer
 */
function normalize_importer(importer) {
	if (!importer || importer.includes('\\') || importer.includes('\0')) return null;
	const path_only = importer.split(/[?#]/, 1)[0];
	if (!path_only.startsWith('/') || path_only.startsWith('//')) return null;

	try {
		return normalize_plain_segments(path_only.slice(1));
	} catch {
		return null;
	}
}

/**
 * Normalize an already-decoded, trusted filesystem-relative spelling.
 *
 * @param {string} value
 */
function normalize_plain_segments(value) {
	/** @type {string[]} */
	const output = [];
	for (const raw_segment of value.split('/')) {
		const segment = raw_segment.normalize('NFC');
		if (!segment || segment === '.') continue;
		if (segment === '..') {
			if (output.length === 0) throw new Error('path escapes root');
			output.pop();
			continue;
		}
		output.push(segment);
	}
	return output;
}

/**
 * @param {unknown} aliases
 * @returns {Array<{ find: unknown, replacement: unknown, customResolver?: unknown }>}
 */
function normalize_alias_entries(aliases) {
	if (Array.isArray(aliases)) {
		return aliases.filter(is_alias_entry);
	}
	if (aliases && typeof aliases === 'object') {
		return Object.entries(aliases).map(([find, replacement]) => ({
			find,
			replacement
		}));
	}
	return [];
}

/** @param {unknown} value */
function is_alias_entry(value) {
	return Boolean(value && typeof value === 'object' && 'find' in value && 'replacement' in value);
}

/**
 * @param {string} replacement
 * @param {string} root
 * @param {string | undefined} public_dir
 */
function replacement_to_runtime_path(replacement, root, public_dir) {
	const normalized = normalize_filesystem_path(replacement);
	const normalized_root = trim_trailing_slash(normalize_filesystem_path(root));
	const normalized_public = public_dir
		? trim_trailing_slash(normalize_filesystem_path(public_dir))
		: undefined;

	if (normalized_public) {
		const public_relative = relative_to(normalized_public, normalized);
		if (public_relative !== null) return public_relative ? '/' + public_relative : '/';
	}

	const root_relative = relative_to(normalized_root, normalized);
	if (root_relative !== null) return root_relative ? '/' + root_relative : '/';

	if (normalized.startsWith('/') || is_drive_path(normalized)) return null;
	return '/' + strip_leading_slashes(normalized.replace(/^\.\//, ''));
}

/**
 * @param {string} base
 * @param {string} value
 */
function relative_to(base, value) {
	if (base === '/') return value.startsWith('/') ? value.slice(1) : null;
	const comparison_base = is_drive_path(base) ? base.toLowerCase() : base;
	const comparison_value = is_drive_path(base) ? value.toLowerCase() : value;
	if (comparison_value === comparison_base) return '';
	if (!comparison_value.startsWith(comparison_base + '/')) return null;
	return value.slice(base.length + 1);
}

/**
 * Vite string aliases match either the exact name or a slash-delimited suffix.
 * Avoid turning an alias targeting `/` into a protocol-relative `//...` path.
 *
 * @param {string} replacement
 * @param {string} suffix
 */
function join_alias_replacement(replacement, suffix) {
	if (replacement.endsWith('/') && suffix.startsWith('/')) {
		return replacement + suffix.slice(1);
	}
	return replacement + suffix;
}

/** @param {string} value */
function normalize_filesystem_path(value) {
	return value.replaceAll('\\', '/').normalize('NFC');
}

/** @param {string} value */
function trim_trailing_slash(value) {
	if (value === '/') return value;
	return value.replace(/\/+$/, '');
}

/** @param {string} value */
function strip_leading_slashes(value) {
	return value.replace(/^\/+/, '');
}

/** @param {string} value */
function is_drive_path(value) {
	return /^[A-Za-z]:/.test(value);
}

/** @param {string} value */
function has_explicit_scheme(value) {
	return /^[A-Za-z][A-Za-z\d+.-]*:/.test(value);
}

/** @param {unknown} result */
function reason(result) {
	return result && typeof result === 'object' && 'reason' in result
		? String(result.reason)
		: 'not a local path';
}

/**
 * @param {string} source
 * @param {string} reason_value
 * @returns {{ kind: 'invalid', source: string, reason: string }}
 */
function invalid_source(source, reason_value) {
	return { kind: 'invalid', source, reason: reason_value };
}

/** @param {unknown} find */
function format_alias_find(find) {
	return find instanceof RegExp ? find.toString() : JSON.stringify(find);
}

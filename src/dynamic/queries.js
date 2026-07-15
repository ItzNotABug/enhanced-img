import { createHash } from 'node:crypto';

export const MAX_QUERY_VARIANTS = 32;
export const PROFILE_SCHEMA_VERSION = 1;
export const INTERNAL_QUERY_FIELDS = new Set(['enhanced', 'imgSizes', 'imgWidth']);

/**
 * @typedef {{ key: string, value: string }} QueryEntry
 * @typedef {{ query?: string, publicQuery?: string, sizes?: string | number | null, width?: string | number | null, patterns?: readonly string[], schemaVersion?: number }} QueryProfileInput
 */

/**
 * Canonical public lookup identity for an enhanced-img directive query.
 *
 * @param {string} query
 */
export function canonicalize_public_query(query) {
	return serialize_query_entries(
		parse_query_entries(query).filter((entry) => !INTERNAL_QUERY_FIELDS.has(entry.key))
	);
}

/**
 * Create the query sent to vite-imagetools. Reserved fields cannot be supplied
 * by runtime input; they are derived solely from the markup profile.
 *
 * @param {string} public_query
 * @param {{ sizes?: string | number | null, width?: string | number | null }} [attributes]
 */
export function create_internal_query(public_query, attributes = {}) {
	const entries = parse_query_entries(canonicalize_public_query(public_query));
	// An explicit `w` list overrides the imgSizes/imgWidth-derived width ladder,
	// so both attributes are inert for generation; omitting them lets tags that
	// produce identical output share one profile and one cache entry.
	if (!has_explicit_widths(entries)) {
		if (has_literal_value(attributes.sizes)) {
			entries.push({ key: 'imgSizes', value: String(attributes.sizes) });
		}
		if (has_literal_value(attributes.width)) {
			entries.push({ key: 'imgWidth', value: String(attributes.width) });
		}
	}
	entries.push({ key: 'enhanced', value: '' });
	return serialize_query_entries(entries);
}

/**
 * Construct a deterministic profile and SHA-256 identity shared by all
 * components with equivalent query/attribute/catalog inputs.
 *
 * @param {QueryProfileInput} input
 */
export function create_query_profile(input) {
	const public_query = canonicalize_public_query(input.publicQuery ?? input.query ?? '');
	const public_entries = parse_query_entries(public_query);
	const output_shape = last_entry_value(public_entries, 'as');
	const output_kind = output_shape?.split(':', 1)[0];
	if (output_shape !== undefined && output_kind !== 'picture') {
		throw query_error(
			`dynamic query ${JSON.stringify(public_query)} requests as=${JSON.stringify(output_shape)}; dynamic enhanced images must produce a Picture`
		);
	}

	const explicit_widths = has_explicit_widths(public_entries);
	const sizes = explicit_widths ? null : normalize_profile_attribute(input.sizes);
	const width = explicit_widths ? null : normalize_profile_attribute(input.width);
	const internal_query = create_internal_query(public_query, { sizes, width });
	const patterns = [...(input.patterns ?? [])];
	const schema_version = input.schemaVersion ?? PROFILE_SCHEMA_VERSION;
	const payload = {
		schemaVersion: schema_version,
		publicQuery: public_query,
		internalQuery: internal_query,
		sizes,
		width,
		patterns
	};
	const signature = JSON.stringify(payload);
	const id = createHash('sha256').update(signature).digest('hex');

	return Object.freeze({
		id,
		signature,
		publicQuery: public_query,
		internalQuery: internal_query,
		sizes,
		width,
		patterns: Object.freeze(patterns),
		schemaVersion: schema_version
	});
}

/**
 * Strictly parse application/x-www-form-urlencoded query pairs. URLSearchParams
 * is intentionally used only after strict decoding because it silently accepts
 * malformed percent escapes.
 *
 * @param {string} query
 * @returns {QueryEntry[]}
 */
export function parse_query_entries(query) {
	if (typeof query !== 'string') throw query_error('query must be a string');
	let value = query.startsWith('?') ? query.slice(1) : query;
	if (value === '') return [];
	if (value.includes('#')) throw query_error('query fragments are not supported');
	if (CONTROL_CHARACTER.test(value)) throw query_error('query contains a control character');

	/** @type {QueryEntry[]} */
	const entries = [];
	for (const pair of value.split('&')) {
		if (!pair) throw query_error('query contains an empty directive');
		const equals = pair.indexOf('=');
		const raw_key = equals === -1 ? pair : pair.slice(0, equals);
		const raw_value = equals === -1 ? '' : pair.slice(equals + 1);
		if (!raw_key) throw query_error('query contains an empty directive name');

		const key = decode_query_part(raw_key, 'name').normalize('NFC');
		let entry_value = decode_query_part(raw_value, `value for ${JSON.stringify(key)}`).normalize(
			'NFC'
		);
		if (!key) throw query_error('query contains an empty directive name');
		if (CONTROL_CHARACTER.test(key) || CONTROL_CHARACTER.test(entry_value)) {
			throw query_error('query contains a control character');
		}

		if (/^true$/i.test(entry_value)) entry_value = 'true';
		if (/^false$/i.test(entry_value)) entry_value = 'false';
		entries.push({ key, value: entry_value });
	}

	return entries;
}

/**
 * Stable key sorting preserves the relative order of values for a repeated
 * directive. Semicolon lists stay one value and URLSearchParams encodes them.
 *
 * @param {readonly QueryEntry[]} entries
 */
export function serialize_query_entries(entries) {
	const params = new URLSearchParams();
	for (const entry of entries) params.append(entry.key, entry.value);
	params.sort();
	return params.toString();
}

/** @param {readonly QueryEntry[]} entries */
function has_explicit_widths(entries) {
	return entries.some((entry) => entry.key === 'w' && entry.value !== '');
}

/** @param {string | number | null | undefined} value */
function has_literal_value(value) {
	return value !== undefined && value !== null && String(value) !== '';
}

/** @param {string | number | null | undefined} value */
function normalize_profile_attribute(value) {
	return has_literal_value(value) ? String(value) : null;
}

/**
 * @param {readonly QueryEntry[]} entries
 * @param {string} key
 */
function last_entry_value(entries, key) {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (entries[index].key === key) return entries[index].value;
	}
}

/**
 * @param {string} value
 * @param {string} label
 */
function decode_query_part(value, label) {
	try {
		return decodeURIComponent(value.replaceAll('+', ' '));
	} catch {
		throw query_error(`invalid percent encoding in directive ${label}`);
	}
}

/** @param {string} message */
function query_error(message) {
	return new TypeError(`@itznotabug/enhanced-img: ${message}`);
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

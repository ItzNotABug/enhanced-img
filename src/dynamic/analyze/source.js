import { abstract_primitive_to_string, evaluate_expression } from './expression.js';

/** @typedef {{ kind: 'finite', values: string[] } | { kind: 'unknown' }} Segment */
/** @typedef {Segment[]} SegmentPattern */
/** @typedef {{ patterns: SegmentPattern[], incomplete: boolean, reason?: string }} PatternSet */
/** @typedef {{ phase: 'path' | 'query', query: string, unknown_regions: number, in_unknown: boolean, has_unknown: boolean }} QueryState */
/** @typedef {{ states: QueryState[], incomplete: boolean, reason?: string }} StateSet */

const DEFAULT_CAP = 32;

/**
 * Analyze an expression-valued `src` as one opaque path region followed by a
 * finite directive-query suffix. All Cartesian work is streamed into bounded,
 * deduplicating collections. At most `cap + 1` patterns, states, raw queries,
 * or canonical public queries are retained at any point.
 *
 * `canonicalize_query` is intentionally injected by the markup layer so this
 * analyzer remains independent of the query/profile registry. The public cap
 * is checked only after that canonicalization.
 *
 * @param {any} expression
 * @param {object} context
 * @param {{ cap?: number, filename?: string, source?: string, canonicalize_query?: (query: string) => string }} [options]
 * @returns {{ kind: 'analyzable', queries: string[], has_unknown_path: boolean, loc: ReturnType<typeof expression_location> } | { kind: 'unknown', reason: string, loc: ReturnType<typeof expression_location>, error?: unknown }}
 */
export function analyze_source(expression, context, options = {}) {
	const cap = normalize_cap(options.cap);
	const limit = cap + 1;
	const location = expression_location(expression);
	const pattern_set = analyze_patterns(expression, context, cap, limit);
	if (pattern_set.reason) {
		return { kind: 'unknown', reason: pattern_set.reason, loc: location };
	}

	/** @type {QueryState[]} */
	let final_states = [];
	let incomplete = pattern_set.incomplete;
	for (const pattern of pattern_set.patterns) {
		const processed = process_pattern(pattern, limit);
		if (processed.reason) {
			return { kind: 'unknown', reason: processed.reason, loc: location };
		}
		const merged = merge_states(final_states, processed.states, limit);
		final_states = merged.states;
		incomplete ||= processed.incomplete || merged.incomplete;
	}

	/** @type {string[]} */
	const queries = [];
	const seen = new Set();
	let has_unknown_path = false;
	for (const state of final_states) {
		has_unknown_path ||= state.has_unknown;
		const raw_query = state.phase === 'query' ? state.query : '';
		if (!is_valid_directive_query(raw_query)) {
			return { kind: 'unknown', reason: 'invalid-query', loc: location };
		}

		let query;
		try {
			query = options.canonicalize_query ? options.canonicalize_query(raw_query) : raw_query;
		} catch (error) {
			return { kind: 'unknown', reason: 'invalid-query', loc: location, error };
		}
		if (typeof query !== 'string') {
			return { kind: 'unknown', reason: 'invalid-query', loc: location };
		}
		if (seen.has(query)) continue;
		seen.add(query);
		if (seen.size > cap) {
			throw new DynamicQueryVariantError(expression, options, seen.size, cap, !incomplete);
		}
		queries.push(query);
	}

	// A truncated abstract domain must never be reinterpreted as one opaque path
	// and the empty/default query. The known prefix may prove a cap failure above;
	// otherwise the only sound answer is to leave the source unenhanced.
	if (incomplete) {
		return { kind: 'unknown', reason: 'overflow', loc: location };
	}

	return { kind: 'analyzable', queries, has_unknown_path, loc: location };
}

/** A focused build error raised before image generation begins. */
export class DynamicQueryVariantError extends Error {
	/**
	 * @param {any} expression
	 * @param {{ filename?: string, source?: string }} options
	 * @param {number} count
	 * @param {number} cap
	 * @param {boolean} exact
	 */
	constructor(expression, options, count, cap, exact) {
		const loc = expression_location(expression);
		const label = format_location(options.filename, loc);
		super(
			`@itznotabug/enhanced-img dynamic source at ${label} expands to ${exact ? '' : 'at least '}${count} ` +
				`query variants; the per-tag limit is ${cap}`
		);
		this.name = 'DynamicQueryVariantError';
		this.code = 'ENHANCED_IMG_QUERY_VARIANT_LIMIT';
		this.count = count;
		this.cap = cap;
		this.exact = exact;
		this.loc = loc;
		this.filename = options.filename;
		this.source = options.source;
	}
}

/**
 * Validate directive-query syntax only. Semantic directive validation and
 * canonicalization belong to the query registry. Empty string is the default
 * profile; bare boolean keys and repeated keys are accepted.
 *
 * @param {string} query
 */
export function is_valid_directive_query(query) {
	if (query === '') return true;
	if (query.includes('#') || /[\u0000-\u001f\u007f]/u.test(query)) return false;
	for (const pair of query.split('&')) {
		if (pair === '') return false;
		const equals = pair.indexOf('=');
		const raw_key = equals < 0 ? pair : pair.slice(0, equals);
		const raw_value = equals < 0 ? '' : pair.slice(equals + 1);
		if (raw_key === '') return false;
		try {
			const key = decodeURIComponent(raw_key.replaceAll('+', ' '));
			decodeURIComponent(raw_value.replaceAll('+', ' '));
			if (key.trim() === '' || /[\u0000-\u001f\u007f&=#?]/u.test(key)) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * @param {any} expression
 * @param {object} context
 * @param {number} cap
 * @param {number} limit
 * @returns {PatternSet}
 */
function analyze_patterns(expression, context, cap, limit) {
	const evaluated = evaluate_expression(expression, context, { cap });
	if (evaluated.kind === 'finite') return patterns_from_evaluation(evaluated);

	if (!expression || typeof expression !== 'object') {
		return { patterns: [[{ kind: 'unknown' }]], incomplete: false };
	}

	if (is_transparent_wrapper(expression.type)) {
		return analyze_patterns(expression.expression, context, cap, limit);
	}

	if (expression.type === 'TemplateLiteral') {
		/** @type {PatternSet} */
		let result = { patterns: [[]], incomplete: false };
		for (let index = 0; index < expression.quasis.length; index += 1) {
			const cooked = expression.quasis[index]?.value?.cooked;
			if (typeof cooked !== 'string') {
				return { patterns: [], incomplete: false, reason: 'expression' };
			}
			result = append_pattern_sets(
				result,
				{ patterns: [[{ kind: 'finite', values: [cooked] }]], incomplete: false },
				limit
			);
			if (index < expression.expressions.length) {
				result = append_pattern_sets(
					result,
					analyze_patterns(expression.expressions[index], context, cap, limit),
					limit
				);
			}
			if (result.reason) return result;
		}
		return result;
	}

	if (expression.type === 'BinaryExpression' && expression.operator === '+') {
		if (!definitely_string_expression(expression, context, cap)) {
			return { patterns: [], incomplete: false, reason: 'split-concatenation' };
		}
		return append_pattern_sets(
			analyze_patterns(expression.left, context, cap, limit),
			analyze_patterns(expression.right, context, cap, limit),
			limit
		);
	}

	if (expression.type === 'ConditionalExpression') {
		const test = evaluate_expression(expression.test, context, { cap });
		if (test.kind === 'finite') {
			const truthy = test.values.some(abstract_truthy);
			const falsy = test.values.some((value) => !abstract_truthy(value));
			if (truthy && !falsy) {
				return analyze_patterns(expression.consequent, context, cap, limit);
			}
			if (falsy && !truthy) {
				return analyze_patterns(expression.alternate, context, cap, limit);
			}
		}
		return union_pattern_sets(
			analyze_patterns(expression.consequent, context, cap, limit),
			analyze_patterns(expression.alternate, context, cap, limit),
			limit
		);
	}

	if (evaluated.kind === 'overflow') return patterns_from_evaluation(evaluated);
	if (evaluated.incomplete) return { patterns: [], incomplete: true };
	return { patterns: [[{ kind: 'unknown' }]], incomplete: false };
}

/**
 * @param {{ kind: 'finite', values: any[] } | { kind: 'overflow', values: any[], exact: boolean }} result
 * @returns {PatternSet}
 */
function patterns_from_evaluation(result) {
	/** @type {string[]} */
	const strings = [];
	const seen = new Set();
	for (const value of result.values) {
		const string = abstract_primitive_to_string(value);
		if (string === undefined) {
			return {
				patterns: [[{ kind: 'unknown' }]],
				incomplete: result.kind === 'overflow' && !result.exact
			};
		}
		if (!seen.has(string)) {
			seen.add(string);
			strings.push(string);
		}
	}
	return {
		patterns: strings.length ? [[{ kind: 'finite', values: strings }]] : [],
		incomplete: result.kind === 'overflow' && !result.exact
	};
}

/**
 * @param {any} expression
 * @param {object} context
 * @param {number} cap
 */
function definitely_string_expression(expression, context, cap) {
	if (!expression || typeof expression !== 'object') return false;
	const evaluated = evaluate_expression(expression, context, { cap });
	if (
		evaluated.kind !== 'unknown' &&
		evaluated.values.length > 0 &&
		(evaluated.kind === 'finite' || evaluated.exact) &&
		evaluated.values.every((value) => typeof value === 'string')
	) {
		return true;
	}
	if (is_transparent_wrapper(expression.type)) {
		return definitely_string_expression(expression.expression, context, cap);
	}
	if (expression.type === 'TemplateLiteral') return true;
	if (expression.type === 'Literal') return typeof expression.value === 'string';
	if (expression.type === 'BinaryExpression' && expression.operator === '+') {
		return (
			definitely_string_expression(expression.left, context, cap) ||
			definitely_string_expression(expression.right, context, cap)
		);
	}
	if (expression.type === 'ConditionalExpression') {
		return (
			definitely_string_expression(expression.consequent, context, cap) &&
			definitely_string_expression(expression.alternate, context, cap)
		);
	}
	return false;
}

/**
 * @param {PatternSet} left
 * @param {PatternSet} right
 * @param {number} limit
 * @returns {PatternSet}
 */
function append_pattern_sets(left, right, limit) {
	if (left.reason) return left;
	if (right.reason) return right;
	/** @type {SegmentPattern[]} */
	const patterns = [];
	const seen = new Set();
	let incomplete = left.incomplete || right.incomplete;
	outer: for (const a of left.patterns) {
		for (const b of right.patterns) {
			const pattern = merge_adjacent_segments([...a, ...b]);
			const key = JSON.stringify(pattern);
			if (seen.has(key)) continue;
			if (patterns.length === limit) {
				incomplete = true;
				break outer;
			}
			seen.add(key);
			patterns.push(pattern);
		}
	}
	return { patterns, incomplete };
}

/**
 * @param {PatternSet} left
 * @param {PatternSet} right
 * @param {number} limit
 * @returns {PatternSet}
 */
function union_pattern_sets(left, right, limit) {
	if (left.reason) return left;
	if (right.reason) return right;
	/** @type {SegmentPattern[]} */
	const patterns = [];
	const seen = new Set();
	let incomplete = left.incomplete || right.incomplete;
	outer: for (const input of [left.patterns, right.patterns]) {
		for (const pattern of input) {
			const key = JSON.stringify(pattern);
			if (seen.has(key)) continue;
			if (patterns.length === limit) {
				incomplete = true;
				break outer;
			}
			seen.add(key);
			patterns.push(pattern);
		}
	}
	return { patterns, incomplete };
}

/**
 * @param {SegmentPattern} pattern
 * @param {number} limit
 * @returns {StateSet}
 */
function process_pattern(pattern, limit) {
	/** @type {QueryState[]} */
	let states = [
		{ phase: 'path', query: '', unknown_regions: 0, in_unknown: false, has_unknown: false }
	];
	let incomplete = false;

	for (const segment of pattern) {
		if (segment.kind === 'unknown') {
			const next = [];
			for (const source of states) {
				if (source.phase === 'query') return { states: [], incomplete, reason: 'query' };
				const state = { ...source };
				if (!state.in_unknown) state.unknown_regions += 1;
				if (state.unknown_regions > 1) {
					return { states: [], incomplete, reason: 'multiple-path-regions' };
				}
				state.in_unknown = true;
				state.has_unknown = true;
				next.push(state);
			}
			states = next;
			continue;
		}

		/** @type {QueryState[]} */
		const next = [];
		const seen = new Set();
		outer: for (const state of states) {
			for (const value of segment.values) {
				const updated = append_finite_segment(state, value);
				if (!updated) return { states: [], incomplete, reason: 'fragment' };
				const key = state_key(updated);
				if (seen.has(key)) continue;
				if (next.length === limit) {
					incomplete = true;
					break outer;
				}
				seen.add(key);
				next.push(updated);
			}
		}
		states = next;
	}

	return { states, incomplete };
}

/**
 * @param {QueryState} source
 * @param {string} value
 * @returns {QueryState | undefined}
 */
function append_finite_segment(source, value) {
	const state = { ...source };
	if (state.phase === 'query') {
		state.query += value;
		return state.query.includes('#') ? undefined : state;
	}

	const delimiter = value.indexOf('?');
	const path_part = delimiter < 0 ? value : value.slice(0, delimiter);
	if (path_part.includes('#')) return undefined;
	if (path_part.length > 0) state.in_unknown = false;
	if (delimiter >= 0) {
		state.phase = 'query';
		state.in_unknown = false;
		state.query = value.slice(delimiter + 1);
		if (state.query.includes('#')) return undefined;
	}
	return state;
}

/**
 * @param {QueryState[]} left
 * @param {QueryState[]} right
 * @param {number} limit
 */
function merge_states(left, right, limit) {
	const states = [...left];
	const seen = new Set(left.map(state_key));
	let incomplete = false;
	for (const state of right) {
		const key = state_key(state);
		if (seen.has(key)) continue;
		if (states.length === limit) {
			incomplete = true;
			break;
		}
		seen.add(key);
		states.push(state);
	}
	return { states, incomplete };
}

/** @param {SegmentPattern} segments */
function merge_adjacent_segments(segments) {
	/** @type {SegmentPattern} */
	const merged = [];
	for (const segment of segments) {
		const previous = merged.at(-1);
		if (segment.kind === 'unknown' && previous?.kind === 'unknown') continue;
		merged.push(segment);
	}
	return merged;
}

/** @param {QueryState} state */
function state_key(state) {
	return `${state.phase}\0${state.query}\0${state.unknown_regions}\0${state.in_unknown}\0${state.has_unknown}`;
}

/** @param {string | undefined} type */
function is_transparent_wrapper(type) {
	return (
		type === 'TSAsExpression' ||
		type === 'TSTypeAssertion' ||
		type === 'TSNonNullExpression' ||
		type === 'TSSatisfiesExpression' ||
		type === 'TypeCastExpression'
	);
}

/** @param {any} value */
function abstract_truthy(value) {
	return value !== null && typeof value === 'object' ? true : Boolean(value);
}

/** @param {number | undefined} cap */
function normalize_cap(cap) {
	const value = cap ?? DEFAULT_CAP;
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new TypeError('The dynamic query cap must be a positive safe integer');
	}
	return value;
}

/** @param {any} expression */
function expression_location(expression) {
	return {
		start: typeof expression?.start === 'number' ? expression.start : undefined,
		end: typeof expression?.end === 'number' ? expression.end : undefined,
		line: expression?.loc?.start?.line,
		column: expression?.loc?.start?.column
	};
}

/**
 * @param {string | undefined} filename
 * @param {ReturnType<typeof expression_location>} loc
 */
function format_location(filename, loc) {
	const file = filename ?? '<component>';
	if (typeof loc.line !== 'number') return file;
	return `${file}:${loc.line}:${(loc.column ?? 0) + 1}`;
}

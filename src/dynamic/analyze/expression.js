/**
 * A deliberately small abstract evaluator for expressions embedded in Svelte
 * markup. It only works with values that it created itself and never calls
 * application code (including getters or coercion methods).
 *
 * Contexts are opaque, immutable handles. A markup walker can extend a context
 * when it enters an EachBlock, or after it encounters a {@const} declaration.
 * Keeping context construction separate from evaluation makes scope handling
 * explicit and prevents declarations from leaking between sibling branches.
 */

const DEFAULT_CAP = 32;
const CONTEXT_STATE = new WeakMap();
const RECORD = Symbol('enhanced-img abstract record');
const ABSENT = /** @type {const} */ ({ kind: 'enhanced-img-absent' });

/** @typedef {null | undefined | string | number | boolean | bigint | typeof ABSENT | AbstractArray | AbstractRecord} AbstractValue */
/** @typedef {ReadonlyArray<AbstractValue | typeof ABSENT>} AbstractArray */
/** @typedef {{ readonly [RECORD]: true, readonly entries: ReadonlyMap<string, AbstractValue> }} AbstractRecord */
/** @typedef {{ kind: 'finite', values: AbstractValue[] }} FiniteResult */
/** @typedef {{ kind: 'unknown', reason: string, incomplete?: true }} UnknownResult */
/** @typedef {{ kind: 'overflow', count: number, exact: boolean, values: AbstractValue[], projected_count?: number }} OverflowResult */
/** @typedef {FiniteResult | UnknownResult | OverflowResult} EvaluationResult */
/** @typedef {{ parent: Environment | null, bindings: ReadonlyMap<string, Binding> }} Environment */
/** @typedef {{ kind: 'value', result: EvaluationResult } | DeclarationBinding} Binding */
/** @typedef {{ kind: 'declaration', name: string, pattern: any, init: any, init_env: Environment, default_env: Environment, memo: Map<number, EvaluationResult>, evaluating: Set<number> }} DeclarationBinding */
/** @typedef {{ envs: Environment[], cap: number, overflow?: OverflowResult }} ContextState */

/**
 * @param {string} [reason]
 * @param {boolean} [incomplete]
 * @returns {UnknownResult}
 */
function unknown(reason = 'unsupported expression', incomplete = false) {
	return incomplete ? { kind: 'unknown', reason, incomplete: true } : { kind: 'unknown', reason };
}

/**
 * @param {number} cap
 * @param {number} [projected_count]
 * @param {AbstractValue[]} [values]
 * @param {boolean} [exact]
 * @returns {OverflowResult}
 */
function overflow(cap, projected_count, values = [], exact = false) {
	return {
		kind: 'overflow',
		count: cap + 1,
		exact,
		values,
		...(projected_count === undefined ? {} : { projected_count })
	};
}

/**
 * Create the root evaluation context from a modern Svelte/ESTree Program.
 * Only top-level `const` declarations are evaluable. Imports, mutable
 * declarations, functions, classes and exported mutable props deliberately
 * shadow outer/global names with Unknown values.
 *
 * @param {any | null | undefined} program
 * @param {{ cap?: number }} [options]
 */
export function create_evaluation_context(program, options = {}) {
	const cap = normalize_cap(options.cap);
	/** @type {Environment} */
	let env = make_environment(null, new Map());

	if (program?.type === 'Program' && Array.isArray(program.body)) {
		for (const statement of program.body) {
			env = add_program_statement(env, statement);
		}
	}

	return make_context({ envs: [env], cap });
}

/**
 * Add a Svelte `{@const ...}` declaration (or a normal ESTree const
 * declaration) to a context. The returned context is independent of the
 * input context and is intended for subsequent siblings in the same Fragment.
 *
 * @param {object} context
 * @param {any} declaration_or_tag
 * @param {{ cap?: number }} [options]
 */
export function extend_const_context(context, declaration_or_tag, options = {}) {
	const state = get_context_state(context);
	const cap = normalize_cap(options.cap ?? state.cap);
	const declaration =
		declaration_or_tag?.type === 'ConstTag' ? declaration_or_tag.declaration : declaration_or_tag;

	if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') {
		return context;
	}

	return make_context({
		envs: state.envs.map((env) => add_variable_declaration(env, declaration)),
		cap,
		...(state.overflow ? { overflow: state.overflow } : {})
	});
}

/**
 * Extend a context for the body of a modern Svelte EachBlock. A statically
 * finite array creates one environment per row. If the iterable is opaque,
 * the each bindings are installed as Unknown so a source path can still be
 * analyzed symbolically while a query derived from it remains unsupported.
 *
 * The expansion guard is checked while rows are streamed; no Cartesian array
 * is allocated before the cap is enforced.
 *
 * @param {object} context
 * @param {any} each_block
 * @param {{ cap?: number }} [options]
 */
export function extend_each_context(context, each_block, options = {}) {
	const state = get_context_state(context);
	const cap = normalize_cap(options.cap ?? state.cap);
	/** @type {Environment[]} */
	const envs = [];
	/** @type {OverflowResult | undefined} */
	let context_overflow = state.overflow;
	let projected_count = 0;

	for (let parent_index = 0; parent_index < state.envs.length; parent_index += 1) {
		const parent_env = state.envs[parent_index];
		const iterable = evaluate_in_env(each_block?.expression, parent_env, cap);

		if (iterable.kind === 'overflow') {
			context_overflow = iterable;
			envs.push(bind_unknown_pattern(parent_env, each_block?.context, each_block?.index));
			continue;
		}

		if (iterable.kind === 'unknown') {
			envs.push(bind_unknown_pattern(parent_env, each_block?.context, each_block?.index));
			continue;
		}

		let added_array = false;
		let needs_unknown_row = false;
		for (const value of iterable.values) {
			if (!Array.isArray(value)) {
				needs_unknown_row = true;
				continue;
			}
			added_array = true;
			projected_count += value.length;

			for (let index = 0; index < value.length; index += 1) {
				if (envs.length >= cap + 1) {
					context_overflow = overflow(cap, projected_count, [], false);
					break;
				}

				let row_env =
					value[index] === ABSENT
						? bind_unknown_pattern(parent_env, each_block?.context, each_block?.index)
						: bind_pattern_eager(
								parent_env,
								each_block?.context,
								{ kind: 'finite', values: [/** @type {AbstractValue} */ (value[index])] },
								cap
							);
				if (typeof each_block?.index === 'string') {
					row_env = add_value_binding(row_env, each_block.index, {
						kind: 'finite',
						values: [index]
					});
				}
				envs.push(row_env);
			}

			if (envs.length >= cap + 1) break;
		}

		if (!added_array || needs_unknown_row) {
			if (envs.length < cap + 1) {
				envs.push(bind_unknown_pattern(parent_env, each_block?.context, each_block?.index));
			} else {
				context_overflow = overflow(cap, undefined, [], false);
			}
		}

		if (envs.length >= cap + 1) {
			if (parent_index < state.envs.length - 1 || needs_unknown_row) {
				context_overflow = overflow(cap, undefined, [], false);
			}
			break;
		}
	}

	if (envs.length === 0) {
		// The body of a statically empty each block is unreachable. Keeping one
		// opaque environment makes the analyzer conservative if a consumer still
		// asks about a node in that body.
		for (const parent_env of state.envs.slice(0, 1)) {
			envs.push(bind_unknown_pattern(parent_env, each_block?.context, each_block?.index));
		}
	}

	return make_context({
		envs,
		cap,
		...(context_overflow ? { overflow: context_overflow } : {})
	});
}

/**
 * Install opaque bindings for scopes the evaluator must not cross, such as
 * snippet parameters, await values, component props or slot bindings.
 *
 * @param {object} context
 * @param {any | any[]} patterns
 * @param {{ cap?: number }} [options]
 */
export function extend_unknown_context(context, patterns, options = {}) {
	const state = get_context_state(context);
	const cap = normalize_cap(options.cap ?? state.cap);
	const list = Array.isArray(patterns) ? patterns : [patterns];
	return make_context({
		envs: state.envs.map((source_env) => {
			let env = source_env;
			for (const pattern of list) {
				for (const name of pattern_names(pattern)) {
					env = add_value_binding(env, name, unknown('opaque scope binding'));
				}
			}
			return env;
		}),
		cap,
		...(state.overflow ? { overflow: state.overflow } : {})
	});
}

/**
 * Evaluate an ESTree expression under an immutable evaluation context.
 *
 * @param {any} expression
 * @param {object} context
 * @param {{ cap?: number }} [options]
 * @returns {EvaluationResult}
 */
export function evaluate_expression(expression, context, options = {}) {
	const state = get_context_state(context);
	const cap = normalize_cap(options.cap ?? state.cap);
	/** @type {EvaluationResult} */
	let aggregate = { kind: 'finite', values: [] };
	for (let env_index = 0; env_index < state.envs.length; env_index += 1) {
		const env = state.envs[env_index];
		const result = evaluate_in_env(expression, env, cap);
		aggregate = union_results(aggregate, result, cap);
		if (aggregate.kind === 'unknown') return aggregate;
		if (aggregate.kind === 'overflow' && !aggregate.exact) return aggregate;
	}

	if (state.overflow) {
		// Truncating each environments proves the scope is incomplete, but does not
		// prove that this particular expression has more than `cap` distinct values
		// (it may be row-independent or heavily deduplicated). Do not mislabel that
		// uncertainty as an exact finite-domain overflow.
		return unknown('incomplete each context', true);
	}

	return aggregate;
}

/**
 * Convert an abstract primitive to the exact string JavaScript template
 * interpolation/concatenation would produce. Arrays and objects are rejected
 * because imitating their coercion would require observable method lookup.
 *
 * @param {AbstractValue} value
 * @returns {string | undefined}
 */
export function abstract_primitive_to_string(value) {
	if (value === ABSENT || is_abstract_container(value)) return undefined;
	return String(value);
}

/**
 * @param {any} expression
 * @param {Environment} env
 * @param {number} cap
 * @returns {EvaluationResult}
 */
function evaluate_in_env(expression, env, cap) {
	if (!expression || typeof expression !== 'object') return unknown();

	switch (expression.type) {
		case 'Literal': {
			const value = expression.value;
			if (
				value === null ||
				value === undefined ||
				typeof value === 'string' ||
				typeof value === 'number' ||
				typeof value === 'boolean' ||
				typeof value === 'bigint'
			) {
				return { kind: 'finite', values: [value] };
			}
			return unknown('unsupported literal');
		}

		case 'Identifier':
			return evaluate_identifier(expression.name, env, cap);

		case 'TemplateLiteral':
			return evaluate_template(expression, env, cap);

		case 'BinaryExpression':
			return expression.operator === '+'
				? evaluate_addition(expression.left, expression.right, env, cap)
				: unknown('unsupported binary operator');

		case 'ConditionalExpression':
			return evaluate_conditional(expression, env, cap);

		case 'LogicalExpression':
			return evaluate_logical(expression, env, cap);

		case 'ArrayExpression':
			return evaluate_array(expression, env, cap);

		case 'ObjectExpression':
			return evaluate_object(expression, env, cap);

		case 'MemberExpression':
			return evaluate_member(expression, env, cap);

		case 'TSAsExpression':
		case 'TSTypeAssertion':
		case 'TSNonNullExpression':
		case 'TSSatisfiesExpression':
		case 'TypeCastExpression':
			return evaluate_in_env(expression.expression, env, cap);

		case 'UnaryExpression': {
			if (expression.operator === 'void' && expression.argument?.type === 'Literal') {
				return { kind: 'finite', values: [undefined] };
			}
			if (expression.argument?.type === 'Literal') {
				const value = expression.argument.value;
				if (expression.operator === '-' && typeof value === 'number') {
					return { kind: 'finite', values: [-value] };
				}
				if (expression.operator === '-' && typeof value === 'bigint') {
					return { kind: 'finite', values: [-value] };
				}
				if (expression.operator === '+' && typeof value === 'number') {
					return { kind: 'finite', values: [+value] };
				}
			}
			return unknown('unsupported unary expression');
		}

		case 'AssignmentExpression':
		case 'UpdateExpression':
		case 'CallExpression':
		case 'NewExpression':
		case 'TaggedTemplateExpression':
		case 'AwaitExpression':
		case 'ImportExpression':
		case 'ChainExpression':
		case 'SequenceExpression':
		case 'ArrowFunctionExpression':
		case 'FunctionExpression':
		case 'ClassExpression':
		case 'MetaProperty':
			return unknown(`observable or unsupported ${expression.type}`);

		default:
			return unknown(`unsupported ${String(expression.type)}`);
	}
}

/**
 * @param {string} name
 * @param {Environment} env
 * @param {number} cap
 * @returns {EvaluationResult}
 */
function evaluate_identifier(name, env, cap) {
	const binding = find_binding(env, name);
	if (!binding) {
		return name === 'undefined'
			? { kind: 'finite', values: [undefined] }
			: unknown(`unbound identifier ${name}`);
	}
	if (binding.kind === 'value') return binding.result;
	return evaluate_declaration_binding(binding, cap);
}

/**
 * @param {DeclarationBinding} binding
 * @param {number} cap
 * @returns {EvaluationResult}
 */
function evaluate_declaration_binding(binding, cap) {
	const memoized = binding.memo.get(cap);
	if (memoized) return memoized;
	if (binding.evaluating.has(cap)) return unknown('cyclic const declaration');
	binding.evaluating.add(cap);

	/** @type {EvaluationResult} */
	const initialized = binding.init
		? evaluate_in_env(binding.init, binding.init_env, cap)
		: { kind: 'finite', values: [undefined] };
	const result = extract_pattern_binding(
		binding.pattern,
		initialized,
		binding.name,
		binding.default_env,
		cap
	);
	binding.evaluating.delete(cap);
	binding.memo.set(cap, result);
	return result;
}

/**
 * @param {any} node
 * @param {Environment} env
 * @param {number} cap
 * @returns {EvaluationResult}
 */
function evaluate_template(node, env, cap) {
	/** @type {EvaluationResult} */
	let accumulated = { kind: 'finite', values: [''] };
	for (let index = 0; index < node.quasis.length; index += 1) {
		const cooked = node.quasis[index]?.value?.cooked;
		if (typeof cooked !== 'string') return unknown('invalid template escape');
		accumulated = concatenate_string_result(
			accumulated,
			{
				kind: 'finite',
				values: [cooked]
			},
			cap
		);
		if (accumulated.kind !== 'finite') return accumulated;

		if (index < node.expressions.length) {
			const interpolation = evaluate_in_env(node.expressions[index], env, cap);
			accumulated = concatenate_string_result(accumulated, interpolation, cap);
			if (accumulated.kind !== 'finite') return accumulated;
		}
	}
	return accumulated;
}

/**
 * @param {any} left_node
 * @param {any} right_node
 * @param {Environment} env
 * @param {number} cap
 * @returns {EvaluationResult}
 */
function evaluate_addition(left_node, right_node, env, cap) {
	const left = evaluate_in_env(left_node, env, cap);
	if (left.kind === 'unknown') return left;
	const right = evaluate_in_env(right_node, env, cap);
	if (right.kind === 'unknown') return right;

	return combine_results(left, right, cap, (a, b) => {
		if (typeof a === 'string' || typeof b === 'string') {
			const a_string = abstract_primitive_to_string(a);
			const b_string = abstract_primitive_to_string(b);
			return a_string === undefined || b_string === undefined
				? undefined
				: { ok: true, value: a_string + b_string };
		}
		if (typeof a === 'number' && typeof b === 'number') {
			return { ok: true, value: a + b };
		}
		if (typeof a === 'bigint' && typeof b === 'bigint') {
			return { ok: true, value: a + b };
		}
		return undefined;
	});
}

/**
 * @param {any} node
 * @param {Environment} env
 * @param {number} cap
 * @returns {EvaluationResult}
 */
function evaluate_conditional(node, env, cap) {
	const test = evaluate_in_env(node.test, env, cap);
	let use_consequent = test.kind !== 'finite';
	let use_alternate = test.kind !== 'finite';

	if (test.kind === 'finite') {
		use_consequent = test.values.some(is_truthy);
		use_alternate = test.values.some((value) => !is_truthy(value));
	}

	if (use_consequent && use_alternate) {
		return union_results(
			evaluate_in_env(node.consequent, env, cap),
			evaluate_in_env(node.alternate, env, cap),
			cap
		);
	}
	return evaluate_in_env(use_consequent ? node.consequent : node.alternate, env, cap);
}

/**
 * @param {any} node
 * @param {Environment} env
 * @param {number} cap
 * @returns {EvaluationResult}
 */
function evaluate_logical(node, env, cap) {
	const left = evaluate_in_env(node.left, env, cap);
	if (left.kind === 'overflow') return unknown('logical operand overflow', true);
	if (left.kind === 'unknown') return left;

	/** @type {AbstractValue[]} */
	const selected_left = [];
	let needs_right = false;
	for (const value of left.values) {
		const selects_left =
			node.operator === '||'
				? is_truthy(value)
				: node.operator === '&&'
					? !is_truthy(value)
					: node.operator === '??'
						? value !== null && value !== undefined
						: false;
		if (!['||', '&&', '??'].includes(node.operator)) {
			return unknown('unsupported logical operator');
		}
		if (selects_left) selected_left.push(value);
		else needs_right = true;
	}

	const selected = finite_values(selected_left, cap);
	if (selected.kind !== 'finite' || !needs_right) return selected;
	return union_results(selected, evaluate_in_env(node.right, env, cap), cap);
}

/**
 * @param {any} node
 * @param {Environment} env
 * @param {number} cap
 * @returns {EvaluationResult}
 */
function evaluate_array(node, env, cap) {
	/** @type {AbstractArray[]} */
	let arrays = [Object.freeze([])];
	for (const element of node.elements) {
		if (element?.type === 'SpreadElement') return unknown('array spread');
		/** @type {EvaluationResult} */
		const result = element
			? evaluate_in_env(element, env, cap)
			: { kind: 'finite', values: [ABSENT] };
		if (result.kind === 'unknown') return result;
		if (result.kind === 'overflow') return unknown('array element domain overflow', true);

		const combined = combine_finite(arrays, result.values, cap, (array, value) => ({
			ok: true,
			value: /** @type {AbstractArray} */ (Object.freeze([...array, value]))
		}));
		if (combined.kind !== 'finite') return combined;
		arrays = /** @type {AbstractArray[]} */ (combined.values);
	}
	return { kind: 'finite', values: arrays };
}

/**
 * @param {any} node
 * @param {Environment} env
 * @param {number} cap
 * @returns {EvaluationResult}
 */
function evaluate_object(node, env, cap) {
	/** @type {AbstractRecord[]} */
	let records = [make_record(new Map())];
	for (const property of node.properties) {
		if (
			property.type !== 'Property' ||
			property.kind !== 'init' ||
			property.method ||
			property.value?.type === 'FunctionExpression'
		) {
			return unknown('object spread, method, or accessor');
		}

		const keys = evaluate_property_keys(property, env, cap);
		if (keys.kind === 'unknown') return keys;
		if (keys.kind === 'overflow') return unknown('object key domain overflow', true);
		const value = evaluate_in_env(property.value, env, cap);
		if (value.kind === 'unknown') return value;
		if (value.kind === 'overflow') return unknown('object value domain overflow', true);

		const keyed = combine_finite(keys.values, value.values, cap, (key, item) => {
			const property_key = to_property_key(key);
			if (property_key === undefined || property_key === '__proto__') return undefined;
			return {
				ok: true,
				value: /** @type {AbstractArray} */ (Object.freeze([property_key, item]))
			};
		});
		if (keyed.kind !== 'finite') return keyed;

		const combined = combine_finite(records, keyed.values, cap, (record, entry) => {
			if (!Array.isArray(entry)) return undefined;
			const entries = new Map(record.entries);
			entries.set(/** @type {string} */ (entry[0]), entry[1]);
			return { ok: true, value: make_record(entries) };
		});
		if (combined.kind !== 'finite') return combined;
		records = /** @type {AbstractRecord[]} */ (combined.values);
	}
	return { kind: 'finite', values: records };
}

/**
 * @param {any} node
 * @param {Environment} env
 * @param {number} cap
 * @returns {EvaluationResult}
 */
function evaluate_member(node, env, cap) {
	if (node.optional) return unknown('optional member access');
	const objects = evaluate_in_env(node.object, env, cap);
	if (objects.kind === 'unknown') return objects;
	if (objects.kind === 'overflow') return unknown('member object domain overflow', true);

	/** @type {EvaluationResult} */
	let properties;
	if (node.computed) {
		properties = evaluate_in_env(node.property, env, cap);
	} else if (node.property?.type === 'Identifier') {
		properties = { kind: 'finite', values: [node.property.name] };
	} else {
		return unknown('unsupported property key');
	}
	if (properties.kind === 'unknown') return properties;
	if (properties.kind === 'overflow') return unknown('member key domain overflow', true);

	return combine_finite(objects.values, properties.values, cap, (object, property) => {
		const key = to_property_key(property);
		if (key === undefined) return undefined;
		if (Array.isArray(object)) {
			if (key === 'length') return { ok: true, value: object.length };
			if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
			const index = Number(key);
			if (!Number.isSafeInteger(index) || index >= object.length || object[index] === ABSENT) {
				return undefined;
			}
			return { ok: true, value: /** @type {AbstractValue} */ (object[index]) };
		}
		if (is_abstract_record(object)) {
			return object.entries.has(key) ? { ok: true, value: object.entries.get(key) } : undefined;
		}
		return undefined;
	});
}

/**
 * @param {any} property
 * @param {Environment} env
 * @param {number} cap
 * @returns {EvaluationResult}
 */
function evaluate_property_keys(property, env, cap) {
	if (property.computed) return evaluate_in_env(property.key, env, cap);
	if (property.key?.type === 'Identifier') {
		return { kind: 'finite', values: [property.key.name] };
	}
	if (property.key?.type === 'Literal') {
		return { kind: 'finite', values: [property.key.value] };
	}
	return unknown('unsupported object property key');
}

/**
 * @param {EvaluationResult} left
 * @param {EvaluationResult} right
 * @param {number} cap
 * @returns {EvaluationResult}
 */
function concatenate_string_result(left, right, cap) {
	if (left.kind === 'unknown') return left;
	if (right.kind === 'unknown') return right;
	return combine_results(left, right, cap, (a, b) => {
		const a_string = abstract_primitive_to_string(a);
		const b_string = abstract_primitive_to_string(b);
		return a_string === undefined || b_string === undefined
			? undefined
			: { ok: true, value: a_string + b_string };
	});
}

/**
 * Combine finite prefixes from possibly-overflowing operands. An exact
 * overflow carries the complete cap+1-value domain and can therefore collapse
 * back to Finite after a deduplicating operation. An incomplete overflow may
 * only remain Overflow when the mapped prefix itself proves cap+1 distinct
 * outputs; otherwise the sound result is Unknown.
 *
 * @param {FiniteResult | OverflowResult} left
 * @param {FiniteResult | OverflowResult} right
 * @param {number} cap
 * @param {(left: AbstractValue, right: AbstractValue) => { ok: true, value: AbstractValue } | undefined} combine
 * @returns {EvaluationResult}
 */
function combine_results(left, right, cap, combine) {
	const result = combine_finite(left.values, right.values, cap, combine);
	if (result.kind !== 'overflow') {
		if (result.kind === 'unknown') return result;
		return left.kind === 'finite' || left.exact
			? right.kind === 'finite' || right.exact
				? result
				: unknown('incomplete right operand overflow', true)
			: unknown('incomplete left operand overflow', true);
	}
	return {
		...result,
		exact:
			result.exact &&
			(left.kind === 'finite' || left.exact) &&
			(right.kind === 'finite' || right.exact)
	};
}

/**
 * Stream a Cartesian operation into a deduplicating set and stop at cap + 1.
 * In particular, this function never allocates `left.length * right.length`
 * result slots before checking the guard.
 *
 * @template A, B
 * @param {A[]} left
 * @param {B[]} right
 * @param {number} cap
 * @param {(left: A, right: B) => { ok: true, value: AbstractValue } | undefined} combine
 * @returns {EvaluationResult}
 */
function combine_finite(left, right, cap, combine) {
	/** @type {AbstractValue[]} */
	const values = [];
	const seen = new Set();
	const projected_count = left.length * right.length;
	let processed_count = 0;
	for (const left_value of left) {
		for (const right_value of right) {
			processed_count += 1;
			const combined = combine(left_value, right_value);
			if (!combined) return unknown('unsupported value combination');
			const key = value_key(combined.value);
			if (seen.has(key)) continue;
			seen.add(key);
			if (seen.size > cap) {
				return overflow(
					cap,
					projected_count,
					[...values, combined.value],
					processed_count === projected_count
				);
			}
			values.push(combined.value);
		}
	}
	return { kind: 'finite', values };
}

/**
 * @param {EvaluationResult} first
 * @param {EvaluationResult} second
 * @param {number} cap
 * @returns {EvaluationResult}
 */
function union_results(first, second, cap) {
	if (first.kind === 'unknown' || second.kind === 'unknown') {
		return unknown(
			'union contains an unknown value',
			(first.kind === 'unknown' && first.incomplete === true) ||
				(second.kind === 'unknown' && second.incomplete === true)
		);
	}
	const complete =
		(first.kind === 'finite' || first.exact) && (second.kind === 'finite' || second.exact);
	/** @type {AbstractValue[]} */
	const values = [];
	const seen = new Set();
	let beyond_prefix = false;
	for (const input of [first.values, second.values]) {
		for (const value of input) {
			const key = value_key(value);
			if (seen.has(key)) continue;
			if (values.length === cap + 1) {
				beyond_prefix = true;
				continue;
			}
			seen.add(key);
			values.push(value);
		}
	}

	if (first.kind === 'finite' && second.kind === 'finite' && values.length <= cap) {
		return { kind: 'finite', values };
	}
	if (values.length > cap || first.kind === 'overflow' || second.kind === 'overflow') {
		return overflow(cap, undefined, values, complete && !beyond_prefix);
	}
	return { kind: 'finite', values };
}

/**
 * @param {AbstractValue[]} input
 * @param {number} cap
 * @returns {EvaluationResult}
 */
function finite_values(input, cap) {
	return finite_values_from_arrays([input], cap);
}

/**
 * @param {AbstractValue[][]} inputs
 * @param {number} cap
 * @returns {EvaluationResult}
 */
function finite_values_from_arrays(inputs, cap) {
	/** @type {AbstractValue[]} */
	const values = [];
	const seen = new Set();
	for (let input_index = 0; input_index < inputs.length; input_index += 1) {
		const input = inputs[input_index];
		for (let value_index = 0; value_index < input.length; value_index += 1) {
			const value = input[value_index];
			const key = value_key(value);
			if (seen.has(key)) continue;
			seen.add(key);
			if (seen.size > cap) {
				return overflow(
					cap,
					undefined,
					[...values, value],
					input_index === inputs.length - 1 && value_index === input.length - 1
				);
			}
			values.push(value);
		}
	}
	return { kind: 'finite', values };
}

/**
 * @param {Environment} env
 * @param {any} statement
 * @returns {Environment}
 */
function add_program_statement(env, statement) {
	if (statement?.type === 'VariableDeclaration') {
		return add_variable_declaration(env, statement);
	}
	if (statement?.type === 'ExportNamedDeclaration' && statement.declaration) {
		return add_program_statement(env, statement.declaration);
	}
	if (statement?.type === 'ImportDeclaration') {
		let next = env;
		for (const specifier of statement.specifiers ?? []) {
			if (specifier.local?.name) {
				next = add_value_binding(next, specifier.local.name, unknown('imported value'));
			}
		}
		return next;
	}
	if (statement?.type === 'FunctionDeclaration' || statement?.type === 'ClassDeclaration') {
		return statement.id?.name
			? add_value_binding(env, statement.id.name, unknown('executable declaration'))
			: env;
	}
	return env;
}

/**
 * @param {Environment} env
 * @param {any} declaration
 * @returns {Environment}
 */
function add_variable_declaration(env, declaration) {
	let next = env;
	for (const declarator of declaration.declarations ?? []) {
		if (declaration.kind !== 'const') {
			for (const name of pattern_names(declarator.id)) {
				next = add_value_binding(next, name, unknown(`mutable ${declaration.kind} binding`));
			}
			continue;
		}

		const names = pattern_names(declarator.id);
		const tdz_bindings = new Map(
			names.map((name) => [
				name,
				/** @type {Binding} */ ({
					kind: 'value',
					result: unknown('temporal dead zone')
				})
			])
		);
		const init_env = make_environment(next, tdz_bindings);
		let initialized_env = init_env;
		for (const name of names) {
			/** @type {DeclarationBinding} */
			const binding = {
				kind: 'declaration',
				name,
				pattern: declarator.id,
				init: declarator.init,
				init_env,
				default_env: initialized_env,
				memo: new Map(),
				evaluating: new Set()
			};
			initialized_env = make_environment(initialized_env, new Map([[name, binding]]));
		}
		next = initialized_env;
	}
	return next;
}

/**
 * @param {Environment} env
 * @param {any} pattern
 * @param {EvaluationResult} base
 * @param {number} cap
 * @returns {Environment}
 */
function bind_pattern_eager(env, pattern, base, cap) {
	const names = pattern_names(pattern);
	let next = make_environment(
		env,
		new Map(
			names.map((name) => [
				name,
				/** @type {Binding} */ ({
					kind: 'value',
					result: unknown('temporal dead zone')
				})
			])
		)
	);
	for (const name of names) {
		const extracted = extract_pattern_binding(pattern, base, name, next, cap);
		next = add_value_binding(next, name, extracted);
	}
	return next;
}

/**
 * @param {Environment} env
 * @param {any} pattern
 * @param {string | null | undefined} index_name
 * @returns {Environment}
 */
function bind_unknown_pattern(env, pattern, index_name) {
	let next = env;
	for (const name of pattern_names(pattern)) {
		next = add_value_binding(next, name, unknown('unknown each value'));
	}
	if (typeof index_name === 'string') {
		next = add_value_binding(next, index_name, unknown('unknown each index'));
	}
	return next;
}

/**
 * @param {any} pattern
 * @param {EvaluationResult} base
 * @param {string} target_name
 * @param {Environment} env
 * @param {number} cap
 * @returns {EvaluationResult}
 */
function extract_pattern_binding(pattern, base, target_name, env, cap) {
	if (base.kind === 'unknown') return base;
	if (base.kind === 'overflow') {
		if (pattern?.type === 'Identifier' && pattern.name === target_name) return base;
		return unknown('destructuring source domain overflow', true);
	}
	/** @type {AbstractValue[]} */
	const extracted = [];
	const seen = new Set();

	for (let base_index = 0; base_index < base.values.length; base_index += 1) {
		const value = base.values[base_index];
		const result = extract_from_value(pattern, value, target_name, env, cap);
		if (result.kind !== 'finite') return result;
		for (let result_index = 0; result_index < result.values.length; result_index += 1) {
			const item = result.values[result_index];
			const key = value_key(item);
			if (seen.has(key)) continue;
			seen.add(key);
			if (seen.size > cap) {
				return overflow(
					cap,
					undefined,
					[...extracted, item],
					base_index === base.values.length - 1 && result_index === result.values.length - 1
				);
			}
			extracted.push(item);
		}
	}
	return { kind: 'finite', values: extracted };
}

/**
 * @param {any} pattern
 * @param {AbstractValue} value
 * @param {string} target_name
 * @param {Environment} env
 * @param {number} cap
 * @returns {EvaluationResult}
 */
function extract_from_value(pattern, value, target_name, env, cap) {
	if (!pattern) return unknown('missing binding pattern');
	if (value === ABSENT) return unknown('absent array element may resolve through inheritance');
	if (pattern.type === 'Identifier') {
		return pattern.name === target_name
			? { kind: 'finite', values: [value] }
			: { kind: 'finite', values: [] };
	}
	if (pattern.type === 'AssignmentPattern') {
		if (!pattern_names(pattern.left).includes(target_name)) {
			return { kind: 'finite', values: [] };
		}
		if (value !== undefined) {
			return extract_from_value(pattern.left, value, target_name, env, cap);
		}
		const fallback = evaluate_in_env(pattern.right, env, cap);
		return extract_pattern_binding(pattern.left, fallback, target_name, env, cap);
	}
	if (pattern.type === 'RestElement') {
		return extract_from_value(pattern.argument, value, target_name, env, cap);
	}
	if (pattern.type === 'ArrayPattern') {
		if (!Array.isArray(value)) return unknown('array destructuring of a non-array');
		for (let index = 0; index < pattern.elements.length; index += 1) {
			const element = pattern.elements[index];
			if (!element || !pattern_names(element).includes(target_name)) continue;
			if (element.type !== 'RestElement' && (index >= value.length || value[index] === ABSENT)) {
				return unknown('absent array destructuring value');
			}
			const selected =
				element.type === 'RestElement'
					? Object.freeze(value.slice(index))
					: /** @type {AbstractValue} */ (value[index]);
			return extract_from_value(element, selected, target_name, env, cap);
		}
		return { kind: 'finite', values: [] };
	}
	if (pattern.type === 'ObjectPattern') {
		if (!is_abstract_record(value)) return unknown('object destructuring of a non-object');
		const excluded = new Set();
		for (const property of pattern.properties) {
			if (property.type !== 'Property') continue;
			const key = static_pattern_key(property);
			if (key === undefined) return unknown('computed destructuring key');
			excluded.add(key);
			if (!pattern_names(property.value).includes(target_name)) continue;
			if (!value.entries.has(key)) {
				return unknown('absent object destructuring value may be inherited');
			}
			return extract_from_value(property.value, value.entries.get(key), target_name, env, cap);
		}
		for (const property of pattern.properties) {
			if (property.type !== 'RestElement') continue;
			if (!pattern_names(property.argument).includes(target_name)) continue;
			const rest = new Map();
			for (const [key, item] of value.entries) {
				if (!excluded.has(key)) rest.set(key, item);
			}
			return extract_from_value(property.argument, make_record(rest), target_name, env, cap);
		}
		return { kind: 'finite', values: [] };
	}
	return unknown('unsupported binding pattern');
}

/**
 * @param {any} property
 * @returns {string | undefined}
 */
function static_pattern_key(property) {
	if (property.computed) return undefined;
	if (property.key?.type === 'Identifier') return property.key.name;
	if (property.key?.type === 'Literal') return to_property_key(property.key.value);
	return undefined;
}

/**
 * @param {any} pattern
 * @returns {string[]}
 */
function pattern_names(pattern) {
	if (!pattern || typeof pattern !== 'object') return [];
	switch (pattern.type) {
		case 'Identifier':
			return [pattern.name];
		case 'AssignmentPattern':
			return pattern_names(pattern.left);
		case 'RestElement':
			return pattern_names(pattern.argument);
		case 'ArrayPattern':
			return pattern.elements.flatMap(pattern_names);
		case 'ObjectPattern':
			return pattern.properties.flatMap((property) =>
				property.type === 'Property'
					? pattern_names(property.value)
					: pattern_names(property.argument)
			);
		default:
			return [];
	}
}

/**
 * @param {Environment} env
 * @param {string} name
 * @param {EvaluationResult} result
 * @returns {Environment}
 */
function add_value_binding(env, name, result) {
	return make_environment(env, new Map([[name, { kind: 'value', result }]]));
}

/**
 * @param {Environment} env
 * @param {string} name
 * @returns {Binding | undefined}
 */
function find_binding(env, name) {
	let current = env;
	while (current) {
		const binding = current.bindings.get(name);
		if (binding) return binding;
		current = current.parent;
	}
	return undefined;
}

/**
 * @param {Environment | null} parent
 * @param {Map<string, Binding>} bindings
 * @returns {Environment}
 */
function make_environment(parent, bindings) {
	return Object.freeze({ parent, bindings });
}

/**
 * @param {ContextState} state
 */
function make_context(state) {
	const context = Object.freeze({ kind: 'enhanced-img-evaluation-context' });
	CONTEXT_STATE.set(context, state);
	return context;
}

/**
 * @param {object} context
 * @returns {ContextState}
 */
function get_context_state(context) {
	const state = CONTEXT_STATE.get(context);
	if (!state) throw new TypeError('Expected an enhanced-img evaluation context');
	return state;
}

/**
 * @param {number | undefined} value
 */
function normalize_cap(value) {
	if (value === undefined) return DEFAULT_CAP;
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new TypeError('The finite-expression cap must be a positive safe integer');
	}
	return value;
}

/**
 * @param {Map<string, AbstractValue>} entries
 * @returns {AbstractRecord}
 */
function make_record(entries) {
	return Object.freeze({ [RECORD]: true, entries });
}

/**
 * @param {AbstractValue} value
 * @returns {value is AbstractRecord}
 */
function is_abstract_record(value) {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value[RECORD]);
}

/**
 * @param {AbstractValue} value
 */
function is_abstract_container(value) {
	return Array.isArray(value) || is_abstract_record(value);
}

/**
 * @param {AbstractValue} value
 */
function is_truthy(value) {
	if (value === ABSENT) return false;
	return is_abstract_container(value) || Boolean(value);
}

/**
 * @param {AbstractValue} value
 * @returns {string | undefined}
 */
function to_property_key(value) {
	if (value === ABSENT || is_abstract_container(value)) return undefined;
	return String(value);
}

/**
 * A stable, type-sensitive key used only for values created by this module.
 * @param {AbstractValue} value
 * @returns {string}
 */
function value_key(value) {
	if (value === ABSENT) return 'absent';
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
	if (typeof value === 'number') {
		if (Number.isNaN(value)) return 'number:NaN';
		return `number:${Object.is(value, -0) ? '0' : String(value)}`;
	}
	if (typeof value === 'boolean') return `boolean:${value}`;
	if (typeof value === 'bigint') return `bigint:${value}`;
	if (Array.isArray(value)) return `array:[${value.map(value_key).join(',')}]`;
	if (is_abstract_record(value)) {
		return `object:{${[...value.entries]
			.map(([key, item]) => `${JSON.stringify(key)}:${value_key(item)}`)
			.join(',')}}`;
	}
	return 'unknown';
}

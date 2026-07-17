import { createHash } from 'node:crypto';
import path from 'node:path';
import {
	CATALOG_MODULE_ID,
	RUNTIME_MODULE_ID,
	analyze_source,
	canonicalize_public_query,
	canonicalize_runtime_source,
	create_dynamic_image_engine,
	create_evaluation_context,
	evaluate_expression,
	extend_iteration_context,
	extend_unknown_context,
	module_runtime_key,
	render_composite_resolver
} from '@itznotabug/emage-core';
import { babelParse, parse as parse_sfc } from 'vue/compiler-sfc';

const RESOLVER_PREFIX = 'virtual:emage-vue/resolver/';
const RESOLVED_RESOLVER_PREFIX = `\0${RESOLVER_PREFIX}`;
const EXPRESSION_CAP = 32;

/**
 * @param {Readonly<{ dynamic?: readonly string[] }>} options
 * @param {import('vite').Plugin} imagetools_plugin
 * @returns {import('vite').Plugin}
 */
export function image_plugin(options, imagetools_plugin) {
	const dynamic_enabled = Boolean(options.dynamic);
	if (!dynamic_enabled) return { name: 'vite-plugin-emage-vue' };

	/** @type {import('vite').ResolvedConfig} */
	let vite_config;
	/** @type {Map<string, string>} */
	const owner_sources = new Map();
	/** @type {Map<string, string>} */
	const resolver_modules = new Map();
	const warned_sizes = new Set();
	const dynamic_engine = create_dynamic_image_engine({
		options,
		imagetoolsPlugin: imagetools_plugin,
		isOwner: is_vue_owner,
		ownerKey: module_runtime_key
	});

	const node_transform = create_node_transform({
		get config() {
			return vite_config;
		},
		engine: dynamic_engine,
		owner_sources,
		resolver_modules,
		warned_sizes
	});

	/** @type {import('vite').Plugin} */
	const plugin = {
		name: 'vite-plugin-emage-vue',
		enforce: 'pre',
		async configResolved(config) {
			vite_config = config;
			await dynamic_engine.initialize(config);
			install_node_transform(config, node_transform);
		},
		transform(source, id) {
			if (!id.includes('?') && is_vue_owner(id)) {
				owner_sources.set(clean_filename(id), source);
			}
			return null;
		},
		resolveId(id) {
			if (id.startsWith(RESOLVER_PREFIX)) {
				const resolved = `\0${id}`;
				if (resolver_modules.has(resolved)) return resolved;
			}
			return dynamic_engine.resolve_id(id);
		},
		async load(id) {
			const resolver = resolver_modules.get(id);
			if (resolver !== undefined) return resolver;
			return dynamic_engine.load_with_context(this, id);
		},
		configureServer(server) {
			dynamic_engine.configure_server(server);
		},
		handleHotUpdate(context) {
			owner_sources.delete(clean_filename(context.file));
			dynamic_engine.handle_hot_update(context);
		},
		buildEnd(error) {
			dynamic_engine.build_end(error);
		},
		closeBundle() {
			dynamic_engine.close_bundle();
			owner_sources.clear();
			resolver_modules.clear();
		}
	};

	return plugin;
}

/**
 * @param {import('vite').ResolvedConfig} config
 * @param {(node: any, context: any) => void | (() => void)} node_transform
 */
function install_node_transform(config, node_transform) {
	const vue_plugin = config.plugins.find(
		(plugin) => plugin.name === 'vite:vue' && plugin.api && 'options' in plugin.api
	);
	if (!vue_plugin?.api) {
		throw new Error(
			'@itznotabug/emage-vue: dynamic images require @vitejs/plugin-vue or VitePress'
		);
	}

	const api = /** @type {{ options: any }} */ (vue_plugin.api);
	const current = api.options;
	const compiler_options = current.template?.compilerOptions ?? {};
	const node_transforms = compiler_options.nodeTransforms ?? [];
	if (node_transforms.includes(node_transform)) return;

	api.options = {
		...current,
		template: {
			...current.template,
			compilerOptions: {
				...compiler_options,
				nodeTransforms: [...node_transforms, node_transform]
			}
		}
	};
}

/**
 * @param {{
 *   readonly config: import('vite').ResolvedConfig,
 *   engine: import('@itznotabug/emage-core').DynamicImageEngine,
 *   owner_sources: Map<string, string>,
 *   resolver_modules: Map<string, string>,
 *   warned_sizes: Set<string>
 * }} shared
 */
function create_node_transform(shared) {
	/** @type {WeakMap<object, TransformState>} */
	const states = new WeakMap();

	return function emage_vue_node_transform(node, context) {
		if (node.type === 0) {
			const state = create_transform_state(context.filename, shared);
			const owns_profiles = !context.inSSR || context.ssr;
			states.set(context.root, state);
			state.contexts.set(node, state.root_context);
			return () => {
				if (!state.disabled && owns_profiles) {
					shared.engine.set_owner_profiles(state.owner, state.profile_hashes);
				}
				states.delete(context.root);
			};
		}

		const state = states.get(context.root);
		if (!state || state.disabled) return;
		const parent_context = state.contexts.get(context.parent) ?? state.root_context;
		let evaluation_context = parent_context;

		if (node.type === 11) {
			evaluation_context = iteration_context(node, parent_context);
		} else if (node.type === 1) {
			evaluation_context = slot_iteration_context(node, parent_context);
		}
		state.contexts.set(node, evaluation_context);

		if (node.type !== 1) return;
		const source_binding = dynamic_source_binding(node);
		if (source_binding) {
			transform_source(node, source_binding, evaluation_context, context, state, shared);
		}

		const slot = node.props?.find((prop) => prop.type === 7 && prop.name === 'slot' && prop.exp);
		if (slot?.exp) {
			const pattern = parse_pattern(slot.exp.loc?.source ?? slot.exp.content);
			if (pattern) state.contexts.set(node, extend_unknown_context(evaluation_context, pattern));
		}
	};
}

/**
 * @param {string} filename
 * @param {Parameters<typeof create_node_transform>[0]} shared
 * @returns {TransformState}
 */
function create_transform_state(filename, shared) {
	const clean = clean_filename(filename);
	let owner = '';
	try {
		owner = module_runtime_key(clean, shared.config.root);
	} catch {
		return disabled_state();
	}

	const source = shared.owner_sources.get(clean) ?? '';
	const parsed = parse_owner_program(source, clean);
	const used_identifiers = new Set(
		source.match(/[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/gu) ?? []
	);

	return {
		disabled: false,
		owner,
		root_context: create_evaluation_context(parsed.program, { cap: EXPRESSION_CAP }),
		contexts: new WeakMap(),
		enhanced_imports: parsed.enhanced_imports,
		profile_hashes: new Set(),
		used_identifiers
	};
}

/** @returns {TransformState} */
function disabled_state() {
	return {
		disabled: true,
		owner: '',
		root_context: create_evaluation_context(),
		contexts: new WeakMap(),
		enhanced_imports: new Set(),
		profile_hashes: new Set(),
		used_identifiers: new Set()
	};
}

/**
 * @param {any} node
 * @param {object} parent_context
 */
function iteration_context(node, parent_context) {
	return extend_for_context(node.source, node.valueAlias, node.keyAlias, parent_context);
}

/**
 * Vue keeps `v-for` on a `<template v-slot>` element instead of creating a FOR node.
 * @param {any} node
 * @param {object} parent_context
 */
function slot_iteration_context(node, parent_context) {
	if (node.tag !== 'template') return parent_context;
	const slot = node.props?.some((prop) => prop.type === 7 && prop.name === 'slot');
	const result = node.props?.find((prop) => prop.type === 7 && prop.name === 'for')?.forParseResult;
	return slot && result
		? extend_for_context(result.source, result.value, result.key, parent_context)
		: parent_context;
}

/**
 * @param {any} source
 * @param {any} value
 * @param {any} key
 * @param {object} parent_context
 */
function extend_for_context(source, value, key, parent_context) {
	const iterable = parse_expression(source?.loc?.source ?? source?.content);
	const pattern = parse_pattern(value?.loc?.source ?? value?.content);
	if (!iterable || !pattern) return parent_context;
	const index_pattern = parse_pattern(key?.loc?.source ?? key?.content);
	const index = index_pattern?.type === 'Identifier' ? index_pattern.name : undefined;
	return extend_iteration_context(
		parent_context,
		{ iterable, pattern, ...(index ? { index } : {}) },
		{ cap: EXPRESSION_CAP }
	);
}

/** @param {any} node */
function dynamic_source_binding(node) {
	return node.props?.find(
		(prop) =>
			prop.type === 7 &&
			prop.name === 'bind' &&
			prop.arg?.type === 4 &&
			prop.arg.isStatic &&
			prop.arg.content === 'src' &&
			prop.exp
	);
}

/**
 * @param {any} node
 * @param {any} source_binding
 * @param {object} evaluation_context
 * @param {any} compiler_context
 * @param {TransformState} state
 * @param {Parameters<typeof create_node_transform>[0]} shared
 */
function transform_source(
	node,
	source_binding,
	evaluation_context,
	compiler_context,
	state,
	shared
) {
	if (node.tag !== 'EnhancedImg' && node.tag !== 'enhanced-img') return;
	const expression_source = source_binding.exp.loc?.source ?? source_binding.exp.content;
	const expression = parse_expression(expression_source);
	if (!expression || is_enhanced_import(expression, state.enhanced_imports)) return;

	const catalog = shared.engine.catalog;
	const modules = shared.engine.modules;
	if (!catalog || !modules) {
		throw new Error('@itznotabug/emage-vue: dynamic catalog was not initialized');
	}

	const analyzed = analyze_source(expression, evaluation_context, {
		cap: EXPRESSION_CAP,
		filename: state.owner,
		source: expression_source,
		canonicalize_query: canonicalize_public_query
	});
	let queries = analyzed.kind === 'analyzable' ? analyzed.queries : [];
	if (analyzed.kind === 'analyzable') {
		const evaluated = evaluate_expression(expression, evaluation_context, {
			cap: EXPRESSION_CAP
		});
		if (
			(evaluated.kind === 'finite' || (evaluated.kind === 'overflow' && evaluated.exact)) &&
			evaluated.values.every((value) => typeof value === 'string')
		) {
			const known_queries = new Set();
			for (const value of evaluated.values) {
				const parsed = canonicalize_runtime_source(value, state.owner, {
					aliases: catalog.aliases
				});
				if (parsed.kind === 'local' && catalog.byKey.has(parsed.path)) {
					known_queries.add(canonicalize_public_query(parsed.query));
				}
			}
			queries = [...known_queries];
		}
	}

	const sizes = static_attribute(node, 'sizes');
	const width = static_attribute(node, 'width');
	if (has_dynamic_attribute(node, 'sizes')) {
		const key = `${state.owner}:${node.loc?.start?.offset ?? 0}:sizes`;
		if (!shared.warned_sizes.has(key)) {
			shared.warned_sizes.add(key);
			shared.config.logger.warn(
				`@itznotabug/emage-vue: ${state.owner} uses a dynamic sizes attribute; it is rendered, but the default generated width ladder is used`
			);
		}
	}

	const profiles = queries.map((query) => {
		const profile = modules.register_profile({
			publicQuery: query,
			sizes,
			width,
			patterns: catalog.patterns
		});
		state.profile_hashes.add(profile.hash);
		return { query: profile.publicQuery, id: profile.id, hash: profile.hash };
	});
	const default_reason =
		profiles.length === 0 ||
		(analyzed.kind === 'unknown' &&
			['query', 'invalid-query', 'split-concatenation'].includes(analyzed.reason))
			? 'query'
			: 'path';
	const resolver_id = register_resolver_module(
		state.owner,
		profiles,
		default_reason,
		shared.resolver_modules
	);
	const import_name = allocate_identifier(
		state,
		`resolve_${Math.max(0, node.loc?.start?.offset ?? 0).toString(36)}`
	);
	if (
		!compiler_context.imports.some(
			(entry) => entry.exp === import_name && entry.path === resolver_id
		)
	) {
		compiler_context.imports.push({ exp: import_name, path: resolver_id });
	}

	const original = source_binding.exp;
	source_binding.exp = {
		type: 8,
		loc: original.loc,
		children: [`${import_name}(`, original, ')']
	};
}

/**
 * @param {string} owner
 * @param {Array<{ query: string, id: string, hash: string }>} profiles
 * @param {'path' | 'query'} default_reason
 * @param {Map<string, string>} resolver_modules
 */
function register_resolver_module(owner, profiles, default_reason, resolver_modules) {
	const picture_names = profiles.map((_, index) => `__eimg_pictures_${index}`);
	const imports = profiles.map(
		(profile, index) =>
			`import { pictures as ${picture_names[index]} } from ${JSON.stringify(profile.id)};`
	);
	if (profiles.length) {
		imports.unshift(
			`import { parse_source as __eimg_parse_source, parse_query as __eimg_parse_query } from ${JSON.stringify(RUNTIME_MODULE_ID)};`
		);
	} else {
		imports.unshift(
			`import { classify_path as __eimg_classify_path } from ${JSON.stringify(CATALOG_MODULE_ID)};`
		);
	}

	const resolver = render_composite_resolver(
		'__eimg_resolve_picture',
		profiles.map((profile, index) => ({
			query: profile.query,
			pictures: picture_names[index]
		})),
		'__eimg_warned_sources',
		default_reason,
		profiles.length ? undefined : '__eimg_classify_path',
		profiles.length > 1 ? '__eimg_profiles' : undefined,
		profiles.length ? '__eimg_parse_source' : undefined,
		profiles.length ? '__eimg_parse_query' : undefined,
		'@itznotabug/emage-vue'
	);
	const code = `${imports.join('\n')}
const __eimg_warned_sources = new Set();
${resolver}
export default function __eimg_resolve(value) {
	return typeof value === 'string'
		? __eimg_resolve_picture(value, ${JSON.stringify(owner)}) ?? value
		: value;
}`;
	const hash = createHash('sha256').update(code).digest('hex');
	const id = `${RESOLVER_PREFIX}${hash}`;
	const resolved = `${RESOLVED_RESOLVER_PREFIX}${hash}`;
	const existing = resolver_modules.get(resolved);
	if (existing !== undefined && existing !== code) {
		throw new Error('@itznotabug/emage-vue: resolver module hash collision');
	}
	resolver_modules.set(resolved, code);
	return id;
}

/** @param {any} node @param {string} name */
function static_attribute(node, name) {
	const attribute = node.props?.find((prop) => prop.type === 6 && prop.name === name);
	return attribute?.value?.content;
}

/** @param {any} node @param {string} name */
function has_dynamic_attribute(node, name) {
	return node.props?.some(
		(prop) =>
			prop.type === 7 &&
			prop.name === 'bind' &&
			prop.arg?.type === 4 &&
			prop.arg.isStatic &&
			prop.arg.content === name
	);
}

/** @param {any} expression @param {Set<string>} imports */
function is_enhanced_import(expression, imports) {
	return expression.type === 'Identifier' && imports.has(expression.name);
}

/** @param {TransformState} state @param {string} hint */
function allocate_identifier(state, hint) {
	const base = `__eimg_${hint.replace(/[^A-Za-z0-9_$]/g, '_')}`;
	let name = base;
	let suffix = 0;
	while (state.used_identifiers.has(name)) name = `${base}_${++suffix}`;
	state.used_identifiers.add(name);
	return name;
}

/**
 * @param {string} source
 * @param {string} filename
 */
function parse_owner_program(source, filename) {
	const blocks = filename.endsWith('.vue')
		? vue_script_blocks(source, filename)
		: markdown_script_blocks(source);
	const body = [];
	const enhanced_imports = new Set();
	for (const block of blocks) {
		const program = parse_program(block);
		if (!program) continue;
		body.push(...program.body);
		for (const statement of program.body) {
			if (
				statement.type !== 'ImportDeclaration' ||
				typeof statement.source?.value !== 'string' ||
				!/[?&]enhanced(?:[=&]|$)/.test(statement.source.value)
			) {
				continue;
			}
			for (const specifier of statement.specifiers ?? []) {
				if (specifier.type === 'ImportDefaultSpecifier') {
					enhanced_imports.add(specifier.local.name);
				}
			}
		}
	}
	return {
		program: { type: 'Program', sourceType: 'module', body },
		enhanced_imports
	};
}

/** @param {string} source @param {string} filename */
function vue_script_blocks(source, filename) {
	if (!source) return [];
	const parsed = parse_sfc(source, { filename });
	const script = parsed.descriptor.scriptSetup?.content;
	return typeof script === 'string' ? [script] : [];
}

/** @param {string} source */
function markdown_script_blocks(source) {
	return [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
		.filter((match) => /(?:^|\s)setup(?:\s|$|=)/i.test(match[1]))
		.map((match) => match[2]);
}

/** @param {string} source */
function parse_program(source) {
	try {
		return babelParse(source, parser_options()).program;
	} catch {
		return undefined;
	}
}

/** @param {string | undefined} source */
function parse_expression(source) {
	if (!source) return undefined;
	try {
		const statement = babelParse(`(${source})`, parser_options()).program.body[0];
		return statement?.type === 'ExpressionStatement' ? statement.expression : undefined;
	} catch {
		return undefined;
	}
}

/** @param {string | undefined} source */
function parse_pattern(source) {
	if (!source) return undefined;
	try {
		const statement = babelParse(`(${source}) => 0`, parser_options()).program.body[0];
		return statement?.type === 'ExpressionStatement' &&
			statement.expression.type === 'ArrowFunctionExpression'
			? statement.expression.params[0]
			: undefined;
	} catch {
		return undefined;
	}
}

/** @returns {NonNullable<Parameters<typeof babelParse>[1]>} */
function parser_options() {
	return {
		sourceType: 'module',
		plugins: ['estree', 'typescript', 'jsx']
	};
}

/** @param {string} filename */
function clean_filename(filename) {
	return path.resolve(filename.split('?', 1)[0]);
}

/** @param {string} filename */
function is_vue_owner(filename) {
	return /\.(?:md|vue)$/.test(clean_filename(filename));
}

/**
 * @typedef {{
 *   disabled: boolean,
 *   owner: string,
 *   root_context: object,
 *   contexts: WeakMap<object, object>,
 *   enhanced_imports: Set<string>,
 *   profile_hashes: Set<string>,
 *   used_identifiers: Set<string>
 * }} TransformState
 */

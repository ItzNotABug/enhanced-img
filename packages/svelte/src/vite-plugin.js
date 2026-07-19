/** @import { AST } from 'svelte/compiler' */
import { existsSync } from 'node:fs';
import path from 'node:path';
import MagicString from 'magic-string';
import { parse as parse_svelte } from 'svelte/compiler';
import { parse as parse_markup } from 'svelte-parse-markup';
import { walk } from 'zimmerframe';
import {
	CATALOG_MODULE_ID,
	OPTIMIZABLE_IMAGE_PATTERN,
	RUNTIME_MODULE_ID,
	analyze_source,
	canonicalize_public_query,
	canonicalize_runtime_source,
	create_dynamic_image_engine,
	create_evaluation_context,
	evaluate_expression,
	extend_const_context,
	extend_iteration_context,
	extend_unknown_context,
	load_picture,
	module_runtime_key,
	read_image_metadata,
	render_composite_resolver
} from '@itznotabug/emage-core';
import { create_identifier_allocator, render_dynamic_image } from './dynamic/render.js';

/**
 * Creates the Svelte image plugin.
 * @param {import('vite').Plugin<void>} imagetools_plugin
 * @param {{ dynamic?: readonly string[] }} [_options]
 * @param {import('vite').Plugin<void>} [dynamic_imagetools_plugin]
 * @returns {import('vite').Plugin<void>}
 */
export function image_plugin(imagetools_plugin, _options, dynamic_imagetools_plugin) {
	/** @type {import('vite').ResolvedConfig} */
	let vite_config;
	const options = _options ?? {};
	const dynamic_enabled = Boolean(options.dynamic);
	const dynamic_engine = dynamic_enabled
		? create_dynamic_image_engine({
				options,
				imagetoolsPlugin: dynamic_imagetools_plugin ?? imagetools_plugin,
				isOwner: (filename) => filename.endsWith('.svelte'),
				ownerKey: module_runtime_key,
				logLabel: 'emage-svelte'
			})
		: undefined;

	const name = 'vite-plugin-emage-svelte-markup';

	/** @type {import('vite').Plugin<void>} */
	const plugin = {
		name,
		configResolved(config) {
			vite_config = config;
			const svelteConfigPlugin = config.plugins.find((p) => p.name === 'vite-plugin-svelte:config');
			if (!svelteConfigPlugin) {
				throw new Error(
					'@itznotabug/emage-svelte requires @sveltejs/vite-plugin-svelte 6 or higher to be installed'
				);
			}
			const api = svelteConfigPlugin.api;
			const id_filter = (api.filter ?? api.idFilter).id; // TODO: idFilter was used by earlier versions of vite-plugin-svelte@6, remove when @7 is required
			// @ts-expect-error plugin.transform is defined below before configResolved is called
			plugin.transform.filter.id = {
				include: id_filter.include,
				// Exclude modules with query parameters (e.g. ?raw, ?url) — these are not
				// Svelte components to compile, so parsing them as markup would fail.
				exclude: [...id_filter.exclude, /\?/]
			};

			return dynamic_engine?.initialize(config);
		},
		transform: {
			order: 'pre', // puts it before vite-plugin-svelte:compile
			filter: {
				code: /<enhanced:img/ // code filter must match in addition to the id filter set in configResolved hook above
			},

			async handler(content, filename) {
				const plugin_context = this;
				const s = new MagicString(content);
				const ast = parse_markup(content, { filename, modern: true });
				const semantic_ast = dynamic_enabled
					? parse_svelte(content, { filename, modern: true })
					: undefined;
				const root_evaluation_context = dynamic_enabled
					? create_evaluation_context(semantic_ast?.instance?.content)
					: undefined;
				const identifier = dynamic_enabled ? create_identifier_allocator(content) : undefined;
				const importer = dynamic_enabled
					? module_runtime_key(filename, vite_config.root)
					: undefined;
				const dynamic_catalog = dynamic_engine?.catalog;
				const dynamic_modules = dynamic_engine?.modules;

				/**
				 * Import path to import name
				 * e.g. ./foo.png => __IMPORTED_ASSET_0__
				 * @type {Map<string, string>}
				 */
				const imports = new Map();
				/** @type {Map<string, string>} */
				const dynamic_imports = new Map();
				/** @type {string[]} */
				const dynamic_module_helpers = [];
				const component_profile_hashes = new Set();
				const component_warnings = new Set();
				/** @type {string | undefined} */
				let warned_sources;
				/** @type {string | undefined} */
				let catalog_classifier;
				/** @type {string | undefined} */
				let runtime_source_parser;
				/** @type {string | undefined} */
				let runtime_query_parser;

				/**
				 * @param {import('svelte/compiler').AST.RegularElement} node
				 * @param {AST.Text | AST.ExpressionTag} src_attribute
				 * @param {object | undefined} evaluation_context
				 * @returns {Promise<void>}
				 */
				async function update_element(node, src_attribute, evaluation_context) {
					if (src_attribute.type === 'ExpressionTag') {
						if (dynamic_enabled) {
							update_dynamic_element(node, src_attribute, evaluation_context);
							return;
						}

						const start =
							'end' in src_attribute.expression
								? src_attribute.expression.end
								: src_attribute.expression.range?.[0];
						const end =
							'start' in src_attribute.expression
								? src_attribute.expression.start
								: src_attribute.expression.range?.[1];

						if (typeof start !== 'number' || typeof end !== 'number') {
							throw new Error('ExpressionTag has no range');
						}
						const src_var_name = content.substring(start, end).trim();

						s.update(node.start, node.end, dynamic_img_to_picture(content, node, src_var_name));
						return;
					}

					const original_url = src_attribute.raw.trim();
					let url = original_url;

					if (OPTIMIZABLE_IMAGE_PATTERN.test(url)) {
						const sizes = get_attr_value(node, 'sizes');
						const width = get_attr_value(node, 'width');
						url += url.includes('?') ? '&' : '?';
						if (sizes && 'raw' in sizes) {
							url += 'imgSizes=' + encodeURIComponent(sizes.raw) + '&';
						}
						if (width && 'raw' in width) {
							url += 'imgWidth=' + encodeURIComponent(width.raw) + '&';
						}
						url += 'enhanced';
					}

					// resolves the import so that we can build the entire picture template string and don't
					// need any logic blocks
					const resolved_id = (await plugin_context.resolve(url, filename))?.id;
					if (!resolved_id) {
						const query_index = url.indexOf('?');
						const file_path = query_index >= 0 ? url.substring(0, query_index) : url;
						if (existsSync(path.resolve(vite_config.publicDir, file_path))) {
							throw new Error(
								`Could not locate ${file_path}. Please move it to be located relative to the page in the routes directory or reference it beginning with /static/. See https://vitejs.dev/guide/assets for more details on referencing assets.`
							);
						}
						throw new Error(
							`Could not locate ${file_path}. See https://vitejs.dev/guide/assets for more details on referencing assets.`
						);
					}

					if (OPTIMIZABLE_IMAGE_PATTERN.test(url)) {
						const image = await load_picture(resolved_id, plugin_context, imagetools_plugin);
						s.update(node.start, node.end, img_to_picture(content, node, image));
					} else {
						const metadata = await read_image_metadata(resolved_id);
						// this must come after the await so that we don't hand off processing between getting
						// the imports.size and incrementing the imports.size
						const name = imports.get(original_url) || '__IMPORTED_ASSET_' + imports.size + '__';
						if (!metadata.width || !metadata.height) {
							console.warn(`Could not determine intrinsic dimensions for ${resolved_id}`);
						}
						const new_markup = `<img ${serialize_img_attributes(content, node.attributes, {
							src: `{${name}}`,
							width: metadata.width,
							height: metadata.height
						})} />`;
						s.update(node.start, node.end, new_markup);
						imports.set(original_url, name);
					}
				}

				/**
				 * @param {import('svelte/compiler').AST.RegularElement} node
				 * @param {AST.ExpressionTag} src_attribute
				 * @param {object | undefined} evaluation_context
				 */
				function update_dynamic_element(node, src_attribute, evaluation_context) {
					if (!dynamic_catalog || !dynamic_modules || !identifier || !importer) {
						throw new Error(
							'@itznotabug/emage-svelte: dynamic catalog was not initialized before transforming markup'
						);
					}
					if (!evaluation_context) {
						throw new Error('@itznotabug/emage-svelte: missing dynamic expression context');
					}

					const expression = src_attribute.expression;
					const expression_start = 'start' in expression ? expression.start : expression.range?.[0];
					const expression_end = 'end' in expression ? expression.end : expression.range?.[1];
					if (typeof expression_start !== 'number' || typeof expression_end !== 'number') {
						throw new Error('@itznotabug/emage-svelte: dynamic src expression has no range');
					}
					const expression_source = content.slice(expression_start, expression_end);
					const analyzed = analyze_source(expression, evaluation_context, {
						cap: 32,
						filename: importer,
						source: expression_source,
						canonicalize_query: canonicalize_public_query
					});
					let queries = analyzed.kind === 'analyzable' ? analyzed.queries : [];
					if (analyzed.kind === 'analyzable') {
						const evaluated_source = evaluate_expression(expression, evaluation_context, {
							cap: 32
						});
						if (
							(evaluated_source.kind === 'finite' ||
								(evaluated_source.kind === 'overflow' && evaluated_source.exact)) &&
							evaluated_source.values.every((value) => typeof value === 'string')
						) {
							const known_queries = new Set();
							for (const source of evaluated_source.values) {
								const parsed = canonicalize_runtime_source(source, importer, {
									aliases: dynamic_catalog.aliases
								});
								if (parsed.kind === 'local' && dynamic_catalog.byKey.has(parsed.path)) {
									known_queries.add(canonicalize_public_query(parsed.query));
								}
							}
							queries = [...known_queries];
						}
					}
					const sizes = get_literal_attr_value(node, 'sizes');
					const width = get_literal_attr_value(node, 'width');

					if (has_nonliteral_attr(node, 'sizes')) {
						const warning_key = `${filename}:${node.start}:dynamic-sizes`;
						if (!component_warnings.has(warning_key)) {
							component_warnings.add(warning_key);
							plugin_context.warn(
								`[emage-svelte] ${importer} uses a dynamic sizes attribute; it is rendered, but the default generated width ladder is used`
							);
						}
					}

					/** @type {Array<{ query: string, pictures: string }>} */
					const resolver_imports = [];
					for (const query of queries) {
						const profile = dynamic_modules.register_profile({
							publicQuery: query,
							sizes,
							width,
							patterns: dynamic_catalog.patterns
						});
						component_profile_hashes.add(profile.hash);
						let import_name = dynamic_imports.get(profile.id);
						if (!import_name) {
							import_name = identifier(`pictures_${profile.hash.slice(0, 8)}`);
							dynamic_imports.set(profile.id, import_name);
						}
						resolver_imports.push({ query: profile.publicQuery, pictures: import_name });
					}
					if (resolver_imports.length && !runtime_source_parser) {
						runtime_source_parser = identifier('parse_source');
						runtime_query_parser = identifier('parse_query');
					}

					if (!warned_sources) {
						warned_sources = identifier('warned_sources');
						dynamic_module_helpers.push(`const ${warned_sources} = new Set();`);
					}
					if (resolver_imports.length === 0 && !catalog_classifier) {
						catalog_classifier = identifier('classify_path');
					}
					const resolver = identifier(`resolve_tag_${node.start.toString(36)}`);
					const profiles =
						resolver_imports.length > 1
							? identifier(`profiles_tag_${node.start.toString(36)}`)
							: undefined;
					dynamic_module_helpers.push(
						render_composite_resolver(
							resolver,
							resolver_imports,
							warned_sources,
							resolver_imports.length === 0 ||
								(analyzed.kind === 'unknown' &&
									['query', 'invalid-query', 'split-concatenation'].includes(analyzed.reason))
								? 'query'
								: 'path',
							resolver_imports.length === 0 ? catalog_classifier : undefined,
							profiles,
							runtime_source_parser,
							runtime_query_parser,
							'@itznotabug/emage-svelte'
						)
					);
					s.update(
						node.start,
						node.end,
						render_dynamic_image(content, node, {
							expression: expression_source,
							resolver,
							importer,
							allocator: identifier
						})
					);
				}

				/**
				 * @type {Array<ReturnType<typeof update_element>>}
				 */
				const pending_ast_updates = [];

				if (dynamic_enabled && root_evaluation_context) {
					walk_dynamic_markup(ast, root_evaluation_context, (node, src, context) => {
						pending_ast_updates.push(update_element(node, src, context));
					});
				} else {
					walk(/** @type {import('svelte/compiler').AST.TemplateNode} */ (ast), null, {
						RegularElement(node, { next }) {
							if ('name' in node && node.name === 'enhanced:img') {
								const src = get_attr_value(node, 'src');
								if (!src || typeof src === 'boolean') return;
								pending_ast_updates.push(update_element(node, src, undefined));
								return;
							}
							next();
						}
					});
				}

				if (dynamic_enabled && dynamic_modules && importer) {
					dynamic_engine?.set_owner_profiles(importer, component_profile_hashes);
				}

				await Promise.all(pending_ast_updates);

				// add imports
				let prepended_scripts = '';
				if (imports.size) {
					let text = '';
					for (const [path, import_name] of imports.entries()) {
						text += `\timport ${import_name} from "${path}";\n`;
					}

					if (ast.instance) {
						// @ts-ignore
						s.appendLeft(ast.instance.content.start, text);
					} else {
						prepended_scripts += `<script>${text}</script>\n`;
					}
				}
				if (dynamic_imports.size || catalog_classifier || dynamic_module_helpers.length) {
					let text = '';
					if (runtime_source_parser && runtime_query_parser) {
						text += `\timport { parse_source as ${runtime_source_parser}, parse_query as ${runtime_query_parser} } from ${JSON.stringify(RUNTIME_MODULE_ID)};\n`;
					}
					for (const [module_id, import_name] of dynamic_imports.entries()) {
						text += `\timport { pictures as ${import_name} } from ${JSON.stringify(module_id)};\n`;
					}
					if (catalog_classifier) {
						text += `\timport { classify_path as ${catalog_classifier} } from ${JSON.stringify(CATALOG_MODULE_ID)};\n`;
					}
					if (dynamic_module_helpers.length) {
						text += `\n\t${dynamic_module_helpers.join('\n\n\t')}\n`;
					}
					if (ast.module) {
						// @ts-ignore ESTree Program ranges are present in the parsed Svelte AST
						s.appendLeft(ast.module.content.start, text);
					} else {
						prepended_scripts = `<script module>${text}</script>\n${prepended_scripts}`;
					}
				}
				if (prepended_scripts) s.prepend(prepended_scripts);

				if (ast.css) {
					const css = content.substring(ast.css.start, ast.css.end);
					const modified = css.replaceAll('enhanced\\:img', 'img');
					if (modified !== css) {
						s.update(ast.css.start, ast.css.end, modified);
					}
				}

				return {
					code: s.toString(),
					map: s.generateMap({ hires: 'boundary' })
				};
			}
		}
	};
	if (dynamic_engine) {
		plugin.configureServer = (server) => dynamic_engine.configure_server(server);
		plugin.resolveId = (id) => dynamic_engine.resolve_id(id);
		plugin.load = async function (id) {
			return dynamic_engine.load_with_context(this, id);
		};
		plugin.handleHotUpdate = (context) => dynamic_engine.handle_hot_update(context);
		plugin.writeBundle = () => dynamic_engine.write_bundle();
		plugin.closeBundle = () => dynamic_engine.close_bundle();
	}

	return plugin;
}

/**
 * Walk markup while carrying the finite-evaluation scope that applies at each
 * enhanced image. Fragment handling is explicit so {@const} bindings affect
 * only their following siblings.
 *
 * @param {ReturnType<typeof parse_markup>} ast Parsed Svelte markup.
 * @param {object} root_context Root expression context.
 * @param {(node: import('svelte/compiler').AST.RegularElement, src: AST.Text | AST.ExpressionTag, context: object) => void} on_image Image callback.
 */
function walk_dynamic_markup(ast, root_context, on_image) {
	walk(/** @type {any} */ (ast), root_context, {
		Fragment(node, { state, visit }) {
			let context = state;
			for (const child of node.nodes) {
				visit(child, context);
				if (child.type === 'ConstTag') {
					context = extend_const_context(context, child.declaration);
				}
			}
		},
		EachBlock(node, { state, visit }) {
			visit(
				node.body,
				extend_iteration_context(state, {
					iterable: node.expression,
					pattern: node.context,
					index: node.index
				})
			);
			if (node.fallback) visit(node.fallback, state);
		},
		AwaitBlock(node, { state, visit }) {
			if (node.pending) visit(node.pending, state);
			if (node.then) visit(node.then, extend_unknown_context(state, node.value));
			if (node.catch) visit(node.catch, extend_unknown_context(state, node.error));
		},
		SnippetBlock(node, { state, visit }) {
			visit(node.body, extend_unknown_context(state, node.parameters));
		},
		Component(node, { state, next }) {
			next(with_let_bindings(state, node.attributes));
		},
		SvelteComponent(node, { state, next }) {
			next(with_let_bindings(state, node.attributes));
		},
		SlotElement(node, { state, next }) {
			next(with_let_bindings(state, node.attributes));
		},
		RegularElement(node, { state, next }) {
			if (node.name === 'enhanced:img') {
				const src = get_attr_value(node, 'src');
				if (src && typeof src !== 'boolean') on_image(node, src, state);
				return;
			}
			next();
		}
	});
}

/**
 * @param {object} context Current expression context.
 * @param {import('../types/internal.js').Attribute[]} attributes Element attributes.
 */
function with_let_bindings(context, attributes) {
	const patterns = attributes
		.filter((attribute) => attribute.type === 'LetDirective')
		.map((attribute) => attribute.expression ?? { type: 'Identifier', name: attribute.name });
	return patterns.length ? extend_unknown_context(context, patterns) : context;
}

/**
 * @param {import('svelte/compiler').AST.RegularElement} node Image element.
 * @param {string} name Attribute name.
 */
function get_literal_attr_value(node, name) {
	const attribute = node.attributes.find(
		(value) => value.type === 'Attribute' && value.name === name
	);
	if (!attribute || attribute.type !== 'Attribute' || typeof attribute.value === 'boolean') return;
	const values = Array.isArray(attribute.value) ? attribute.value : [attribute.value];
	return values.length === 1 && values[0]?.type === 'Text' ? values[0].raw : undefined;
}

/**
 * @param {import('svelte/compiler').AST.RegularElement} node Image element.
 * @param {string} name Attribute name.
 */
function has_nonliteral_attr(node, name) {
	return (
		node.attributes.some((value) => value.type === 'Attribute' && value.name === name) &&
		get_literal_attr_value(node, name) === undefined
	);
}

/**
 * @param {import('../types/internal.js').TemplateNode} node
 * @param {string} attr
 * @returns {AST.Text | AST.ExpressionTag | undefined}
 */
function get_attr_value(node, attr) {
	if (!('type' in node) || !('attributes' in node)) return;
	const attribute = node.attributes.find(
		/** @param {any} v */ (v) => v.type === 'Attribute' && v.name === attr
	);

	if (!attribute || !('value' in attribute) || typeof attribute.value === 'boolean') return;

	// Check if value is an array and has at least one element
	if (Array.isArray(attribute.value)) {
		if (attribute.value.length > 0) return attribute.value[0];
		return;
	}

	// If it's not an array or is empty, return the value as is
	return attribute.value;
}

/**
 * @param {string} content
 * @param {import('../types/internal.js').Attribute[]} attributes
 * @param {{
 *   src: string,
 *   width?: string | number,
 *   height?: string | number
 * }} details
 */
function serialize_img_attributes(content, attributes, details) {
	const attribute_strings = attributes.map((attribute) => {
		if ('name' in attribute && attribute.name === 'src') {
			return `src=${details.src}`;
		}
		return content.substring(attribute.start, attribute.end);
	});

	/** @type {number | undefined} */
	let user_width;
	/** @type {number | undefined} */
	let user_height;
	for (const attribute of attributes) {
		if ('name' in attribute && 'value' in attribute) {
			const value = Array.isArray(attribute.value) ? attribute.value[0] : attribute.value;
			if (typeof value === 'object' && 'raw' in value) {
				if (attribute.name === 'width') user_width = parseInt(value.raw);
				if (attribute.name === 'height') user_height = parseInt(value.raw);
			}
		}
	}
	if (details.width && details.height) {
		if (!user_width && !user_height) {
			attribute_strings.push(`width=${details.width}`);
			attribute_strings.push(`height=${details.height}`);
		} else if (!user_width && user_height) {
			attribute_strings.push(
				`width=${Math.round(
					(stringToNumber(details.width) * user_height) / stringToNumber(details.height)
				)}`
			);
		} else if (!user_height && user_width) {
			attribute_strings.push(
				`height=${Math.round(
					(stringToNumber(details.height) * user_width) / stringToNumber(details.width)
				)}`
			);
		}
	}

	return attribute_strings.join(' ');
}

/**
 * @param {string|number} param
 */
function stringToNumber(param) {
	return typeof param === 'string' ? parseInt(param) : param;
}

/**
 * @param {string} content
 * @param {import('svelte/compiler').AST.RegularElement} node
 * @param {import('@itznotabug/emage-core').Picture} image
 */
function img_to_picture(content, node, image) {
	/** @type {import('../types/internal.js').Attribute[]} */
	const attributes = node.attributes;
	const index = attributes.findIndex(
		(attribute) => 'name' in attribute && attribute.name === 'sizes'
	);
	let sizes_string = '';
	if (index >= 0) {
		sizes_string = ' ' + content.substring(attributes[index].start, attributes[index].end);
		attributes.splice(index, 1);
	}

	let res = '<picture>';

	for (const [format, srcset] of Object.entries(image.sources)) {
		res += `<source srcset=${to_value(srcset)}${sizes_string} type="image/${format}" />`;
	}

	res += `<img ${serialize_img_attributes(content, attributes, {
		src: to_value(image.img.src),
		width: image.img.w,
		height: image.img.h
	})} />`;

	return res + '</picture>';
}

/**
 * @param {string} src
 */
function to_value(src) {
	// __VITE_ASSET__ needs to be contained in double quotes to work with Vite asset plugin
	return src.startsWith('__VITE_ASSET__') ? `{"${src}"}` : `"${src}"`;
}

/**
 * For images like `<img src={manually_imported} />`
 * @param {string} content
 * @param {import('svelte/compiler').AST.RegularElement} node
 * @param {string} src_var_name
 */
function dynamic_img_to_picture(content, node, src_var_name) {
	const attributes = node.attributes;
	/**
	 * @param attribute_name {string}
	 */
	function index(attribute_name) {
		return attributes.findIndex(
			(attribute) => 'name' in attribute && attribute.name === attribute_name
		);
	}
	const size_index = index('sizes');
	const width_index = index('width');
	const height_index = index('height');
	let sizes_string = '';
	if (size_index >= 0) {
		sizes_string =
			' ' + content.substring(attributes[size_index].start, attributes[size_index].end);
		attributes.splice(size_index, 1);
	}

	return `{#if typeof ${src_var_name} === 'string'}
	{#if import.meta.env.DEV && ${!width_index && !height_index}}
		{${src_var_name}} was not enhanced. Cannot determine dimensions.
	{:else}
		<img ${serialize_img_attributes(content, attributes, {
			src: `{${src_var_name}}`
		})} />
	{/if}
{:else}
	<picture>
		{#each Object.entries(${src_var_name}.sources) as [format, srcset]}
			<source {srcset}${sizes_string} type={'image/' + format} />
		{/each}
		<img ${serialize_img_attributes(content, attributes, {
			src: `{${src_var_name}.img.src}`,
			width: `{${src_var_name}.img.w}`,
			height: `{${src_var_name}.img.h}`
		})} />
	</picture>
{/if}`;
}

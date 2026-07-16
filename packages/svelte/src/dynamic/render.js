/**
 * @typedef {{ start: number, end: number, name?: string | { name?: string }, value?: unknown }} Attribute
 * @typedef {{ start: number, end: number, attributes: Attribute[] }} ImageNode
 * @typedef {(hint?: string) => string} IdentifierAllocator
 */

/**
 * Build a component-scoped identifier allocator. Scanning the complete source
 * intentionally over-approximates bindings: a false collision costs only a
 * suffix, while generated markup can never shadow an existing identifier.
 *
 * @param {string} source
 * @param {Iterable<string>} [reserved]
 * @returns {IdentifierAllocator}
 */
export function create_identifier_allocator(source, reserved = []) {
	const used = new Set(reserved);
	for (const match of source.matchAll(/[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/gu)) {
		used.add(match[0]);
	}
	let counter = 0;

	return (hint = 'value') => {
		const safe_hint = hint.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^[^A-Za-z_$]/, '_$&');
		const base = `__eimg_${safe_hint || 'value'}`;
		let name = base;
		while (used.has(name)) name = `${base}_${++counter}`;
		used.add(name);
		return name;
	};
}

/**
 * Render the resolver-aware branch for an expression-valued enhanced image.
 * The one-item each block evaluates the original source expression exactly
 * once and remains valid inside nested Svelte scopes.
 *
 * @param {string} content
 * @param {ImageNode} node
 * @param {{ expression: string, resolver: string, importer: string, allocator?: IdentifierAllocator }} options
 */
export function render_dynamic_image(content, node, options) {
	if (!options || typeof options.expression !== 'string') {
		throw new TypeError('render_dynamic_image requires the original source expression');
	}
	if (!is_identifier(options.resolver)) {
		throw new TypeError('render_dynamic_image requires a resolver import identifier');
	}

	const allocator =
		options.allocator ?? create_identifier_allocator(content, [`__eimg_node_${node.start}`]);
	const src = allocator(`src_${Math.max(0, node.start).toString(36)}`);
	const resolved = allocator(`resolved_${Math.max(0, node.start).toString(36)}`);
	const format = allocator(`format_${Math.max(0, node.start).toString(36)}`);
	const srcset = allocator(`srcset_${Math.max(0, node.start).toString(36)}`);
	const attributes = [...node.attributes];
	/** @type {Map<Attribute, string>} */
	const attribute_replacements = new Map();
	/** @type {Map<Attribute, string>} */
	const dimension_values = new Map();
	const dimension_declarations = [];
	for (const name of ['width', 'height']) {
		const attribute = find_attribute(attributes, name);
		if (!attribute) continue;
		const expression = dynamic_attribute_expression(content, attribute);
		if (!expression) continue;
		const value = allocator(`${name}_${Math.max(0, node.start).toString(36)}`);
		attribute_replacements.set(attribute, `${name}={${value}}`);
		dimension_values.set(attribute, value);
		dimension_declarations.push(`{@const ${value} = ${expression}}`);
	}
	const sizes = find_attribute(attributes, 'sizes');
	const picture_attributes = sizes
		? attributes.filter((attribute) => attribute !== sizes)
		: attributes;
	const sizes_source = sizes ? ` ${content.slice(sizes.start, sizes.end)}` : '';
	const fallback_attributes = serialize_attributes(
		content,
		attributes,
		`{${src}}`,
		attribute_replacements
	);
	const picture_img_attributes = serialize_picture_attributes(
		content,
		picture_attributes,
		`{${resolved}.img.src}`,
		resolved,
		attribute_replacements,
		dimension_values
	);
	const importer = JSON.stringify(options.importer);
	const declarations = dimension_declarations.length
		? `\n  ${dimension_declarations.join('\n  ')}`
		: '';

	return `{#each [${options.expression}] as ${src}}${declarations}
  {@const ${resolved} = typeof ${src} === 'string' ? ${options.resolver}(${src}, ${importer}) : ${src}}
  {#if ${picture_guard(resolved)}}
    <picture>
      {#each Object.entries(${resolved}.sources) as [${format}, ${srcset}]}
        <source srcset={${srcset}}${sizes_source} type={'image/' + ${format}} />
      {/each}
      <img ${picture_img_attributes} />
    </picture>
  {:else}
    <img ${fallback_attributes} />
  {/if}
{/each}`;
}

/** Alias matching the plan terminology. */
export const render_dynamic_img = render_dynamic_image;

/** @param {string} name */
function picture_guard(name) {
	return `${name} !== null && typeof ${name} === 'object' && ${name}.sources !== null && typeof ${name}.sources === 'object' && !Array.isArray(${name}.sources) && ${name}.img !== null && typeof ${name}.img === 'object' && typeof ${name}.img.src === 'string' && typeof ${name}.img.w === 'number' && Number.isFinite(${name}.img.w) && typeof ${name}.img.h === 'number' && Number.isFinite(${name}.img.h)`;
}

/**
 * @param {string} content
 * @param {Attribute[]} attributes
 * @param {string} source_value
 * @param {ReadonlyMap<Attribute, string>} [replacements]
 */
function serialize_attributes(content, attributes, source_value, replacements = new Map()) {
	let found_source = false;
	const result = attributes.map((attribute) => {
		if (attribute_name(attribute) === 'src') {
			found_source = true;
			return `src=${source_value}`;
		}
		return replacements.get(attribute) ?? content.slice(attribute.start, attribute.end);
	});
	if (!found_source) result.unshift(`src=${source_value}`);
	return result.join(' ');
}

/**
 * @param {string} content
 * @param {Attribute[]} attributes
 * @param {string} source_value
 * @param {string} resolved
 * @param {ReadonlyMap<Attribute, string>} replacements
 * @param {ReadonlyMap<Attribute, string>} dimension_values
 */
function serialize_picture_attributes(
	content,
	attributes,
	source_value,
	resolved,
	replacements,
	dimension_values
) {
	const result = serialize_attributes(content, attributes, source_value, replacements);
	const width = find_attribute(attributes, 'width');
	const height = find_attribute(attributes, 'height');
	const inferred = [];

	if (!width && !height) {
		inferred.push(`width={${resolved}.img.w}`, `height={${resolved}.img.h}`);
	} else if (!width && height) {
		const expression = dimension_values.get(height) ?? attribute_value_expression(content, height);
		if (expression) {
			inferred.push(
				`width={Math.round((${resolved}.img.w * Number(${expression})) / ${resolved}.img.h)}`
			);
		}
	} else if (!height && width) {
		const expression = dimension_values.get(width) ?? attribute_value_expression(content, width);
		if (expression) {
			inferred.push(
				`height={Math.round((${resolved}.img.h * Number(${expression})) / ${resolved}.img.w)}`
			);
		}
	}

	// Inferred values come before the original attributes so a later spread can
	// still supply user-owned width/height values.
	return inferred.length ? `${inferred.join(' ')} ${result}` : result;
}

/**
 * @param {Attribute[]} attributes Image attributes.
 * @param {string} name Attribute name.
 */
function find_attribute(attributes, name) {
	return attributes.find((attribute) => attribute_name(attribute) === name);
}

/** @param {Attribute} attribute */
function attribute_name(attribute) {
	if (typeof attribute.name === 'string') return attribute.name;
	return attribute.name?.name;
}

/**
 * @param {string} content Component source.
 * @param {Attribute} attribute Dimension attribute.
 */
function attribute_value_expression(content, attribute) {
	const value = Array.isArray(attribute.value) ? attribute.value[0] : attribute.value;
	if (value && typeof value === 'object') {
		if ('raw' in value && typeof value.raw === 'string') return JSON.stringify(value.raw);
		if ('expression' in value && value.expression && typeof value.expression === 'object') {
			const expression = value.expression;
			if ('start' in expression && 'end' in expression) {
				const start = expression.start;
				const end = expression.end;
				if (typeof start === 'number' && typeof end === 'number') return content.slice(start, end);
			}
		}
	}

	const source = content.slice(attribute.start, attribute.end);
	const equals = source.indexOf('=');
	if (equals < 0) return undefined;
	const raw = source.slice(equals + 1).trim();
	if (raw.startsWith('{') && raw.endsWith('}')) return raw.slice(1, -1);
	return raw;
}

/**
 * Return only a real expression-valued attribute. Literal text needs no cache.
 *
 * @param {string} content Component source.
 * @param {Attribute} attribute Dimension attribute.
 */
function dynamic_attribute_expression(content, attribute) {
	const value = Array.isArray(attribute.value) ? attribute.value[0] : attribute.value;
	if (
		value &&
		typeof value === 'object' &&
		'expression' in value &&
		value.expression &&
		typeof value.expression === 'object'
	) {
		const expression = value.expression;
		if ('start' in expression && 'end' in expression) {
			const start = expression.start;
			const end = expression.end;
			if (typeof start === 'number' && typeof end === 'number') return content.slice(start, end);
		}
	}

	const source = content.slice(attribute.start, attribute.end);
	const equals = source.indexOf('=');
	if (equals < 0) return undefined;
	const raw = source.slice(equals + 1).trim();
	if (raw.startsWith('{') && raw.endsWith('}')) return raw.slice(1, -1);
}

/** @param {string} value */
function is_identifier(value) {
	return /^[$A-Z_a-z][$\w]*$/.test(value);
}

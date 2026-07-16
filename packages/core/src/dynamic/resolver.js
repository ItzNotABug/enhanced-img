/**
 * Generate a module-scoped resolver that parses a runtime source once, selects
 * its finite query profile in O(1), and performs one path lookup.
 *
 * @param {string} name Generated wrapper identifier.
 * @param {readonly { query: string, pictures: string }[]} profiles Imported profile maps.
 * @param {string} warned Generated warning-set identifier.
 * @param {'path' | 'query'} default_reason Miss reason when no profile can classify the source.
 * @param {string | undefined} classifier Generated path-only classifier identifier.
 * @param {string | undefined} profiles_name Generated query-to-profile Map identifier.
 * @param {string | undefined} parse_source Generated runtime source parser identifier.
 * @param {string | undefined} parse_query Generated runtime query parser identifier.
 * @param {string} [diagnostic]
 */
export function render_composite_resolver(
	name,
	profiles,
	warned,
	default_reason,
	classifier,
	profiles_name,
	parse_source,
	parse_query,
	diagnostic = '@itznotabug/emage-core'
) {
	if (profiles.length === 0) {
		if (!classifier) throw new Error(`${diagnostic}: missing dynamic catalog classifier`);
		return `function ${name}() {
	const value = arguments[0];
	const importer = arguments[1];
	if (import.meta.env.DEV) {
		const classification = ${classifier}(value, importer);
		if (classification.kind === 'external') return undefined;
		const reason = classification.kind === 'local' && classification.exists ? ${JSON.stringify(default_reason)} : 'path';
		const source = classification.source;
		const key = importer + '\\0' + source + '\\0' + reason;
		if (!${warned}.has(key)) {
			${warned}.add(key);
			console.warn(${JSON.stringify(`${diagnostic}: `)} + importer + ': dynamic source ' + JSON.stringify(source) + ' was not enhanced (' + reason + ' miss)');
		}
	}
	return undefined;
}`;
	}

	if (!parse_source || !parse_query) {
		throw new Error(`${diagnostic}: missing dynamic runtime parser`);
	}
	if (profiles.length > 1 && !profiles_name) {
		throw new Error(`${diagnostic}: missing dynamic profile map identifier`);
	}

	const profile_table =
		profiles.length > 1
			? `const ${profiles_name} = new Map([${profiles
					.map(({ query, pictures }) => `[${JSON.stringify(query)}, ${pictures}]`)
					.join(',')}]);\n`
			: '';
	const selected_profile =
		profiles.length === 1
			? `query === ${JSON.stringify(profiles[0].query)} ? ${profiles[0].pictures} : undefined`
			: `${profiles_name}.get(query)`;
	const representative = profiles[0].pictures;

	return `${profile_table}function ${name}() {
	const value = arguments[0];
	const importer = arguments[1];
	const parsed = ${parse_source}(value, importer);
	if (parsed.kind === 'external') return undefined;
	let miss;
	if (parsed.kind === 'local') {
		const source = parsed.path + (parsed.query ? '?' + parsed.query : '');
		const query = ${parse_query}(parsed.query);
		const pictures = ${selected_profile};
		if (pictures !== undefined) {
			const picture = pictures.get(parsed.path);
			if (picture !== undefined) return picture;
			if (import.meta.env.DEV) miss = { reason: 'path', source };
		} else if (import.meta.env.DEV) {
			miss = { reason: ${representative}.has(parsed.path) ? 'query' : 'path', source };
		}
	} else if (import.meta.env.DEV) {
		miss = { reason: 'path', source: parsed.source };
	}
	if (import.meta.env.DEV) {
		const reason = miss?.reason ?? ${JSON.stringify(default_reason)};
		const source = miss?.source ?? String(value);
		const key = importer + '\\0' + source + '\\0' + reason;
		if (!${warned}.has(key)) {
			${warned}.add(key);
			console.warn(${JSON.stringify(`${diagnostic}: `)} + importer + ': dynamic source ' + JSON.stringify(source) + ' was not enhanced (' + reason + ' miss)');
		}
	}
	return undefined;
}`;
}

import { createHash } from 'node:crypto';
import path from 'node:path';
import { create_query_profile } from './queries.js';

export const DYNAMIC_MODULE_PREFIX = 'virtual:enhanced-img/dynamic/';
export const ASSET_MODULE_PREFIX = 'virtual:enhanced-img/asset/';
export const CATALOG_MODULE_ID = 'virtual:enhanced-img/catalog';
export const RUNTIME_MODULE_ID = 'virtual:enhanced-img/runtime';
const RESOLVED_DYNAMIC_MODULE_PREFIX = `\0${DYNAMIC_MODULE_PREFIX}`;
const RESOLVED_ASSET_MODULE_PREFIX = `\0${ASSET_MODULE_PREFIX}`;
const RESOLVED_CATALOG_MODULE_ID = `\0${CATALOG_MODULE_ID}`;
const RESOLVED_RUNTIME_MODULE_ID = `\0${RUNTIME_MODULE_ID}`;

/**
 * @typedef {import('./paths.js').SerializableAlias} SerializableAlias
 * @typedef {{ key?: string, keys?: readonly string[], source: string, file?: string }} VirtualCandidate
 * @typedef {{ publicQuery?: string, query?: string, internalQuery?: string, sizes?: string | number | null, width?: string | number | null, patterns?: readonly string[], schemaVersion?: number }} VirtualProfileInput
 * @typedef {{ imagetools_plugin: import('vite').Plugin, candidates?: readonly VirtualCandidate[], get_candidates?: () => readonly VirtualCandidate[], patterns?: readonly string[], aliases?: readonly SerializableAlias[], runtime?: { aliases?: readonly SerializableAlias[] } }} DynamicVirtualModuleOptions
 */

/**
 * Create a plugin-instance-local virtual graph. Nothing in this registry is a
 * public runtime export; callers retain the returned object and use
 * `register_profile` while transforming Svelte modules.
 *
 * @param {DynamicVirtualModuleOptions} options
 */
export function create_dynamic_virtual_modules(options) {
	return new DynamicVirtualModules(options);
}

export class DynamicVirtualModules {
	/** @param {DynamicVirtualModuleOptions} options */
	constructor(options) {
		if (!options?.imagetools_plugin) {
			throw virtual_error('an imagetools plugin instance is required');
		}

		this.imagetools_plugin = options.imagetools_plugin;
		this.candidates = [...(options.candidates ?? [])];
		this.get_candidates = options.get_candidates;
		this.candidate_entries = this.get_candidates
			? undefined
			: collect_runtime_keys(this.candidates);
		this.patterns = [...(options.patterns ?? [])];
		this.aliases = normalize_aliases(options.aliases ?? options.runtime?.aliases ?? []);
		/** @type {Map<string, { token: string, source: string, query: string, identity: string }>} */
		this.assets = new Map();
		/** @type {Map<string, { hash: string, profile: ReturnType<typeof create_query_profile>, entries: Array<[string, string]> }>} */
		this.profiles = new Map();
		/** @type {Map<string, Set<string>>} */
		this.owner_profiles = new Map();
		/** @type {Set<string>} */
		this.managed_profiles = new Set();

		const registry = this;
		/** @type {import('vite').Plugin} */
		this.plugin = {
			name: 'vite-plugin-enhanced-img-dynamic-modules',
			resolveId(id) {
				return registry.resolve_id(id);
			},
			async load(id) {
				return registry.load_with_context(this, id);
			}
		};
	}

	/**
	 * Replace the catalog, rebuild every registered profile, and remove asset
	 * jobs that no profile references anymore.
	 *
	 * @param {readonly VirtualCandidate[]} candidates
	 * @returns {{ catalogIds: string[], profileIds: string[], removedAssetIds: string[] }}
	 */
	set_candidates(candidates) {
		this.candidates = [...candidates];
		const candidate_entries = collect_runtime_keys(this.candidates);
		this.candidate_entries = this.get_candidates ? undefined : candidate_entries;

		for (const entry of this.profiles.values()) {
			entry.entries = this.register_candidate_assets(
				candidate_entries,
				entry.profile.internalQuery
			);
		}

		return {
			catalogIds: [RESOLVED_CATALOG_MODULE_ID],
			profileIds: [...this.profiles.keys()].map((hash) => RESOLVED_DYNAMIC_MODULE_PREFIX + hash),
			removedAssetIds: this.prune_assets()
		};
	}

	/**
	 * Replace the exact profile set imported by one transformed component and
	 * retire managed profiles that no component imports anymore.
	 *
	 * @param {string} owner
	 * @param {Iterable<string>} profile_hashes
	 */
	set_owner_profiles(owner, profile_hashes) {
		const next = new Set(profile_hashes);
		for (const hash of next) {
			if (!this.profiles.has(hash)) {
				throw virtual_error(`component ${owner} references an unknown profile ${hash}`);
			}
			this.managed_profiles.add(hash);
		}

		if (next.size) this.owner_profiles.set(owner, next);
		else this.owner_profiles.delete(owner);
		return this.prune_unowned_profiles();
	}

	/** @param {string} owner */
	release_owner(owner) {
		this.owner_profiles.delete(owner);
		return this.prune_unowned_profiles();
	}

	/**
	 * Register (or reuse) one exact public/internal query profile.
	 *
	 * @param {VirtualProfileInput} input
	 */
	register_profile(input) {
		const profile = create_query_profile({
			...input,
			patterns: input.patterns ?? this.patterns
		});
		const existing = this.profiles.get(profile.id);

		if (existing) {
			if (existing.profile.signature !== profile.signature) {
				throw virtual_error(`profile hash collision for ${profile.id}`);
			}
		} else {
			const entries = this.register_candidate_assets(
				this.current_candidate_entries(),
				profile.internalQuery
			);
			this.profiles.set(profile.id, { hash: profile.id, profile, entries });
		}

		return Object.freeze({
			id: DYNAMIC_MODULE_PREFIX + profile.id,
			hash: profile.id,
			publicQuery: profile.publicQuery,
			internalQuery: profile.internalQuery
		});
	}

	/** @param {string} id */
	resolve_id(id) {
		if (id === CATALOG_MODULE_ID) return RESOLVED_CATALOG_MODULE_ID;
		if (id === RUNTIME_MODULE_ID) return RESOLVED_RUNTIME_MODULE_ID;
		if (id.startsWith(DYNAMIC_MODULE_PREFIX)) {
			const hash = id.slice(DYNAMIC_MODULE_PREFIX.length);
			return this.profiles.has(hash) ? RESOLVED_DYNAMIC_MODULE_PREFIX + hash : undefined;
		}
		if (id.startsWith(ASSET_MODULE_PREFIX)) {
			const token = id.slice(ASSET_MODULE_PREFIX.length);
			return this.assets.has(token) ? RESOLVED_ASSET_MODULE_PREFIX + token : undefined;
		}
		return undefined;
	}

	/**
	 * @param {import('vite').Rollup.PluginContext} context
	 * @param {string} id
	 */
	async load_with_context(context, id) {
		if (id === RESOLVED_RUNTIME_MODULE_ID) {
			return render_runtime_module(this.aliases);
		}

		if (id === RESOLVED_CATALOG_MODULE_ID) {
			return render_catalog_module(this.current_candidate_entries());
		}

		if (id.startsWith(RESOLVED_DYNAMIC_MODULE_PREFIX)) {
			const hash = id.slice(RESOLVED_DYNAMIC_MODULE_PREFIX.length);
			const entry = this.profiles.get(hash);
			if (!entry) return undefined;
			return render_resolver_module(entry);
		}

		if (!id.startsWith(RESOLVED_ASSET_MODULE_PREFIX)) return undefined;
		const token = id.slice(RESOLVED_ASSET_MODULE_PREFIX.length);
		const asset = this.assets.get(token);
		if (!asset) return undefined;

		context.addWatchFile(asset.source);
		const hook = this.imagetools_plugin.load;
		const handler = typeof hook === 'object' && hook ? hook.handler : hook;
		if (typeof handler !== 'function') {
			throw virtual_error('invalid vite-imagetools plugin: load hook is missing');
		}

		const result = await handler.call(context, `${asset.source}?${asset.query}`);
		if (result == null) {
			throw virtual_error(`vite-imagetools did not load asset ${token}`);
		}
		return result;
	}

	current_candidates() {
		const candidates = this.get_candidates ? this.get_candidates() : this.candidates;
		if (!Array.isArray(candidates)) {
			throw virtual_error('dynamic candidates must be discovered before registering a profile');
		}
		return candidates;
	}

	current_candidate_entries() {
		return this.candidate_entries ?? collect_runtime_keys(this.current_candidates());
	}

	/**
	 * @param {readonly [string, string][]} candidates
	 * @param {string} internal_query
	 */
	register_candidate_assets(candidates, internal_query) {
		return candidates.map(
			([key, source]) =>
				/** @type {[string, string]} */ ([key, this.register_asset(source, internal_query)])
		);
	}

	/**
	 * @param {string} source Absolute candidate path.
	 * @param {string} query Internal imagetools query.
	 */
	register_asset(source, query) {
		const identity = `${source}\0${query}`;
		const token = `a${sha256(identity)}`;
		const existing = this.assets.get(token);
		if (existing && existing.identity !== identity) {
			throw virtual_error(`asset token collision for ${token}`);
		}
		if (!existing) this.assets.set(token, { token, source, query, identity });
		return token;
	}

	prune_unowned_profiles() {
		const referenced = new Set();
		for (const profiles of this.owner_profiles.values()) {
			for (const hash of profiles) referenced.add(hash);
		}

		const profileIds = [];
		for (const hash of this.managed_profiles) {
			if (referenced.has(hash)) continue;
			this.managed_profiles.delete(hash);
			if (this.profiles.delete(hash)) {
				profileIds.push(RESOLVED_DYNAMIC_MODULE_PREFIX + hash);
			}
		}

		return { profileIds, removedAssetIds: this.prune_assets() };
	}

	prune_assets() {
		const referenced = new Set();
		for (const profile of this.profiles.values()) {
			for (const [, token] of profile.entries) referenced.add(token);
		}

		const removed = [];
		for (const token of this.assets.keys()) {
			if (referenced.has(token)) continue;
			this.assets.delete(token);
			removed.push(RESOLVED_ASSET_MODULE_PREFIX + token);
		}
		return removed;
	}
}

/**
 * @param {{ hash: string, profile: ReturnType<typeof create_query_profile>, entries: Array<[string, string]> }} entry
 */
export function render_resolver_module(entry) {
	const imports = [];
	const mappings = [];
	let index = 0;
	/** @type {Map<string, string>} */
	const names = new Map();

	for (const [key, token] of entry.entries) {
		let name = names.get(token);
		if (!name) {
			name = `__eimg_picture_${index++}`;
			names.set(token, name);
			imports.push(`import ${name} from ${JSON.stringify(ASSET_MODULE_PREFIX + token)};`);
		}
		mappings.push(`[${JSON.stringify(key)}, ${name}]`);
	}

	const code = `${imports.join('\n')}
export const pictures = new Map([${mappings.join(',')}]);
`;

	return code;
}

/**
 * Render a path-only catalog used when a tag cannot safely register any query
 * profile. It contains normalized URL keys only: no asset imports or absolute
 * filesystem paths.
 *
 * @param {readonly [string, string][]} candidates
 */
function render_catalog_module(candidates) {
	const keys = candidates.map(([key]) => key);
	return `import { parse_source } from ${JSON.stringify(RUNTIME_MODULE_ID)};
const __eimg_paths = new Set(${JSON.stringify(keys)});
export function classify_path(value, importer) {
  const parsed = parse_source(value, importer);
  if (parsed.kind === "external") return { kind: "external", source: parsed.source };
  if (parsed.kind !== "local") return { kind: "path", source: parsed.source };
  return {
    kind: "local",
    exists: __eimg_paths.has(parsed.path),
    source: parsed.path + (parsed.query ? "?" + parsed.query : "")
  };
}
`;
}

/** @param {readonly SerializableAlias[]} aliases */
function render_runtime_module(aliases = []) {
	return `const __eimg_alias_data = ${JSON.stringify(normalize_aliases(aliases))};
${RUNTIME_HELPERS}
export { __eimg_source as parse_source, __eimg_query as parse_query };
`;
}

const RUNTIME_SOURCE_HELPERS = String.raw`
function __eimg_source(value, importer) {
  if (typeof value !== "string") return { kind: "invalid", source: String(value) };
  if (/^[A-Za-z]:/.test(value)) return { kind: "invalid", source: value };
  if (value.startsWith("//") || /^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) return { kind: "external", source: value };
  if (value.includes("\0") || value.includes("\\") || value.includes("#")) return { kind: "invalid", source: value };
  const queryIndex = value.indexOf("?");
  let rawPath = queryIndex < 0 ? value : value.slice(0, queryIndex);
  const query = queryIndex < 0 ? "" : value.slice(queryIndex + 1);
  rawPath = __eimg_alias(rawPath);
  if (!rawPath || /^[A-Za-z]:/.test(rawPath) || rawPath.startsWith("//") || /^[A-Za-z][A-Za-z\d+.-]*:/.test(rawPath) || rawPath.includes("\0") || rawPath.includes("\\")) {
    return { kind: "invalid", source: value };
  }
  const relative = rawPath === "." || rawPath === ".." || rawPath.startsWith("./") || rawPath.startsWith("../");
  let output = [];
  if (relative) {
    if (typeof importer !== "string" || !importer.startsWith("/") || importer.startsWith("//") || importer.includes("\\") || importer.includes("\0")) return { kind: "invalid", source: value };
    const importerPath = importer.split(/[?#]/, 1)[0];
    output = importerPath.slice(1).split("/").filter(Boolean);
    output.pop();
  }
  for (const rawSegment of rawPath.replace(/^\/+/, "").split("/")) {
    if (!rawSegment) continue;
    let segment;
    try { segment = decodeURIComponent(rawSegment).normalize("NFC"); } catch { return { kind: "invalid", source: value }; }
    if (segment.includes("\0") || segment.includes("/") || segment.includes("\\")) return { kind: "invalid", source: value };
    if (segment === "." || segment === "..") {
      if (!relative || rawSegment !== segment) return { kind: "invalid", source: value };
      if (segment === ".") continue;
      if (output.length === 0) return { kind: "invalid", source: value };
      output.pop();
      continue;
    }
    output.push(segment);
  }
  if (output.length === 0 || /^[A-Za-z]:$/.test(output[0])) return { kind: "invalid", source: value };
  return { kind: "local", path: "/" + output.join("/"), query, source: value };
}
const __eimg_aliases = __eimg_alias_data.map((alias) => alias.type === "regex" ? { ...alias, expression: new RegExp(alias.source, alias.flags) } : alias);
function __eimg_alias(value) {
  for (const alias of __eimg_aliases) {
    if (alias.type === "string") {
      if (value === alias.find || value.startsWith(alias.find + "/")) {
        const suffix = value.slice(alias.find.length);
        return alias.replacement.endsWith("/") && suffix.startsWith("/")
          ? alias.replacement + suffix.slice(1)
          : alias.replacement + suffix;
      }
    } else {
      alias.expression.lastIndex = 0;
      if (alias.expression.test(value)) { alias.expression.lastIndex = 0; return value.replace(alias.expression, alias.replacement); }
    }
  }
  return value;
}
`;

const RUNTIME_QUERY_HELPERS = String.raw`
function __eimg_query(value) {
  if (value === "") return "";
  if (value.includes("#") || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const entries = [];
  for (const pair of value.split("&")) {
    if (!pair) return undefined;
    const equals = pair.indexOf("=");
    const rawKey = equals < 0 ? pair : pair.slice(0, equals);
    const rawValue = equals < 0 ? "" : pair.slice(equals + 1);
    if (!rawKey) return undefined;
    let key;
    let decoded;
    try {
      key = decodeURIComponent(rawKey.replaceAll("+", " ")).normalize("NFC");
      decoded = decodeURIComponent(rawValue.replaceAll("+", " ")).normalize("NFC");
    } catch { return undefined; }
    if (!key || /[\u0000-\u001f\u007f]/.test(key) || /[\u0000-\u001f\u007f]/.test(decoded)) return undefined;
    if (key === "enhanced" || key === "imgSizes" || key === "imgWidth") continue;
    if (/^true$/i.test(decoded)) decoded = "true";
    if (/^false$/i.test(decoded)) decoded = "false";
    entries.push([key, decoded]);
  }
  entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const params = new URLSearchParams();
  for (const [key, decoded] of entries) params.append(key, decoded);
  return params.toString();
}`;

const RUNTIME_HELPERS = `${RUNTIME_SOURCE_HELPERS}\n${RUNTIME_QUERY_HELPERS}`;

/**
 * Validate and deduplicate candidate runtime keys without exposing source
 * paths in generated modules.
 *
 * @param {readonly VirtualCandidate[]} candidates
 * @returns {Array<[string, string]>}
 */
function collect_runtime_keys(candidates) {
	/** @type {Map<string, string>} */
	const runtime_keys = new Map();

	for (const candidate of candidates) {
		const source = candidate.source;
		if (typeof source !== 'string' || !path.isAbsolute(source)) {
			throw virtual_error('a dynamic candidate source must be an absolute path');
		}
		const keys = candidate.keys?.length ? candidate.keys : candidate.key ? [candidate.key] : [];
		if (keys.length === 0) throw virtual_error(`dynamic candidate ${source} has no runtime key`);

		for (const raw_key of keys) {
			const key = normalize_runtime_key(raw_key);
			if (key === source || key.includes('\\') || key.includes('\0')) {
				throw virtual_error(`invalid runtime key for dynamic candidate ${source}`);
			}
			const previous = runtime_keys.get(key);
			if (previous && previous !== source) {
				throw virtual_error(
					`canonical runtime key collision for ${JSON.stringify(key)} between ${JSON.stringify(previous)} and ${JSON.stringify(source)}`
				);
			}
			runtime_keys.set(key, source);
		}
	}

	return [...runtime_keys].sort(([left], [right]) => left.localeCompare(right, 'en'));
}

/**
 * @param {readonly SerializableAlias[]} aliases
 * @returns {SerializableAlias[]}
 */
function normalize_aliases(aliases) {
	/** @type {SerializableAlias[]} */
	const normalized = [];
	for (const alias of aliases) {
		if (alias.type === 'string') {
			normalized.push({ type: 'string', find: alias.find, replacement: alias.replacement });
			continue;
		}
		normalized.push({
			type: 'regex',
			source: alias.source,
			flags: alias.flags,
			replacement: alias.replacement
		});
	}
	return normalized;
}

/** @param {string} value */
function normalize_runtime_key(value) {
	if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
		throw virtual_error(`runtime candidate key must be root-relative: ${JSON.stringify(value)}`);
	}
	return value.normalize('NFC');
}

/** @param {string} value */
function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

/** @param {string} message */
function virtual_error(message) {
	return new Error(`@itznotabug/enhanced-img: ${message}`);
}

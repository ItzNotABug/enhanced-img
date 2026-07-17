import type { Plugin, Rollup } from 'vite';
import type { Picture } from 'vite-imagetools';
import './ambient.js';

export { Picture };

export interface EnhancedImagesOptions {
	/**
	 * Vite-root-relative glob(s) describing local raster files that a runtime
	 * string may select. Negative patterns are allowed after a positive pattern.
	 */
	dynamic?: string | readonly string[];
}

export interface ImagePlugins {
	publicPlugin: Plugin;
	catalogPlugin: Plugin;
}

export const OPTIMIZABLE_IMAGE_PATTERN: RegExp;
export function create_image_plugins(dynamicEnabled: boolean, logLabel?: string): ImagePlugins;
export function load_picture(
	resolvedId: string,
	pluginContext: Rollup.PluginContext,
	imagetoolsPlugin: Plugin
): Promise<Picture>;
export function read_image_metadata(id: string): Promise<import('sharp').Metadata>;
export function parse_object(value: string): unknown;
export function normalize_options(options?: EnhancedImagesOptions): Readonly<{
	dynamic?: readonly string[];
}>;

export type SerializableAlias =
	| { type: 'string'; find: string; replacement: string }
	| { type: 'regex'; source: string; flags: string; replacement: string };

export interface DynamicCandidate {
	key: string;
	keys: string[];
	source: string;
	file: string;
	relativePath: string;
	rootKey: string;
	public: boolean;
}

export interface DynamicCatalog {
	patterns: readonly string[];
	root: string;
	publicDir: string | undefined;
	aliases: SerializableAlias[];
	candidates: DynamicCandidate[];
	byKey: Map<string, DynamicCandidate>;
}

export function discover_candidates(
	options: Readonly<{ dynamic?: readonly string[] }>,
	config: {
		root: string;
		publicDir?: string | false;
		resolve?: { alias?: unknown };
	},
	hooks?: { warn?: (message: string) => void }
): Promise<DynamicCatalog>;

export type CanonicalRuntimeSource =
	| { kind: 'local'; path: string; query: string; source: string }
	| { kind: 'external'; source: string }
	| { kind: 'invalid'; source: string; reason: string };

export function canonicalize_runtime_source(
	value: string,
	importer: string,
	options?: { aliases?: readonly SerializableAlias[] }
): CanonicalRuntimeSource;
export function module_runtime_key(filename: string, root: string): string;
export function canonicalize_public_query(query: string): string;

export type EvaluationResult =
	| { kind: 'finite'; values: unknown[] }
	| {
			kind: 'overflow';
			count: number;
			exact: boolean;
			values: unknown[];
			projected_count?: number;
	  }
	| { kind: 'unknown'; reason: string; incomplete?: true };

export function create_evaluation_context(program?: unknown, options?: { cap?: number }): object;
export function evaluate_expression(
	expression: unknown,
	context: object,
	options?: { cap?: number }
): EvaluationResult;
export function extend_const_context(
	context: object,
	declaration: unknown,
	options?: { cap?: number }
): object;
export function extend_iteration_context(
	context: object,
	iteration: { iterable: unknown; pattern: unknown; index?: string | null },
	options?: { cap?: number }
): object;
export function extend_unknown_context(
	context: object,
	patterns: unknown | unknown[],
	options?: { cap?: number }
): object;

export type SourceAnalysis =
	| {
			kind: 'analyzable';
			queries: string[];
			has_unknown_path: boolean;
			loc: unknown;
	  }
	| { kind: 'unknown'; reason: string; loc: unknown; error?: unknown };
export function analyze_source(
	expression: unknown,
	context: object,
	options?: {
		cap?: number;
		filename?: string;
		source?: string;
		canonicalize_query?: (query: string) => string;
	}
): SourceAnalysis;

export const CATALOG_MODULE_ID: string;
export const RUNTIME_MODULE_ID: string;

export interface DynamicVirtualModules {
	profiles: Map<string, { entries: Array<[string, string]> }>;
	register_profile(input: {
		publicQuery?: string;
		query?: string;
		internalQuery?: string;
		sizes?: string | number | null;
		width?: string | number | null;
		patterns?: readonly string[];
		schemaVersion?: number;
	}): { id: string; hash: string; publicQuery: string; internalQuery: string };
	set_owner_profiles(
		owner: string,
		profileHashes: Iterable<string>
	): { profileIds: string[]; removedAssetIds: string[] };
	release_owner(owner: string): { profileIds: string[]; removedAssetIds: string[] };
	set_candidates(candidates: readonly DynamicCandidate[]): {
		catalogIds: string[];
		profileIds: string[];
		removedAssetIds: string[];
	};
	resolve_id(id: string): string | undefined;
	load_with_context(context: Rollup.PluginContext, id: string): Promise<Rollup.LoadResult>;
}

export function create_dynamic_virtual_modules(options: {
	imagetools_plugin: Plugin;
	candidates?: readonly DynamicCandidate[];
	patterns?: readonly string[];
	aliases?: readonly SerializableAlias[];
}): DynamicVirtualModules;

export interface DynamicImageEngine {
	readonly catalog: DynamicCatalog | undefined;
	readonly modules: DynamicVirtualModules | undefined;
	initialize(config: import('vite').ResolvedConfig): Promise<void>;
	configure_server(server: import('vite').ViteDevServer): void;
	set_owner_profiles(owner: string, profileHashes: Iterable<string>): void;
	resolve_id(id: string): string | undefined;
	load_with_context(
		context: Rollup.PluginContext,
		id: string
	): Promise<Rollup.LoadResult> | undefined;
	handle_hot_update(context: import('vite').HmrContext): void;
	write_bundle(): void;
	close_bundle(): void;
}

export function create_dynamic_image_engine(config: {
	options: Readonly<{ dynamic?: readonly string[] }>;
	imagetoolsPlugin: Plugin;
	isOwner: (filename: string) => boolean;
	ownerKey: (filename: string, root: string) => string;
	logLabel?: string;
}): DynamicImageEngine;

export function render_composite_resolver(
	name: string,
	profiles: readonly { query: string; pictures: string }[],
	warned: string,
	defaultReason: 'path' | 'query',
	classifier: string | undefined,
	profilesName: string | undefined,
	parseSource: string | undefined,
	parseQuery: string | undefined,
	diagnostic?: string
): string;

export function create_dynamic_file_matcher(
	patterns: readonly string[],
	root: string
): (filename: string) => boolean;
export function invalidate_virtual_modules(
	server: import('vite').ViteDevServer | undefined,
	ids: readonly string[],
	seen?: Set<import('vite').ModuleNode>
): void;
export function same_dynamic_candidates(
	left: readonly Pick<DynamicCandidate, 'source' | 'key' | 'keys'>[],
	right: readonly Pick<DynamicCandidate, 'source' | 'key' | 'keys'>[]
): boolean;

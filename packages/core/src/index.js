export {
	OPTIMIZABLE_IMAGE_PATTERN,
	create_image_plugins,
	load_picture,
	parse_object,
	read_image_metadata
} from './pipeline.js';
export { normalize_options } from './options.js';
export {
	create_evaluation_context,
	evaluate_expression,
	extend_const_context,
	extend_iteration_context,
	extend_unknown_context
} from './dynamic/analyze/expression.js';
export { analyze_source } from './dynamic/analyze/source.js';
export { discover_candidates } from './dynamic/discover.js';
export { create_dynamic_image_engine } from './dynamic/engine.js';
export {
	create_dynamic_file_matcher,
	invalidate_virtual_modules,
	same_dynamic_candidates
} from './dynamic/matcher.js';
export { canonicalize_runtime_source, module_runtime_key } from './dynamic/paths.js';
export { canonicalize_public_query } from './dynamic/queries.js';
export { render_composite_resolver } from './dynamic/resolver.js';
export {
	CATALOG_MODULE_ID,
	RUNTIME_MODULE_ID,
	create_dynamic_virtual_modules
} from './dynamic/virtual.js';

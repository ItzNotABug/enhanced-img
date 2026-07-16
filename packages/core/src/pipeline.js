import path from 'node:path';
import sharp from 'sharp';
import { imagetools } from 'vite-imagetools';
import { extend_transforms, with_bounded_encodes } from './encode.js';

const ORIGINAL_IMAGETOOLS_INCLUDE = /^[^?]+\.(avif|gif|heif|jpeg|jpg|png|tiff|webp)(\?.*)?$/;
const DYNAMIC_IMAGETOOLS_INCLUDE = /^[^?]+\.(avif|gif|heif|jpeg|jpg|png|tiff|webp)(\?.*)?$/i;

/**
 * Create the public image pipeline and the broader private pipeline used for
 * explicitly catalogued public files. Both references share the same bounded
 * encode queue.
 *
 * @param {boolean} dynamic_enabled
 * @returns {{ publicPlugin: import('vite').Plugin, catalogPlugin: import('vite').Plugin }}
 */
export function create_image_plugins(dynamic_enabled) {
	const catalog_plugin = imagetools_plugin(dynamic_enabled);
	return {
		publicPlugin: dynamic_enabled ? preserve_public_exclusion(catalog_plugin) : catalog_plugin,
		catalogPlugin: catalog_plugin
	};
}

/**
 * Read intrinsic metadata without making framework adapters depend on Sharp.
 *
 * @param {string} id
 */
export function read_image_metadata(id) {
	return sharp(id).metadata();
}

/**
 * Run a resolved image through vite-imagetools and parse its generated picture.
 *
 * @param {string} resolved_id
 * @param {import('vite').Rollup.PluginContext} plugin_context
 * @param {import('vite').Plugin} imagetools_plugin
 * @returns {Promise<import('vite-imagetools').Picture>}
 */
export async function load_picture(resolved_id, plugin_context, imagetools_plugin) {
	if (!imagetools_plugin.load) {
		throw new Error('Invalid instance of vite-imagetools. Could not find load method.');
	}
	const hook = imagetools_plugin.load;
	const handler = typeof hook === 'object' ? hook.handler : hook;
	const module_info = await handler.call(plugin_context, resolved_id);
	if (!module_info) throw new Error(`Could not load ${resolved_id}`);
	const code = typeof module_info === 'string' ? module_info : module_info.code;
	return parse_object(code.replace('export default', '').replace(/;$/, '').trim());
}

/** @param {string} value */
export function parse_object(value) {
	const updated = value
		.replaceAll(/{(\n\s*)?/gm, '{"')
		.replaceAll(':', '":')
		.replaceAll(/,(\n\s*)?([^ ])/g, ',"$2');
	try {
		return JSON.parse(updated);
	} catch {
		throw new Error(`Failed parsing string to object: ${value}`);
	}
}

/**
 * Keep vite-imagetools' normal publicDir exclusion on its public Vite hook,
 * while the private dynamic loader can still invoke the underlying broad hook
 * for explicitly catalogued public files.
 *
 * @param {import('vite').Plugin} plugin
 * @returns {import('vite').Plugin}
 */
function preserve_public_exclusion(plugin) {
	/** @type {string | undefined} */
	let public_dir;
	const config_resolved = plugin.configResolved;
	const load = plugin.load;

	return {
		...plugin,
		configResolved(config) {
			public_dir = config.publicDir ? path.resolve(config.publicDir) : undefined;
			if (!config_resolved) return;
			const handler =
				typeof config_resolved === 'object' ? config_resolved.handler : config_resolved;
			return handler.call(this, config);
		},
		async load(id) {
			if (public_dir && is_file_beneath(id, public_dir)) return null;
			if (!ORIGINAL_IMAGETOOLS_INCLUDE.test(id)) return null;
			if (!load) return null;
			const handler = typeof load === 'object' ? load.handler : load;
			return handler.call(this, id);
		}
	};
}

/**
 * @param {string} id
 * @param {string} directory
 */
function is_file_beneath(id, directory) {
	let filename;
	try {
		filename = path.resolve(decodeURIComponent(id.split('?', 1)[0]));
	} catch {
		return false;
	}
	const relative = path.relative(directory, filename);
	return (
		relative !== '' &&
		relative !== '..' &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

/**
 * @param {import('sharp').Metadata} meta
 * @returns {string}
 */
function fallback_format(meta) {
	if (meta.pages && meta.pages > 1) return meta.format === 'tiff' ? 'tiff' : 'gif';
	if (meta.hasAlpha) return 'png';
	return 'jpg';
}

/** @param {boolean} allow_public */
function imagetools_plugin(allow_public = false) {
	/** @type {Partial<import('vite-imagetools').VitePluginOptions>} */
	const imagetools_opts = {
		...(allow_public && {
			exclude: undefined,
			include: DYNAMIC_IMAGETOOLS_INCLUDE
		}),
		defaultDirectives: async ({ pathname, searchParams: qs }, metadata) => {
			if (!qs.has('enhanced')) return new URLSearchParams();

			const meta = await metadata();
			const img_width = qs.get('imgWidth');
			const width = img_width ? parseInt(img_width) : meta.width;

			if (!width) {
				console.warn(`Could not determine width of image ${pathname}`);
				return new URLSearchParams();
			}

			const { widths, kind } = get_widths(width, qs.get('imgSizes'));
			return new URLSearchParams({
				as: 'picture',
				format: `avif;webp;${fallback_format(meta)}`,
				w: widths.join(';'),
				...(kind === 'x' && !qs.has('w') && { basePixels: widths[0].toString() })
			});
		},
		namedExports: false,
		extendTransforms: extend_transforms
	};

	return with_bounded_encodes(imagetools(imagetools_opts));
}

/**
 * @param {number} width
 * @param {string | null} sizes
 * @returns {{ widths: number[]; kind: 'w' | 'x' }}
 */
function get_widths(width, sizes) {
	if (sizes) {
		const widths = [540, 768, 1080, 1366, 1536, 1920, 2560, 3000, 4096, 5120];
		widths.push(width);
		return { widths, kind: 'w' };
	}

	return { widths: [Math.round(width / 2), width], kind: 'x' };
}

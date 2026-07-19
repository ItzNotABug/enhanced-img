import os from 'node:os';
import process from 'node:process';
import { getMetadata, setMetadata } from 'vite-imagetools';
import { format_emage_log } from './logger.js';

const IMAGE_QUERY_ID = /^[^?]+\.(avif|gif|heif|jpeg|jpg|png|tiff|webp)\?./i;
// Vite-owned asset queries load instantly and must not wait behind encodes.
const PASSTHROUGH_QUERY = /\?(?:url|raw|inline|no-inline|worker|sharedworker)$/;
const CHROMA_FORMATS = new Set(['avif', 'heif', 'jpg', 'jpeg']);
const CHROMA_VALUES = new Set(['4:2:0', '4:4:4']);

/**
 * Add the `chromaSubsampling` directive to the built-in vite-imagetools
 * transforms. Sharp's AVIF default is 4:4:4; 4:2:0 encodes faster and smaller
 * for photographic content.
 *
 * @param {import('vite-imagetools').TransformFactory[]} builtins
 * @returns {import('vite-imagetools').TransformFactory[]}
 */
export function extend_transforms(builtins) {
	return [...builtins, chroma_subsampling];
}

/** @type {import('vite-imagetools').TransformFactory<{ chromaSubsampling?: string }>} */
function chroma_subsampling(config, context) {
	const value = config.chromaSubsampling;
	if (value === undefined) return;
	context?.useParam?.('chromaSubsampling');
	if (!CHROMA_VALUES.has(value)) {
		throw new Error(
			`@itznotabug/emage-core: chromaSubsampling must be "4:2:0" or "4:4:4", received ${JSON.stringify(value)}`
		);
	}

	return function chromaSubsamplingTransform(image) {
		const format = getMetadata(image, 'format');
		if (typeof format !== 'string' || !CHROMA_FORMATS.has(format)) return image;
		setMetadata(image, 'chromaSubsampling', value);

		// Re-issue the format's encode options; the last toFormat call wins.
		return image.toFormat(/** @type {keyof import('sharp').FormatEnum} */ (format), {
			compression: format === 'heif' ? 'av1' : undefined,
			effort: /** @type {number | undefined} */ (getMetadata(image, 'effort')),
			lossless: /** @type {boolean | undefined} */ (getMetadata(image, 'lossless')),
			progressive: /** @type {boolean | undefined} */ (getMetadata(image, 'progressive')),
			quality: /** @type {number | undefined} */ (getMetadata(image, 'quality')),
			chromaSubsampling: value
		});
	};
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function default_encode_concurrency(env = process.env) {
	const parsed = Number.parseInt(env.EMAGE_ENCODE_CONCURRENCY ?? '', 10);
	if (Number.isInteger(parsed) && parsed > 0) return parsed;
	const cores =
		typeof os.availableParallelism === 'function'
			? os.availableParallelism()
			: os.cpus().length || 1;
	return Math.max(1, cores);
}

/**
 * A minimal FIFO semaphore. Bounds how many encode pipelines hold decoded
 * image data at once so constrained containers do not thrash memory.
 *
 * @param {number} limit
 * @returns {<T>(task: () => Promise<T> | T) => Promise<T>}
 */
export function create_semaphore(limit) {
	let active = 0;
	/** @type {Array<() => void>} */
	const waiting = [];

	function release() {
		const next = waiting.shift();
		if (next) next();
		else active--;
	}

	return async function run(task) {
		if (active >= limit) {
			await new Promise((resolve) => waiting.push(/** @type {() => void} */ (resolve)));
		} else {
			active++;
		}
		try {
			return await task();
		} finally {
			release();
		}
	};
}

/**
 * Bound the plugin's image loads with a semaphore and report a build summary.
 * Every enhanced image — literal or dynamic-catalog — flows through this load
 * hook, so this is the single choke point for encode work.
 *
 * @param {import('vite').Plugin} plugin
 * @param {{ concurrency?: number, label?: string }} [options]
 * @returns {import('vite').Plugin}
 */
export function with_bounded_encodes(plugin, options = {}) {
	const run = create_semaphore(options.concurrency ?? default_encode_concurrency());
	const label = options.label ?? 'emage';
	const original_config_resolved = plugin.configResolved;
	const original_load = plugin.load;
	const original_build_end = plugin.buildEnd;
	const original_write_bundle = plugin.writeBundle;

	let is_build = false;
	let is_ssr_build = false;
	let verbose = true;
	let processed = 0;
	let started = 0;

	function report_done() {
		if (!verbose || processed === 0 || is_ssr_build) return;
		const seconds = Math.round((Date.now() - started) / 100) / 10;
		if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
		console.log(
			format_emage_log(
				label,
				`optimized ${processed} ${processed === 1 ? 'image' : 'images'} in ${seconds}s`,
				'success'
			)
		);
	}

	function reset_progress() {
		processed = 0;
		started = 0;
	}

	return {
		...plugin,
		configResolved(config) {
			is_build = config.command === 'build';
			is_ssr_build = Boolean(config.build?.ssr);
			verbose = config.logLevel !== 'silent';
			if (!original_config_resolved) return;
			const handler =
				typeof original_config_resolved === 'object'
					? original_config_resolved.handler
					: original_config_resolved;
			return handler.call(this, config);
		},
		async load(id) {
			if (!original_load) return;
			const handler = typeof original_load === 'object' ? original_load.handler : original_load;
			if (!IMAGE_QUERY_ID.test(id) || PASSTHROUGH_QUERY.test(id)) {
				return handler.call(this, id);
			}

			const context = this;
			return run(async () => {
				if (processed === 0 && started === 0) started = Date.now();
				const result = await handler.call(context, id);
				if (result != null) {
					processed++;
				}
				return result;
			});
		},
		buildEnd(error) {
			if (error && is_build) reset_progress();
			if (!original_build_end) return;
			const handler =
				typeof original_build_end === 'object' ? original_build_end.handler : original_build_end;
			return handler.call(this, error);
		},
		async writeBundle(options, bundle) {
			let result;
			if (original_write_bundle) {
				const handler =
					typeof original_write_bundle === 'object'
						? original_write_bundle.handler
						: original_write_bundle;
				result = await handler.call(this, options, bundle);
			}
			if (is_build) report_done();
			reset_progress();
			return result;
		}
	};
}

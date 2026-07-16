import os from 'node:os';
import process from 'node:process';
import { getMetadata, setMetadata } from 'vite-imagetools';

const IMAGE_QUERY_ID = /^[^?]+\.(avif|gif|heif|jpeg|jpg|png|tiff|webp)\?./i;
// Vite-owned asset queries load instantly and must not wait behind encodes.
const PASSTHROUGH_QUERY = /\?(?:url|raw|inline|no-inline|worker|sharedworker)$/;
const CHROMA_FORMATS = new Set(['avif', 'heif', 'jpg', 'jpeg']);
const CHROMA_VALUES = new Set(['4:2:0', '4:4:4']);
const PROGRESS_INTERVAL = 25;

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
	const parsed = Number.parseInt(env.ENHANCED_IMG_ENCODE_CONCURRENCY ?? '', 10);
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

// Clears the current terminal line: rolldown/rollup write their transient
// "transforming (n) ..." status without a trailing newline.
const CLEAR_LINE = '\r\x1b[2K';

/**
 * Bound the plugin's image loads with a semaphore and report build progress.
 * Every enhanced image — literal or dynamic-catalog — flows through this load
 * hook, so this is the single choke point for encode work.
 *
 * Interactive terminals get one self-erasing progress line so only the final
 * catalog summary survives in scrollback; captured logs (CI, deploy consoles)
 * get durable heartbeat lines instead, where overwriting is impossible and
 * long encode phases would otherwise look like hangs.
 *
 * @param {import('vite').Plugin} plugin
 * @param {{ concurrency?: number, interactive?: boolean }} [options]
 * @returns {import('vite').Plugin}
 */
export function with_bounded_encodes(plugin, options = {}) {
	const run = create_semaphore(options.concurrency ?? default_encode_concurrency());
	const interactive = options.interactive ?? Boolean(process.stdout.isTTY);
	const original_config_resolved = plugin.configResolved;
	const original_load = plugin.load;
	const original_build_end = plugin.buildEnd;

	let is_build = false;
	let verbose = true;
	/** @type {Pick<import('vite').Logger, 'info'> | undefined} */
	let logger;
	let processed = 0;
	let started = 0;
	let rendered = false;

	/** @param {number} count */
	function report_progress(count) {
		if (interactive) {
			if (!verbose) return;
			rendered = true;
			process.stdout.write(`${CLEAR_LINE}@itznotabug/emage-core: processed ${count} images...`);
		} else if (count % PROGRESS_INTERVAL === 0) {
			logger?.info(`@itznotabug/emage-core: processed ${count} images...`);
		}
	}

	function report_done() {
		if (interactive) {
			if (rendered) process.stdout.write(CLEAR_LINE);
			rendered = false;
		} else if (processed > 0) {
			const seconds = Math.round((Date.now() - started) / 100) / 10;
			logger?.info(`@itznotabug/emage-core: processed ${processed} images in ${seconds}s`);
		}
	}

	return {
		...plugin,
		configResolved(config) {
			is_build = config.command === 'build';
			verbose = (config.logLevel ?? 'info') === 'info';
			logger = config.logger;
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
				const result = await handler.call(context, id);
				if (result != null) {
					if (processed === 0) started = Date.now();
					processed++;
					if (is_build) report_progress(processed);
				}
				return result;
			});
		},
		buildEnd(error) {
			if (is_build) report_done();
			processed = 0;
			if (!original_build_end) return;
			const handler =
				typeof original_build_end === 'object' ? original_build_end.handler : original_build_end;
			return handler.call(this, error);
		}
	};
}

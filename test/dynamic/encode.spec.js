import sharp from 'sharp';
import { applyTransforms, builtins, generateTransforms } from 'vite-imagetools';
import { describe, expect, it, vi } from 'vitest';
import {
	create_semaphore,
	default_encode_concurrency,
	extend_transforms,
	with_bounded_encodes
} from '../../src/encode.js';

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gradient_png() {
	// Chroma-rich diagonal gradient so subsampling measurably changes output.
	const width = 64;
	const height = 32;
	const data = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 3;
			data[i] = (x * 4) % 256;
			data[i + 1] = (y * 8) % 256;
			data[i + 2] = ((x + y) * 5) % 256;
		}
	}
	return sharp(data, { raw: { width, height, channels: 3 } })
		.png()
		.toBuffer();
}

describe('create_semaphore', () => {
	it('bounds concurrent tasks and preserves results', async () => {
		const run = create_semaphore(3);
		let active = 0;
		let max_active = 0;

		const results = await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				run(async () => {
					active++;
					max_active = Math.max(max_active, active);
					await sleep(10);
					active--;
					return index;
				})
			)
		);

		expect(max_active).toBe(3);
		expect(results).toEqual(Array.from({ length: 12 }, (_, index) => index));
	});

	it('releases slots when tasks throw', async () => {
		const run = create_semaphore(1);
		await expect(run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
		await expect(run(() => 'next')).resolves.toBe('next');
	});
});

describe('default_encode_concurrency', () => {
	it('prefers a valid environment override', () => {
		expect(default_encode_concurrency({ ENHANCED_IMG_ENCODE_CONCURRENCY: '3' })).toBe(3);
	});

	it('falls back to a bounded core count for invalid overrides', () => {
		for (const value of [undefined, '0', '-2', 'lots']) {
			const concurrency = default_encode_concurrency({ ENHANCED_IMG_ENCODE_CONCURRENCY: value });
			expect(concurrency).toBeGreaterThanOrEqual(1);
			expect(concurrency).toBeLessThanOrEqual(8);
		}
	});
});

describe('chromaSubsampling directive', () => {
	const factory = extend_transforms([]).at(-1);
	if (!factory) throw new Error('extend_transforms did not append a factory');

	it('is appended after the builtin transforms', () => {
		const builtin = () => undefined;
		expect(extend_transforms([builtin]).at(0)).toBe(builtin);
		expect(extend_transforms([builtin])).toHaveLength(2);
	});

	it('ignores configs without the directive and marks the parameter used', () => {
		const context = { useParam: vi.fn(), manualSearchParams: new URLSearchParams(), logger: {} };
		expect(factory({}, /** @type {any} */ (context))).toBeUndefined();
		expect(context.useParam).not.toHaveBeenCalled();

		factory({ chromaSubsampling: '4:2:0' }, /** @type {any} */ (context));
		expect(context.useParam).toHaveBeenCalledWith('chromaSubsampling');
	});

	it('rejects values other than 4:2:0 and 4:4:4', () => {
		expect(() => factory({ chromaSubsampling: '4:2:2' }, /** @type {any} */ ({}))).toThrow(
			'chromaSubsampling'
		);
	});

	/**
	 * Run a directive config through the real imagetools pipeline with our
	 * extended transform set, exactly as builds do.
	 *
	 * @param {Record<string, string>} config
	 */
	async function encode(config) {
		const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const { transforms } = generateTransforms(
			config,
			extend_transforms([...builtins]),
			new URLSearchParams(),
			/** @type {any} */ (logger)
		);
		const { image } = await applyTransforms(transforms, sharp(await gradient_png()));
		return image.toBuffer();
	}

	it('changes avif output bytes and keeps the format decodable', async () => {
		const baseline = await encode({ format: 'avif', quality: '60' });
		const subsampled = await encode({ format: 'avif', quality: '60', chromaSubsampling: '4:2:0' });

		expect(subsampled.equals(baseline)).toBe(false);
		expect(subsampled.length).toBeLessThan(baseline.length);
		expect((await sharp(subsampled).metadata()).format).toBe('heif');
	});

	it('leaves non-chroma formats untouched', async () => {
		const baseline = await encode({ format: 'webp', quality: '60' });
		const with_directive = await encode({
			format: 'webp',
			quality: '60',
			chromaSubsampling: '4:2:0'
		});
		expect(with_directive.equals(baseline)).toBe(true);
	});
});

describe('with_bounded_encodes', () => {
	/** @param {{ load: (id: string) => unknown, concurrency?: number, interactive?: boolean }} options */
	function create_wrapped({ load, concurrency = 2, interactive = false }) {
		const info = vi.fn();
		const plugin = with_bounded_encodes(/** @type {any} */ ({ name: 'fake-imagetools', load }), {
			concurrency,
			interactive
		});
		const config_resolved =
			typeof plugin.configResolved === 'object'
				? plugin.configResolved.handler
				: plugin.configResolved;
		config_resolved?.call(
			/** @type {any} */ ({}),
			/** @type {any} */ ({ command: 'build', logger: { info } })
		);
		return { plugin, info };
	}

	it('bounds image loads while passing other modules straight through', async () => {
		let active = 0;
		let max_active = 0;
		const { plugin } = create_wrapped({
			load: async () => {
				active++;
				max_active = Math.max(max_active, active);
				await sleep(10);
				active--;
				return 'picture';
			},
			concurrency: 2
		});
		const load = typeof plugin.load === 'object' ? plugin.load.handler : plugin.load;
		if (!load) throw new Error('expected a load hook');

		const image_loads = Array.from({ length: 8 }, (_, index) =>
			load.call(/** @type {any} */ ({}), `/assets/photo-${index}.png?enhanced`)
		);
		await Promise.all(image_loads);
		expect(max_active).toBe(2);

		// A saturated semaphore must not delay non-image module loads.
		const slow_images = Array.from({ length: 4 }, (_, index) =>
			load.call(/** @type {any} */ ({}), `/assets/slow-${index}.png?enhanced`)
		);
		const order = [];
		await Promise.all([
			...slow_images.map((p) => p.then(() => order.push('image'))),
			load.call(/** @type {any} */ ({}), '/src/routes/module.js').then(() => order.push('module'))
		]);
		// The module races the first image wave but must beat the queued wave.
		expect(order.indexOf('module')).toBeLessThan(3);
	});

	it('reports progress every 25 processed images and a build summary', async () => {
		const { plugin, info } = create_wrapped({ load: () => 'picture', concurrency: 4 });
		const load = typeof plugin.load === 'object' ? plugin.load.handler : plugin.load;
		const build_end =
			typeof plugin.buildEnd === 'object' ? plugin.buildEnd.handler : plugin.buildEnd;
		if (!load || !build_end) throw new Error('expected load and buildEnd hooks');

		await Promise.all(
			Array.from({ length: 26 }, (_, index) =>
				load.call(/** @type {any} */ ({}), `/assets/photo-${index}.png?enhanced`)
			)
		);
		expect(info).toHaveBeenCalledWith('@itznotabug/enhanced-img: processed 25 images...');

		build_end.call(/** @type {any} */ ({}));
		const summary = info.mock.calls.at(-1)?.[0];
		expect(summary).toMatch(/processed 26 images in \d+(\.\d+)?s/);
	});

	it('renders a self-erasing progress line on interactive terminals', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		try {
			const { plugin, info } = create_wrapped({
				load: () => 'picture',
				concurrency: 4,
				interactive: true
			});
			const load = typeof plugin.load === 'object' ? plugin.load.handler : plugin.load;
			const build_end =
				typeof plugin.buildEnd === 'object' ? plugin.buildEnd.handler : plugin.buildEnd;
			if (!load || !build_end) throw new Error('expected load and buildEnd hooks');

			await load.call(/** @type {any} */ ({}), '/assets/one.png?enhanced');
			await load.call(/** @type {any} */ ({}), '/assets/two.png?enhanced');
			const updates = write.mock.calls.map((call) => String(call[0]));
			expect(updates.at(-1)).toBe('\r\x1b[2K@itznotabug/enhanced-img: processed 2 images...');

			build_end.call(/** @type {any} */ ({}));
			// The line is erased and no durable summary is written.
			expect(write.mock.calls.map((call) => String(call[0])).at(-1)).toBe('\r\x1b[2K');
			expect(info).not.toHaveBeenCalled();
		} finally {
			write.mockRestore();
		}
	});

	it('stays silent when nothing was processed', () => {
		const { plugin, info } = create_wrapped({ load: () => null });
		const build_end =
			typeof plugin.buildEnd === 'object' ? plugin.buildEnd.handler : plugin.buildEnd;
		build_end?.call(/** @type {any} */ ({}));
		expect(info).not.toHaveBeenCalled();
	});
});

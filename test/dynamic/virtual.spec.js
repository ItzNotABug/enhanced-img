import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
	ASSET_MODULE_PREFIX,
	CATALOG_MODULE_ID,
	RUNTIME_MODULE_ID,
	create_dynamic_virtual_modules
} from '../../src/dynamic/virtual.js';

const source_a = path.resolve('test/fixtures/a.jpg');
const source_b = path.resolve('test/fixtures/b.jpg');

function create_registry(overrides = {}) {
	return create_dynamic_virtual_modules({
		imagetools_plugin: {
			name: 'imagetools-mock',
			load: vi.fn(() => "export default { sources: {}, img: { src: 'x', w: 1, h: 1 } }")
		},
		candidates: [{ key: '/src/assets/a.jpg', source: source_a }],
		patterns: ['src/assets/**/*.jpg'],
		...overrides
	});
}

describe('dynamic virtual module registry', () => {
	it('uses stable profile hashes and deduplicates asset jobs', () => {
		const registry = create_registry({
			candidates: [{ keys: ['/src/assets/a.jpg', '/images/a.jpg'], source: source_a }]
		});
		const register_candidate_assets = vi.spyOn(registry, 'register_candidate_assets');
		const first = registry.register_profile({ query: 'w=400%3B800&quality=75' });
		const second = registry.register_profile({ query: 'quality=75&w=400;800' });

		expect(second).toEqual(first);
		expect(registry.profiles).toHaveLength(1);
		expect(registry.assets).toHaveLength(1);
		expect(register_candidate_assets).toHaveBeenCalledTimes(1);
		expect(first.id).toMatch(/^virtual:enhanced-img\/dynamic\/[a-f\d]{64}$/);
	});

	it('keeps attribute-distinct profiles but reuses identical asset work', () => {
		const registry = create_registry();
		const one = registry.register_profile({ query: 'quality=75', sizes: '100vw' });
		const two = registry.register_profile({ query: 'quality=75', sizes: '50vw' });
		const again = registry.register_profile({ query: 'quality=75', sizes: '100vw' });

		expect(one.id).not.toBe(two.id);
		expect(again.id).toBe(one.id);
		expect(registry.profiles).toHaveLength(2);
		expect(registry.assets).toHaveLength(2);
	});

	it('refreshes every profile and prunes asset jobs for removed candidates', () => {
		const registry = create_registry();
		registry.register_profile({ query: 'quality=75' });
		registry.register_profile({ query: 'quality=80' });
		const original_tokens = [...registry.assets.keys()];

		const added = registry.set_candidates([
			{ key: '/src/assets/a.jpg', source: source_a },
			{ key: '/src/assets/b.jpg', source: source_b }
		]);

		expect([...registry.profiles.values()].map((profile) => profile.entries)).toEqual([
			expect.arrayContaining([
				expect.arrayContaining(['/src/assets/a.jpg']),
				expect.arrayContaining(['/src/assets/b.jpg'])
			]),
			expect.arrayContaining([
				expect.arrayContaining(['/src/assets/a.jpg']),
				expect.arrayContaining(['/src/assets/b.jpg'])
			])
		]);
		expect(registry.assets).toHaveLength(4);
		expect(added.profileIds).toHaveLength(2);
		expect(added.removedAssetIds).toEqual([]);

		const removed = registry.set_candidates([{ key: '/src/assets/b.jpg', source: source_b }]);

		expect([...registry.profiles.values()].every((profile) => profile.entries.length === 1)).toBe(
			true
		);
		expect(registry.assets).toHaveLength(2);
		expect(removed.removedAssetIds).toHaveLength(2);
		for (const token of original_tokens) {
			expect(registry.resolve_id(ASSET_MODULE_PREFIX + token)).toBeUndefined();
		}
	});

	it('retires component-owned profiles and their unreferenced asset jobs', () => {
		const registry = create_registry();
		const first = registry.register_profile({ query: 'quality=75' });
		const second = registry.register_profile({ query: 'quality=80' });
		registry.set_owner_profiles('/src/A.svelte', [first.hash]);
		registry.set_owner_profiles('/src/B.svelte', [second.hash]);

		const retired = registry.set_owner_profiles('/src/A.svelte', [second.hash]);
		expect(retired.profileIds).toEqual([`\0${first.id}`]);
		expect(registry.profiles).toHaveLength(1);
		expect(registry.assets).toHaveLength(1);

		registry.release_owner('/src/B.svelte');
		expect(registry.profiles).toHaveLength(1);
		registry.release_owner('/src/A.svelte');
		expect(registry.profiles).toHaveLength(0);
		expect(registry.assets).toHaveLength(0);
	});

	it('resolves only registered private IDs and emits an O(1) Map resolver', async () => {
		const registry = create_registry();
		const profile = registry.register_profile({ query: 'quality=75' });
		const resolved = registry.resolve_id(profile.id);
		expect(resolved).toBe(`\0${profile.id}`);
		expect(registry.resolve_id('virtual:enhanced-img/dynamic/missing')).toBeUndefined();

		const code = await registry.load_with_context(mock_context(), resolved);
		expect(code).toContain('export const pictures = new Map(');
		expect(code).not.toContain('.find(');
		expect(code).not.toContain(source_a);
		expect(code).not.toContain('/@fs/');

		const runtime_id = registry.resolve_id(RUNTIME_MODULE_ID);
		expect(runtime_id).toBe(`\0${RUNTIME_MODULE_ID}`);
		const runtime_code = await registry.load_with_context(mock_context(), runtime_id);
		expect(runtime_code).toContain('__eimg_source as parse_source');
		expect(runtime_code).toContain('__eimg_query as parse_query');
	});

	it('emits a path-only catalog classifier without absolute source paths', async () => {
		const registry = create_registry({
			aliases: [{ type: 'string', find: '$img', replacement: '/src/assets' }]
		});
		const code = await registry.load_with_context(
			mock_context(),
			registry.resolve_id(CATALOG_MODULE_ID)
		);
		const runtime_code = await registry.load_with_context(
			mock_context(),
			registry.resolve_id(RUNTIME_MODULE_ID)
		);
		const runtime = execute_runtime(runtime_code);
		const catalog = execute_catalog(code, runtime);

		expect(catalog.classify_path('$img/a.jpg?quality=75', '/src/App.svelte')).toEqual({
			kind: 'local',
			exists: true,
			source: '/src/assets/a.jpg?quality=75'
		});
		expect(catalog.classify_path('/src/assets/missing.jpg', '/src/App.svelte')).toEqual({
			kind: 'local',
			exists: false,
			source: '/src/assets/missing.jpg'
		});
		expect(catalog.classify_path('https://cdn.test/a.jpg', '/src/App.svelte')).toEqual({
			kind: 'external',
			source: 'https://cdn.test/a.jpg'
		});
		expect(code).not.toContain(source_a);
		expect(code).not.toContain('/@fs/');
	});

	it('adds a watch file and delegates asset ESM directly to imagetools', async () => {
		const load = vi.fn(function (_id) {
			expect(this.marker).toBe(true);
			return { code: 'export default {picture: true}', map: null };
		});
		const registry = create_registry({ imagetools_plugin: { name: 'mock', load } });
		registry.register_profile({ query: 'quality=75' });
		const token = [...registry.assets.keys()][0];
		const public_id = ASSET_MODULE_PREFIX + token;
		const resolved_id = registry.resolve_id(public_id);
		const context = mock_context();
		const result = await registry.load_with_context(context, resolved_id);

		expect(context.addWatchFile).toHaveBeenCalledWith(source_a);
		expect(load).toHaveBeenCalledWith(`${source_a}?enhanced=&quality=75`);
		expect(result).toEqual({ code: 'export default {picture: true}', map: null });
	});

	it('rejects runtime-key collisions before generating modules', () => {
		expect(() =>
			create_registry({
				candidates: [
					{ key: '/images/same.jpg', source: source_a },
					{ key: '/images/same.jpg', source: source_b }
				]
			})
		).toThrow(/canonical runtime key collision.*a\.jpg.*b\.jpg/);
	});
});

describe('generated shared runtime', () => {
	it('normalizes paths, aliases, and exact finite queries', async () => {
		const registry = create_registry({
			aliases: [
				{ type: 'string', find: '$img', replacement: '/src/assets' },
				{ type: 'string', find: '$root', replacement: '/' }
			]
		});
		const profile = registry.register_profile({ query: 'quality=true&w=400;800' });
		const runtime_code = await registry.load_with_context(
			mock_context(),
			registry.resolve_id(RUNTIME_MODULE_ID)
		);
		const profile_code = await registry.load_with_context(
			mock_context(),
			registry.resolve_id(profile.id)
		);
		const picture = { sources: { webp: 'a.webp' }, img: { src: 'a.jpg', w: 10, h: 5 } };
		const runtime = execute_runtime(runtime_code);
		const pictures = execute_picture_map(profile_code, picture);
		const resolve = (value, importer) => {
			const parsed = runtime.parse_source(value, importer);
			if (parsed.kind !== 'local') return undefined;
			if (runtime.parse_query(parsed.query) !== profile.publicQuery) return undefined;
			return pictures.get(parsed.path);
		};

		expect(resolve('$img/a.jpg?w=400%3B800&quality=TRUE', '/src/X.svelte')).toBe(picture);
		expect(resolve('$root/src/assets/a.jpg?w=400%3B800&quality=TRUE', '/src/X.svelte')).toBe(
			picture
		);
		expect(resolve('../assets/a.jpg?quality=true&w=400%3B800', '/src/routes/X.svelte')).toBe(
			picture
		);
		expect(resolve('https://cdn.test/a.jpg?quality=true', '/src/X.svelte')).toBeUndefined();
		expect(resolve('/src/assets/a.jpg?quality=false', '/src/X.svelte')).toBeUndefined();
		expect(runtime.parse_source('data:image/png,x', '/src/X.svelte')).toMatchObject({
			kind: 'external'
		});
		expect(runtime.parse_query('w=400%3B800&quality=TRUE')).toBe('quality=true&w=400%3B800');
	});
});

function mock_context() {
	return /** @type {import('vite').Rollup.PluginContext & { marker: boolean, addWatchFile: ReturnType<typeof vi.fn> }} */ (
		/** @type {unknown} */ ({ marker: true, addWatchFile: vi.fn() })
	);
}

function execute_picture_map(code, picture) {
	const executable = code
		.replace(/^import (\w+) from "virtual:enhanced-img\/asset\/[^"]+";$/gm, 'const $1 = __picture;')
		.replace('export const pictures =', 'return');
	return Function('__picture', executable)(picture);
}

function execute_runtime(code) {
	const executable = code.replace(
		'export { __eimg_source as parse_source, __eimg_query as parse_query };',
		'return { parse_source: __eimg_source, parse_query: __eimg_query };'
	);
	return Function(executable)();
}

function execute_catalog(code, runtime) {
	const executable = code
		.replace(
			'import { parse_source } from "virtual:enhanced-img/runtime";',
			'const { parse_source } = __runtime;'
		)
		.replace('export function classify_path', 'function classify_path')
		.concat('\nreturn { classify_path };');
	return Function('__runtime', executable)(runtime);
}

import { describe, expect, it } from 'vitest';
import {
	apply_aliases,
	canonical_collision_key,
	canonicalize_candidate_path,
	canonicalize_runtime_source,
	module_runtime_key,
	is_external_source,
	runtime_path_config
} from '#core/dynamic/paths.js';

describe('runtime path canonicalization', () => {
	it('handles root-relative, bare, and component-relative paths', () => {
		expect(
			canonicalize_runtime_source('/src/assets/a.jpg', '/src/routes/page.svelte')
		).toMatchObject({
			kind: 'local',
			path: '/src/assets/a.jpg',
			query: ''
		});
		expect(
			canonicalize_runtime_source('src/assets/a.jpg', '/src/routes/page.svelte')
		).toMatchObject({
			kind: 'local',
			path: '/src/assets/a.jpg'
		});
		expect(canonicalize_runtime_source('../assets/a.jpg', '/src/routes/page.svelte')).toMatchObject(
			{
				kind: 'local',
				path: '/src/assets/a.jpg'
			}
		);
	});

	it('applies serializable string and regex aliases before root normalization', () => {
		/** @type {Parameters<typeof apply_aliases>[1]} */
		const aliases = [
			{ type: 'string', find: '$lib', replacement: '/src/lib' },
			{
				type: 'regex',
				source: '^@images/(.*)$',
				flags: '',
				replacement: '/src/images/$1'
			}
		];
		expect(canonicalize_runtime_source('$lib/a.jpg', '/src/X.svelte', { aliases })).toMatchObject({
			kind: 'local',
			path: '/src/lib/a.jpg'
		});
		expect(
			canonicalize_runtime_source('@images/a.jpg', '/src/X.svelte', {
				aliases
			})
		).toMatchObject({
			kind: 'local',
			path: '/src/images/a.jpg'
		});
		expect(apply_aliases('$library/a.jpg', aliases)).toBe('$library/a.jpg');
	});

	it.each([
		'https://example.com/a.jpg?q=1',
		'http://example.com/a.jpg',
		'//cdn/a.jpg',
		'data:x',
		'blob:x',
		'ftp://x/a'
	])('passes external source %s through untouched', (source) => {
		expect(is_external_source(source)).toBe(true);
		expect(canonicalize_runtime_source(source, '/src/X.svelte')).toEqual({
			kind: 'external',
			source
		});
	});

	it('decodes each segment exactly once and normalizes Unicode to NFC', () => {
		expect(canonicalize_runtime_source('/images/cafe%CC%81.jpg', '/src/X.svelte')).toMatchObject({
			kind: 'local',
			path: '/images/caf\u00e9.jpg'
		});
		expect(canonicalize_runtime_source('/images/%252F.jpg', '/src/X.svelte')).toMatchObject({
			kind: 'local',
			path: '/images/%2F.jpg'
		});
	});

	it.each([
		['/images/%2fetc.jpg', 'encoded path separators'],
		['/images/%5cetc.jpg', 'encoded path separators'],
		['/images/%2e%2e/a.jpg', 'traversal'],
		['/images/../a.jpg', 'traversal'],
		['../../a.jpg', 'escapes'],
		['C:/images/a.jpg', 'drive-letter'],
		['/images/a\\b.jpg', 'backslashes'],
		['/images/a.jpg#x', 'fragments'],
		['/images/%00.jpg', 'NUL']
	])('rejects unsafe local path %s', (source, reason) => {
		expect(canonicalize_runtime_source(source, '/src/X.svelte')).toMatchObject({
			kind: 'invalid',
			reason: expect.stringContaining(reason)
		});
	});

	it('maps source-root and public candidates', () => {
		expect(canonicalize_candidate_path('src/assets/a.jpg', undefined)).toEqual({
			key: '/src/assets/a.jpg',
			rootKey: '/src/assets/a.jpg'
		});
		expect(canonicalize_candidate_path('public/images/a.jpg', 'images/a.jpg')).toEqual({
			key: '/images/a.jpg',
			rootKey: '/public/images/a.jpg'
		});
	});

	it('serializes aliases without absolute filesystem paths', () => {
		const warnings = [];
		const runtime = runtime_path_config(
			{
				root: '/work/app',
				publicDir: '/work/app/public',
				resolve: {
					alias: [
						{ find: '$lib', replacement: '/work/app/src/lib' },
						{ find: /^@img\/(.*)$/, replacement: '/work/app/public/images/$1' },
						{
							find: '$custom',
							replacement: '/work/app/src',
							customResolver() {}
						}
					]
				}
			},
			{ warn: (message) => warnings.push(message) }
		);
		expect(runtime.aliases).toEqual([
			{ type: 'string', find: '$lib', replacement: '/src/lib' },
			{
				type: 'regex',
				source: '^@img\\/(.*)$',
				flags: '',
				replacement: '/images/$1'
			}
		]);
		expect(JSON.stringify(runtime)).not.toContain('/work/app');
		expect(warnings).toHaveLength(1);
	});

	it('creates portable collision and module keys', () => {
		expect(canonical_collision_key('/IMG/Caf\u00c9.JPG')).toBe('/img/caf\u00e9.jpg');
		expect(canonical_collision_key('/Straße.JPG')).toBe(canonical_collision_key('/STRASSE.jpg'));
		expect(canonical_collision_key('/ς.jpg')).toBe(canonical_collision_key('/Σ.jpg'));
		expect(module_runtime_key('/work/app/src/routes/a.svelte?x', '/work/app')).toBe(
			'/src/routes/a.svelte'
		);
		expect(module_runtime_key('/src/routes/a.svelte', '/')).toBe('/src/routes/a.svelte');
	});

	it('joins aliases targeting the filesystem root without creating // paths', () => {
		const runtime = runtime_path_config({
			root: '/',
			resolve: { alias: [{ find: '$root', replacement: '/' }] }
		});
		expect(canonicalize_runtime_source('$root/src/a.jpg', '/src/X.svelte', runtime)).toMatchObject({
			kind: 'local',
			path: '/src/a.jpg'
		});
	});
});

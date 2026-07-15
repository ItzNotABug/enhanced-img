import { describe, expect, it } from 'vitest';
import {
	canonicalize_public_query,
	create_internal_query,
	create_query_profile,
	parse_query_entries
} from '../../src/dynamic/queries.js';

describe('query canonicalization', () => {
	it('accepts the default profile and normalizes ordering and encoding', () => {
		expect(canonicalize_public_query('')).toBe('');
		expect(canonicalize_public_query('w=400;800&quality=75')).toBe('quality=75&w=400%3B800');
		expect(canonicalize_public_query('flag&enabled=TRUE&disabled=False')).toBe(
			'disabled=false&enabled=true&flag='
		);
	});

	it('preserves order between repeated values of the same key', () => {
		expect(canonicalize_public_query('w=800&w=400&format=webp;avif')).toBe(
			'format=webp%3Bavif&w=800&w=400'
		);
	});

	it('removes internal fields from public keys', () => {
		expect(canonicalize_public_query('imgWidth=100&quality=75&enhanced&imgSizes=100vw')).toBe(
			'quality=75'
		);
	});

	it('adds only profile-derived internal fields', () => {
		expect(
			create_internal_query('quality=75&imgWidth=999', {
				sizes: '100vw',
				width: 640
			})
		).toBe('enhanced=&imgSizes=100vw&imgWidth=640&quality=75');
	});

	it('uses canonical queries and attributes in stable profile hashes', () => {
		const first = create_query_profile({
			query: 'w=400;800&quality=75',
			sizes: '100vw',
			patterns: ['src/**/*.jpg']
		});
		const reordered = create_query_profile({
			query: 'quality=75&w=400%3B800',
			sizes: '100vw',
			patterns: ['src/**/*.jpg']
		});
		expect(first.id).toBe(reordered.id);
		expect(first.id).toMatch(/^[a-f\d]{64}$/);
	});

	it('consolidates profiles whose sizes are inert under an explicit width list', () => {
		const gallery = create_query_profile({
			query: 'w=320;640;960&quality=75',
			sizes: '(max-width: 520px) 88vw, 331px',
			patterns: ['static/**/*.webp']
		});
		const before_after = create_query_profile({
			query: 'quality=75&w=320;640;960',
			sizes: '(max-width: 520px) 100vw, 366px',
			width: 640,
			patterns: ['static/**/*.webp']
		});
		expect(gallery.id).toBe(before_after.id);
		expect(gallery.internalQuery).not.toContain('imgSizes');
		expect(gallery.internalQuery).not.toContain('imgWidth');
		expect(gallery.sizes).toBeNull();
	});

	it('keeps sizes in the profile identity when widths are ladder-derived', () => {
		const first = create_query_profile({ query: 'quality=75', sizes: '100vw' });
		const other_sizes = create_query_profile({ query: 'quality=75', sizes: '50vw' });
		expect(first.id).not.toBe(other_sizes.id);
		expect(first.internalQuery).toContain('imgSizes=100vw');
	});

	it.each(['%=x', '=x', 'a=%', 'a=1&&b=2', 'a=1#fragment', 'a=%00'])(
		'rejects malformed query %s',
		(query) => expect(() => parse_query_entries(query)).toThrow()
	);

	it('diagnoses non-Picture output profiles', () => {
		expect(() => create_query_profile({ query: 'as=url' })).toThrow('must produce a Picture');
	});

	it('uses the last duplicate as directive and accepts picture subforms', () => {
		expect(() => create_query_profile({ query: 'as=url&as=picture:srcset' })).not.toThrow();
		expect(() => create_query_profile({ query: 'as=picture:srcset&as=url' })).toThrow(
			'must produce a Picture'
		);
		expect(create_query_profile({ query: 'as=picture:metadata' }).publicQuery).toBe(
			'as=picture%3Ametadata'
		);
	});
});

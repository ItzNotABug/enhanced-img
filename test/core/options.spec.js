import { describe, expect, it } from 'vitest';
import { normalize_options, resolve_dynamic_patterns } from '#core/options.js';

describe('dynamic option validation', () => {
	it('preserves the no-options fast path', () => {
		expect(normalize_options()).toEqual({});
		expect(resolve_dynamic_patterns(normalize_options(), '/project')).toBeUndefined();
	});

	it('normalizes string and Windows-style patterns', () => {
		expect(normalize_options({ dynamic: 'src\\assets\\**\\*.jpg' })).toEqual({
			dynamic: ['src/assets/**/*.jpg']
		});
		expect(
			resolve_dynamic_patterns(
				normalize_options({ dynamic: ['/src/**/*.jpg', '!src/drafts/**'] }),
				'/project'
			)
		).toEqual(['src/**/*.jpg', '!src/drafts/**']);
	});

	it.each([
		[null, 'options must be an object'],
		[{ queries: [] }, 'unknown option "queries"'],
		[{ dynamic: [] }, 'at least one positive'],
		[{ dynamic: ['!**/*.draft.jpg'] }, 'must follow at least one positive'],
		[{ dynamic: [42] }, 'must be a string']
	])('rejects invalid options %#', (input, message) => {
		expect(() => normalize_options(input)).toThrow(message);
	});

	it('rejects a positive pattern escaping Vite root', () => {
		const options = normalize_options({ dynamic: '../private/**/*.jpg' });
		expect(() => resolve_dynamic_patterns(options, '/project')).toThrow('outside the Vite root');
	});

	it.each([
		'{src,../private}/**/*.jpg',
		'@(src|../private)/**/*.jpg',
		'src/{images,../../private}/**/*.jpg'
	])('rejects an escaping glob expansion %s', (pattern) => {
		const options = normalize_options({ dynamic: pattern });
		expect(() => resolve_dynamic_patterns(options, '/project')).toThrow(
			'expansion that can escape'
		);
	});

	it('requires negative patterns to follow a positive pattern', () => {
		expect(() => normalize_options({ dynamic: ['!src/drafts/**', 'src/**/*.jpg'] })).toThrow(
			'must follow at least one positive'
		);
	});
});

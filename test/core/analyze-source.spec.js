import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import {
	create_evaluation_context,
	extend_iteration_context
} from '#core/dynamic/analyze/expression.js';
import {
	analyze_source,
	DynamicQueryVariantError,
	is_valid_directive_query
} from '#core/dynamic/analyze/source.js';
import { canonicalize_public_query } from '#core/dynamic/queries.js';

describe('dynamic src analysis', () => {
	it('registers the default profile for a wholly opaque path', () => {
		const { ast, expression } = fixture('<enhanced:img src={item.src} />');
		const result = analyze_source(expression, create_evaluation_context(ast.instance?.content));

		expect(result).toMatchObject({
			kind: 'analyzable',
			queries: [''],
			has_unknown_path: true
		});
	});

	it('extracts a finite suffix after one symbolic path region', () => {
		const { ast, expression } = fixture(`
			<script>const quality = compact ? 60 : 80</script>
			<enhanced:img src={\`${'${item.src}'}?w=400;800&quality=${'${quality}'}\`} />
		`);
		const context = create_evaluation_context(ast.instance.content);

		expect(
			analyze_source(expression, context, { canonicalize_query: canonicalize_public_query })
		).toMatchObject({
			kind: 'analyzable',
			queries: ['quality=60&w=400%3B800', 'quality=80&w=400%3B800'],
			has_unknown_path: true
		});
	});

	it('extracts correlated query values from a finite each source', () => {
		const { ast, expression, each } = fixture(`
			<script>
				const items = [
					{ src: '/a.jpg', quality: 60 },
					{ src: '/b.jpg', quality: 80 }
				];
			</script>
			{#each items as item}
				<enhanced:img src={\`${'${item.src}'}?quality=${'${item.quality}'}\`} />
			{/each}
		`);
		const context = extend_iteration_context(
			create_evaluation_context(ast.instance.content),
			iteration(each)
		);

		expect(analyze_source(expression, context)).toMatchObject({
			kind: 'analyzable',
			queries: ['quality=60', 'quality=80'],
			has_unknown_path: false
		});
	});

	it('rejects an opaque query suffix and separated opaque path regions', () => {
		const opaque_query = fixture('<enhanced:img src={`${item.src}?${queries}`} />');
		const split_path = fixture('<enhanced:img src={`${directory}/${filename}?quality=75`} />');

		expect(
			analyze_source(
				opaque_query.expression,
				create_evaluation_context(opaque_query.ast.instance?.content)
			)
		).toMatchObject({ kind: 'unknown', reason: 'query' });
		expect(
			analyze_source(
				split_path.expression,
				create_evaluation_context(split_path.ast.instance?.content)
			)
		).toMatchObject({ kind: 'unknown', reason: 'multiple-path-regions' });
	});

	it('applies the cap after canonical query deduplication', () => {
		const { ast, expression } = fixture(`
			<script>const query = compact ? 'w=400&quality=75' : 'quality=75&w=400'</script>
			<enhanced:img src={\`${'${item.src}'}?${'${query}'}\`} />
		`);
		const result = analyze_source(expression, create_evaluation_context(ast.instance.content), {
			cap: 1,
			canonicalize_query: canonicalize_public_query
		});

		expect(result).toMatchObject({
			kind: 'analyzable',
			queries: ['quality=75&w=400']
		});
	});

	it('throws a located build error at cap + 1 query variants', () => {
		const alternatives =
			Array.from({ length: 33 }, (_, index) => `c${index} ? '${index}' : `).join('') + "'32'";
		const { ast, expression } = fixture(`
			<script>const quality = ${alternatives}</script>
			<enhanced:img src={\`${'${item.src}'}?quality=${'${quality}'}\`} />
		`);
		const context = create_evaluation_context(ast.instance.content, { cap: 32 });

		expect(() =>
			analyze_source(expression, context, {
				cap: 32,
				filename: '/src/routes/example.svelte'
			})
		).toThrowError(DynamicQueryVariantError);
		try {
			analyze_source(expression, context, {
				cap: 32,
				filename: '/src/routes/example.svelte'
			});
		} catch (error) {
			expect(error).toMatchObject({
				code: 'EMAGE_QUERY_VARIANT_LIMIT',
				count: 33,
				cap: 32,
				exact: true,
				filename: '/src/routes/example.svelte'
			});
			expect(error.message).toContain('/src/routes/example.svelte:');
		}
	});

	it('recognizes required left-associative string concatenation', () => {
		const { ast, expression } = fixture("<enhanced:img src={item.src + '?quality=' + 75} />");
		expect(
			analyze_source(expression, create_evaluation_context(ast.instance?.content))
		).toMatchObject({
			kind: 'analyzable',
			queries: ['quality=75'],
			has_unknown_path: true
		});
	});

	it('rejects ambiguous opaque-plus-opaque concatenation', () => {
		const { ast, expression } = fixture(
			"<enhanced:img src={item.src + directory + '?quality=75'} />"
		);
		expect(
			analyze_source(expression, create_evaluation_context(ast.instance?.content))
		).toMatchObject({
			kind: 'unknown',
			reason: 'split-concatenation'
		});
	});

	it('never converts an incomplete path overflow into the default profile', () => {
		const { ast, expression } = fixture(`
			<script>const path = a ? '/a.jpg' : b ? '/b.jpg' : '/c.jpg'</script>
			<enhanced:img src={path} />
		`);
		expect(
			analyze_source(expression, create_evaluation_context(ast.instance.content), { cap: 1 })
		).toMatchObject({ kind: 'unknown', reason: 'overflow' });
	});

	it('preserves overflow provenance from a truncated finite each scope', () => {
		const { ast, expression, each } = fixture(`
			<script>
				const items = [
					{ src: '/a.jpg' },
					{ src: '/b.jpg' },
					{ src: '/c.jpg' }
				];
			</script>
			{#each items as item}<enhanced:img src={item.src} />{/each}
		`);
		const context = extend_iteration_context(
			create_evaluation_context(ast.instance.content, { cap: 1 }),
			iteration(each),
			{ cap: 1 }
		);
		expect(analyze_source(expression, context, { cap: 1 })).toMatchObject({
			kind: 'unknown',
			reason: 'overflow'
		});
	});

	it('marks a proven cap + 1 prefix in a larger domain as an inexact lower bound', () => {
		const alternatives =
			Array.from({ length: 34 }, (_, index) => `c${index} ? '${index}' : `).join('') + "'33'";
		const { ast, expression } = fixture(`
			<script>const quality = ${alternatives}</script>
			<enhanced:img src={\`${'${item.src}'}?quality=${'${quality}'}\`} />
		`);
		try {
			analyze_source(expression, create_evaluation_context(ast.instance.content), { cap: 32 });
			expect.fail('expected a query variant error');
		} catch (error) {
			expect(error).toMatchObject({
				code: 'EMAGE_QUERY_VARIANT_LIMIT',
				count: 33,
				exact: false
			});
		}
	});

	it('bounds query Cartesian work to cap + 1 before canonicalization', () => {
		const alternatives = (prefix) =>
			Array.from({ length: 20 }, (_, index) => `${prefix}${index} ? '${index}' : `).join('') +
			"'19'";
		const { ast, expression } = fixture(`
			<script>
				const a = ${alternatives('a')};
				const b = ${alternatives('b')};
			</script>
			<enhanced:img src={\`${'${item.src}'}?a=${'${a}'}&b=${'${b}'}\`} />
		`);
		let canonicalizations = 0;
		try {
			analyze_source(expression, create_evaluation_context(ast.instance.content), {
				cap: 2,
				canonicalize_query(query) {
					canonicalizations += 1;
					return query;
				}
			});
			expect.fail('expected a query variant error');
		} catch (error) {
			expect(error).toMatchObject({ count: 3, exact: false });
		}
		expect(canonicalizations).toBe(3);
	});

	it('returns Unknown when bounded raw variants canonicalize below the cap but more remain', () => {
		const { ast, expression } = fixture(`
			<script>
				const a = x
					? 'quality=TRUE&w=400'
					: y
						? 'w=400&quality=true'
						: 'quality=%74rue&w=400'
			</script>
			<enhanced:img src={\`${'${item.src}'}?${'${a}'}\`} />
		`);
		let canonicalizations = 0;
		const result = analyze_source(expression, create_evaluation_context(ast.instance.content), {
			cap: 1,
			canonicalize_query(query) {
				canonicalizations += 1;
				return canonicalize_public_query(query);
			}
		});
		expect(result).toMatchObject({ kind: 'unknown', reason: 'overflow' });
		expect(canonicalizations).toBeLessThanOrEqual(2);
	});

	it.each([
		['', true],
		['quality=75&w=400;800', true],
		['blur', true],
		['quality=60&quality=80', true],
		['quality=%ZZ', false],
		['=75', false],
		['quality=75&&w=400', false],
		['quality=75#fragment', false]
	])('validates directive query %j', (query, expected) => {
		expect(is_valid_directive_query(query)).toBe(expected);
	});
});

function fixture(source) {
	const ast = parse(source, { modern: true });
	const each = ast.fragment.nodes.find((node) => node.type === 'EachBlock');
	const nodes = each ? each.body.nodes : ast.fragment.nodes;
	const element = nodes.find((node) => node.type === 'RegularElement');
	const src = element.attributes.find(
		(attribute) => attribute.type === 'Attribute' && attribute.name === 'src'
	);
	if (!src || src.type !== 'Attribute' || typeof src.value === 'boolean') {
		throw new Error('fixture has no expression-valued src attribute');
	}
	const value = Array.isArray(src.value) ? src.value[0] : src.value;
	if (value.type !== 'ExpressionTag') throw new Error('fixture src is not an expression');
	return { ast, each, expression: value.expression };
}

function iteration(each) {
	return {
		iterable: each.expression,
		pattern: each.context,
		index: each.index
	};
}

import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import {
	create_evaluation_context,
	evaluate_expression,
	extend_const_context,
	extend_each_context
} from '../../src/dynamic/analyze/expression.js';

describe('finite expression evaluation', () => {
	it('evaluates const chains, templates, addition, conditionals and logical operators', () => {
		const { ast, expression } = fixture(`
			<script>
				const quality = compact ? 60 : 80;
				const enabled = compact ? true : false;
				const prefix = enabled && 'quality=';
				const missing = compact ? null : undefined;
				const suffix = missing ?? quality;
			</script>
			<enhanced:img src={\`${'${prefix || "quality="}'}${'${suffix + 0}'}\`} />
		`);
		const context = create_evaluation_context(ast.instance.content);

		expect(evaluate_expression(expression, context)).toEqual({
			kind: 'finite',
			values: ['quality=60', 'quality=80']
		});
	});

	it('supports static object/array access and simple const destructuring', () => {
		const { ast, expression } = fixture(`
			<script>
				const data = { rows: [{ q: 60 }, { q: 80 }], fallback: '75' };
				const [first, second] = data.rows;
				const { q: quality = data.fallback } = second;
			</script>
			<enhanced:img src={first.q + ':' + quality} />
		`);
		const context = create_evaluation_context(ast.instance.content);

		expect(evaluate_expression(expression, context)).toEqual({
			kind: 'finite',
			values: ['60:80']
		});
	});

	it('preserves correlations between values from the same finite each row', () => {
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
		const root = create_evaluation_context(ast.instance.content);
		const context = extend_each_context(root, each);

		expect(evaluate_expression(expression, context)).toEqual({
			kind: 'finite',
			values: ['/a.jpg?quality=60', '/b.jpg?quality=80']
		});
	});

	it('extends the lexical context after a Svelte ConstTag', () => {
		const { ast, expression, each } = fixture(`
			<script>const items = [{ quality: 60 }, { quality: 80 }]</script>
			{#each items as item}
				{@const query = \`quality=${'${item.quality}'}\`}
				<enhanced:img src={query} />
			{/each}
		`);
		const each_context = extend_each_context(create_evaluation_context(ast.instance.content), each);
		const const_tag = each.body.nodes.find((node) => node.type === 'ConstTag');
		const context = extend_const_context(each_context, const_tag);

		expect(evaluate_expression(expression, context)).toEqual({
			kind: 'finite',
			values: ['quality=60', 'quality=80']
		});
	});

	it.each([
		['mutable bindings', '<script>let value = 60</script>', 'value'],
		['function calls', '', 'getQuality()'],
		['assignments', '<script>let value = 60</script>', '(value = 80)'],
		['updates', '<script>let value = 60</script>', 'value++'],
		['imports', '<script>import value from "value"</script>', 'value'],
		['getters', '', '({ get value() { return 60 } }).value']
	])('returns Unknown for %s', (_label, script, source_expression) => {
		const { ast, expression } = fixture(`${script}<enhanced:img src={${source_expression}} />`);
		const context = create_evaluation_context(ast.instance?.content);

		expect(evaluate_expression(expression, context).kind).toBe('unknown');
	});

	it('stops a Cartesian expansion at cap + 1', () => {
		const alternatives = (prefix) =>
			Array.from({ length: 6 }, (_, index) => `${prefix}${index} ? '${index}' : `).join('') + "'5'";
		const { ast, expression } = fixture(`
			<script>
				const a = ${alternatives('a')};
				const b = ${alternatives('b')};
			</script>
			<enhanced:img src={a + b} />
		`);
		const context = create_evaluation_context(ast.instance.content, { cap: 32 });

		const result = evaluate_expression(expression, context, { cap: 32 });
		expect(result).toMatchObject({
			kind: 'overflow',
			count: 33,
			exact: false,
			values: expect.any(Array)
		});
		if (result.kind === 'unknown') throw new Error('expected a finite-domain overflow');
		expect(result.values).toHaveLength(33);
	});

	it.each([
		['an absent record property', '({}).missing'],
		['an array hole', '[,][0]']
	])('does not inherit finite undefined from %s', (_label, source_expression) => {
		const { ast, expression } = fixture(`<enhanced:img src={${source_expression}} />`);
		expect(
			evaluate_expression(expression, create_evaluation_context(ast.instance?.content)).kind
		).toBe('unknown');
	});

	it.each([
		['object', "const { missing = 'fallback' } = {}", 'missing'],
		['array', "const [missing = 'fallback'] = []", 'missing'],
		['array hole', "const [missing = 'fallback'] = [,]", 'missing']
	])(
		'does not fold absent %s destructuring through inherited undefined',
		(_label, declaration, name) => {
			const { ast, expression } = fixture(`
			<script>${declaration}</script>
			<enhanced:img src={${name}} />
		`);
			expect(
				evaluate_expression(expression, create_evaluation_context(ast.instance.content)).kind
			).toBe('unknown');
		}
	);

	it('still applies a destructuring default to an explicit own undefined value', () => {
		const { ast, expression } = fixture(`
			<script>const { quality = 75 } = { quality: undefined }</script>
			<enhanced:img src={quality} />
		`);
		expect(
			evaluate_expression(expression, create_evaluation_context(ast.instance.content))
		).toEqual({
			kind: 'finite',
			values: [75]
		});
	});

	it('adds an Unknown row for mixed finite each iterable alternatives', () => {
		const { ast, expression, each } = fixture(`
			<script>const values = compact ? [{ quality: 60 }] : 'runtime'</script>
			{#each values as item}<enhanced:img src={item.quality} />{/each}
		`);
		const context = extend_each_context(create_evaluation_context(ast.instance.content), each);
		expect(evaluate_expression(expression, context)).toMatchObject({ kind: 'unknown' });
	});

	it('shadows all destructured names with TDZ bindings before defaults run', () => {
		const { ast, expression } = fixture(`
			<script>
				const { first = later, later = 'ready' } = {
					first: undefined,
					later: undefined
				};
			</script>
			<enhanced:img src={first} />
		`);
		expect(
			evaluate_expression(expression, create_evaluation_context(ast.instance.content))
		).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('union') });
	});

	it('reports exact overflow only when the complete cap + 1 domain is known', () => {
		const exact = fixture(`
			<script>const value = compact ? 'a' : 'b'</script>
			<enhanced:img src={value} />
		`);
		const lower_bound = fixture(`
			<script>const value = a ? 'a' : b ? 'b' : 'c'</script>
			<enhanced:img src={value} />
		`);
		expect(
			evaluate_expression(exact.expression, create_evaluation_context(exact.ast.instance.content), {
				cap: 1
			})
		).toMatchObject({ kind: 'overflow', count: 2, exact: true });
		expect(
			evaluate_expression(
				lower_bound.expression,
				create_evaluation_context(lower_bound.ast.instance.content),
				{ cap: 1 }
			)
		).toMatchObject({ kind: 'overflow', count: 2, exact: false });
	});

	it('supports safe signed literals and transparent TSSatisfies wrappers', () => {
		const signed = fixture('<enhanced:img src={`${-75}:${+60}:${-2n}`} />');
		const context = create_evaluation_context(signed.ast.instance?.content);
		expect(evaluate_expression(signed.expression, context)).toEqual({
			kind: 'finite',
			values: ['-75:60:-2']
		});
		expect(
			evaluate_expression(
				{
					type: 'TSSatisfiesExpression',
					expression: { type: 'Literal', value: 'quality=75' }
				},
				context
			)
		).toEqual({ kind: 'finite', values: ['quality=75'] });
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

import { compile } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import { create_identifier_allocator, render_dynamic_image } from '../../src/dynamic/render.js';

describe('dynamic markup rendering', () => {
	it('evaluates src once and preserves fallback attributes without mutating the AST', () => {
		const tag =
			'<enhanced:img src={get_src()} sizes="(min-width: 40rem) 50vw, 100vw" class="hero" data-id={id} />';
		const node = image_node(tag, [
			['src', 'src={get_src()}'],
			['sizes', 'sizes="(min-width: 40rem) 50vw, 100vw"'],
			['class', 'class="hero"'],
			['data-id', 'data-id={id}']
		]);
		const original = [...node.attributes];
		const output = render_dynamic_image(tag, node, {
			expression: 'get_src()',
			resolver: '__resolver',
			importer: '/src/routes/X.svelte'
		});

		expect(output.match(/get_src\(\)/g)).toHaveLength(1);
		expect(output).toContain('<source srcset=');
		expect(output).toContain('sizes="(min-width: 40rem) 50vw, 100vw"');
		const fallback = output.slice(output.indexOf('{:else}'));
		expect(fallback).toContain('sizes="(min-width: 40rem) 50vw, 100vw"');
		expect(fallback).toContain('class="hero"');
		expect(fallback).toContain('data-id={id}');
		expect(output).toContain("typeof __eimg_resolved_0.img.src === 'string'");
		expect(output).toContain('Number.isFinite(__eimg_resolved_0.img.w)');
		expect(node.attributes).toEqual(original);
	});

	it('allocates identifiers that cannot collide with component bindings', () => {
		const allocate = create_identifier_allocator(
			'let __eimg_src = 1; let __eimg_src_1 = 2; let format = 3;'
		);
		expect(allocate('src')).toBe('__eimg_src_2');
		expect(allocate('src')).toBe('__eimg_src_3');
	});

	it('evaluates dynamic dimensions once and lets spreads override inferred values', () => {
		const tag = '<enhanced:img src={get_src()} width={get_width()} {...dimensions} alt="A" />';
		const node = image_node(tag, [
			['src', 'src={get_src()}'],
			['width', 'width={get_width()}'],
			[undefined, '{...dimensions}'],
			['alt', 'alt="A"']
		]);
		const output = render_dynamic_image(tag, node, {
			expression: 'get_src()',
			resolver: '__resolver',
			importer: '/src/routes/X.svelte'
		});

		expect(output.match(/get_width\(\)/g)).toHaveLength(1);
		expect(output).toContain('{@const __eimg_width_0 = get_width()}');
		expect(output).toContain('width={__eimg_width_0}');
		const picture_img = output.slice(
			output.indexOf('<img '),
			output.indexOf(' />', output.indexOf('<img '))
		);
		expect(picture_img.indexOf('height={Math.round')).toBeLessThan(
			picture_img.indexOf('{...dimensions}')
		);

		const component = `<script>
      const __resolver = () => undefined;
      const get_src = () => '/src/assets/a.jpg';
      const get_width = () => 320;
      const dimensions = { height: 160 };
    </script>${output}`;
		expect(() => compile(component, { generate: 'server' })).not.toThrow();
		expect(() => compile(component, { generate: 'client' })).not.toThrow();
	});

	it('generates Svelte that compiles for SSR and client', () => {
		const tag = '<enhanced:img src={get_src()} sizes="100vw" alt="A" />';
		const node = image_node(tag, [
			['src', 'src={get_src()}'],
			['sizes', 'sizes="100vw"'],
			['alt', 'alt="A"']
		]);
		const rendered = render_dynamic_image(tag, node, {
			expression: 'get_src()',
			resolver: '__resolver',
			importer: '/src/routes/X.svelte'
		});
		const component = `<script>
      const __resolver = () => undefined;
      const get_src = () => '/src/assets/a.jpg';
    </script>${rendered}`;

		expect(() => compile(component, { generate: 'server' })).not.toThrow();
		expect(() => compile(component, { generate: 'client' })).not.toThrow();
	});
});

function image_node(content, definitions) {
	let cursor = 0;
	const attributes = definitions.map(([name, source]) => {
		const start = content.indexOf(source, cursor);
		cursor = start + source.length;
		return { name, start, end: cursor };
	});
	return { start: 0, end: content.length, attributes };
}

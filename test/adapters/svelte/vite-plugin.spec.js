import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compile } from 'svelte/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { image_plugin } from '#svelte/vite-plugin.js';

/** @type {string} */
let root;
/** @type {import('vite').Plugin} */
let plugin;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), 'enhanced-img-transform-'));
	await fs.mkdir(path.join(root, 'src/assets'), { recursive: true });
	await fs.writeFile(path.join(root, 'src/assets/a.png'), 'discovery does not decode bytes');
	plugin = image_plugin(
		{ name: 'imagetools-mock', load: vi.fn(() => 'export default {}') },
		{ dynamic: ['src/assets/**/*.png'] }
	);
	await call_hook(
		plugin.configResolved,
		/** @type {import('vite').ResolvedConfig} */ (
			/** @type {unknown} */ ({
				root,
				publicDir: path.join(root, 'public'),
				resolve: { alias: [] },
				logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
				plugins: [
					{
						name: 'vite-plugin-svelte:config',
						api: { filter: { id: { include: [/\.svelte$/], exclude: [] } } }
					}
				]
			})
		)
	);
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe('dynamic markup/profile integration', () => {
	it('registers a default profile for an opaque bare path', async () => {
		const output = await transform(`
			<script>let { src } = $props();</script>
			<enhanced:img {src} width="16" height="8" alt="A" />
		`);
		expect(output).toContain('virtual:enhanced-img/dynamic/');
		expect(() => compile(output, { generate: 'server' })).not.toThrow();
	});

	it('parses once and dispatches finite queries through an O(1) profile map', async () => {
		const output = await transform(`
			<script>
				let { src } = $props();
				const compact = Math.random() > 0.5;
			</script>
			<enhanced:img src={\`${'${src}'}?quality=${'${compact ? 60 : 80}'}\`} width="16" height="8" alt="A" />
		`);

		expect(output.match(/virtual:enhanced-img\/dynamic\//g)).toHaveLength(2);
		expect(output).toContain('from "virtual:enhanced-img/runtime"');
		expect(output).toContain('new Map([[');
		expect(output).toContain('.get(query)');
		expect(output).not.toContain('resolve_with_reason');
		expect(output.match(/__eimg_parse_source(?:_\d+)?\(value, importer\)/g)).toHaveLength(1);
		expect(output.match(/__eimg_parse_query(?:_\d+)?\(parsed\.query\)/g)).toHaveLength(1);
		expect(() => compile(output, { generate: 'server' })).not.toThrow();
	});

	it.each([
		[
			'an opaque query',
			`<script>let { src, query } = $props();</script>
			 <enhanced:img src={\`${'${src}'}?${'${query}'}\`} width="16" height="8" alt="A" />`,
			true
		],
		[
			'an overflowing finite source domain',
			`<script>const src = ${conditional_source(34)};</script>
			 <enhanced:img {src} width="16" height="8" alt="A" />`,
			true
		],
		[
			'a statically external source',
			`<script>const src = 'https://cdn.example/a.png?quality=75';</script>
			 <enhanced:img {src} width="16" height="8" alt="A" />`,
			false
		]
	])('does not register image jobs for %s', async (_label, source, uses_catalog) => {
		const output = await transform(source);
		expect(output).not.toContain('virtual:enhanced-img/dynamic/');
		if (uses_catalog) {
			expect(output).toContain('from "virtual:enhanced-img/catalog"');
		}
		expect(() => compile(output, { generate: 'server' })).not.toThrow();
	});
});

/** @param {string} content */
async function transform(content) {
	const hook = plugin.transform;
	if (!hook) throw new Error('expected transform hook');
	const handler = typeof hook === 'object' ? hook.handler : hook;
	const result = await handler.call(
		/** @type {import('rollup').TransformPluginContext} */ (
			/** @type {unknown} */ ({ warn: vi.fn() })
		),
		content,
		path.join(root, `src/Component-${Math.random().toString(36).slice(2)}.svelte`)
	);
	if (!result || typeof result === 'string' || !result.code) {
		throw new Error('expected transformed component code');
	}
	return result.code;
}

/** @param {number} count */
function conditional_source(count) {
	let expression = JSON.stringify(`/src/assets/${count - 1}.png`);
	for (let index = count - 2; index >= 0; index -= 1) {
		expression = `condition_${index} ? ${JSON.stringify(`/src/assets/${index}.png`)} : ${expression}`;
	}
	return expression;
}

/**
 * @param {any} hook
 * @param {unknown} value
 */
async function call_hook(hook, value) {
	if (!hook) throw new Error('expected plugin hook');
	const handler = typeof hook === 'object' ? hook.handler : hook;
	return handler(value);
}

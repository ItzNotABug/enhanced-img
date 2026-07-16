import fs from 'node:fs/promises';
import path from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createServer } from 'vite';
import { enhancedImages } from '@itznotabug/emage-svelte';
import { workspace_root } from '#test/support/workspace.js';

// Drives a real Vite dev server (real chokidar watcher, real module graph)
// through catalog mutations and asserts on the modules a browser would be
// served after each one. Watcher events are asynchronous, so positive
// expectations poll until a deadline instead of sleeping fixed amounts.

/** @type {string} */
let root;
/** @type {string} */
let assets;
/** @type {import('vite').ViteDevServer} */
let server;

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(workspace_root, '.hmr-'));
	assets = path.join(root, 'src/assets');
	await fs.mkdir(assets, { recursive: true });
	await Promise.all([
		write_image('a.png', 16, 8, { r: 255, g: 0, b: 0 }),
		write_image('b.png', 16, 8, { r: 0, g: 0, b: 255 })
	]);
	await fs.writeFile(
		path.join(root, 'src/App.svelte'),
		`<script>
	// JSON.parse is a call, so the analyzer treats every path as an opaque runtime string.
	const paths = JSON.parse(
		'["/src/assets/a.png","/src/assets/b.png","/src/assets/c.png","/src/assets/d.png"]'
	);
</script>

{#each paths as p}
	<enhanced:img src={p} alt={p} />
{/each}
<enhanced:img src={paths[0] + '?w=8;16&quality=70'} alt="query-profile" />
`
	);
	await fs.writeFile(
		path.join(root, 'src/entry-server.js'),
		"import { render } from 'svelte/server'; import App from './App.svelte'; export const run = () => render(App).body;"
	);
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	server = await createServer({
		root,
		configFile: false,
		logLevel: 'silent',
		server: { middlewareMode: true },
		plugins: [...enhancedImages({ dynamic: 'src/assets/**/*.png' }), svelte()]
	});
}, 20_000);

afterAll(async () => {
	vi.restoreAllMocks();
	await server?.close();
	if (root) await fs.rm(root, { recursive: true, force: true });
});

it('serves both query profiles with only the discovered candidates', async () => {
	const resolvers = await snapshot();
	expect(resolvers).toHaveLength(2);
	expect(resolves(resolvers, '/src/assets/a.png')).toBe(true);
	expect(resolves(resolvers, '/src/assets/b.png')).toBe(true);
	expect(resolves(resolvers, '/src/assets/c.png')).toBe(false);
	expect(resolves(resolvers, '/src/assets/d.png')).toBe(false);

	const html = await render();
	expect(html.match(/<picture>/g)).toHaveLength(3);
	expect(html).toContain('src="/src/assets/c.png"');
	expect(html).toContain('src="/src/assets/d.png"');
}, 30_000);

it('adds a created file to every profile resolver', async () => {
	await write_image('c.png', 16, 8, { r: 0, g: 255, b: 0 });
	await eventually(async () => {
		const resolvers = await snapshot();
		return resolves(resolvers, '/src/assets/c.png') || `catalog: ${catalog_keys(resolvers)}`;
	});
}, 30_000);

it('serves fresh metadata after an image is edited in place', async () => {
	await write_image('a.png', 40, 20, { r: 200, g: 0, b: 0 });
	await eventually(async () => {
		const resolvers = await snapshot();
		const asset_url = resolvers[0]?.keys.get('/src/assets/a.png');
		if (!asset_url) return 'a.png missing from resolver';
		const code = await transform(asset_url);
		return /\b40\b/.test(code) || 'asset module still reports the old size';
	});
}, 30_000);

it('treats a rename as remove plus add', async () => {
	await fs.rename(path.join(assets, 'c.png'), path.join(assets, 'd.png'));
	await eventually(async () => {
		const resolvers = await snapshot();
		if (!resolves(resolvers, '/src/assets/d.png')) return 'd.png not resolvable yet';
		return !resolves(resolvers, '/src/assets/c.png') || 'c.png still resolvable';
	});
}, 30_000);

it('drops a deleted file from the catalog', async () => {
	await fs.rm(path.join(assets, 'b.png'));
	await eventually(async () => {
		const resolvers = await snapshot();
		return !resolves(resolvers, '/src/assets/b.png') || 'b.png still resolvable';
	});
}, 30_000);

it('settles on the last of rapid successive edits', async () => {
	await write_image('d.png', 24, 12, { r: 9, g: 9, b: 9 });
	await write_image('d.png', 64, 32, { r: 90, g: 90, b: 90 });
	await eventually(async () => {
		const resolvers = await snapshot();
		const asset_url = resolvers[0]?.keys.get('/src/assets/d.png');
		if (!asset_url) return 'd.png missing from resolver';
		const code = await transform(asset_url);
		return /\b64\b/.test(code) || 'asset module has not settled on the final size';
	});
}, 30_000);

it('ignores unrelated file churn', async () => {
	const before = catalog_keys(await snapshot());
	await fs.writeFile(path.join(root, 'notes.txt'), 'unrelated');
	await fs.writeFile(path.join(root, 'src/other.js'), 'export const unused = 1;');
	await new Promise((resolve) => setTimeout(resolve, 750));
	expect(catalog_keys(await snapshot())).toBe(before);
}, 30_000);

it('reflects the final catalog in a fresh SSR render', async () => {
	await eventually(async () => {
		const html = await render();
		const pictures = html.match(/<picture>/g)?.length ?? 0;
		if (pictures !== 3) return `expected 3 pictures, saw ${pictures}`;
		if (!html.includes('src="/src/assets/b.png"')) return 'deleted b.png is not falling back';
		if (!html.includes('src="/src/assets/c.png"')) return 'renamed-away c.png is not falling back';
		return html.includes('width="40"') || 'edited a.png still renders the old width';
	});
}, 30_000);

/**
 * @param {string} file
 * @param {number} width
 * @param {number} height
 * @param {{ r: number, g: number, b: number }} background
 */
async function write_image(file, width, height, background) {
	await sharp({
		create: { width, height, channels: 4, background: { ...background, alpha: 1 } }
	})
		.png()
		.toFile(path.join(assets, file));
}

/** @param {string} url */
async function transform(url) {
	// Undo the browser-facing encoding that vite's middleware would strip.
	const id = url.replace(/^\/@id\//, '').replace('__x00__', '\0');
	const result = await server.transformRequest(id);
	return result?.code ?? '';
}

/**
 * Collects the dynamic resolver modules a browser would load for App.svelte,
 * mapping each catalog key to its asset virtual-module URL.
 */
async function snapshot() {
	const app = await transform('/src/App.svelte');
	const resolver_urls = [
		...new Set(
			[...app.matchAll(/from ["']([^"']*enhanced-img\/dynamic[^"']*)["']/g)].map((m) => m[1])
		)
	];
	const resolvers = [];
	for (const url of resolver_urls) {
		const code = await transform(url);
		const imports = new Map(
			[...code.matchAll(/import (\w+) from ["']([^"']+)["']/g)].map((m) => [m[1], m[2]])
		);
		const keys = new Map(
			[...code.matchAll(/\[\s*["']([^"']+)["']\s*,\s*(\w+)\s*\]/g)].map((m) => [
				m[1],
				imports.get(m[2])
			])
		);
		resolvers.push({ keys });
	}
	return resolvers;
}

/**
 * @param {Awaited<ReturnType<typeof snapshot>>} resolvers
 * @param {string} key
 */
function resolves(resolvers, key) {
	return resolvers.length > 0 && resolvers.every((resolver) => resolver.keys.has(key));
}

/** @param {Awaited<ReturnType<typeof snapshot>>} resolvers */
function catalog_keys(resolvers) {
	return JSON.stringify(resolvers.map((resolver) => [...resolver.keys.keys()].sort()));
}

async function render() {
	const module = await server.ssrLoadModule('/src/entry-server.js');
	return module.run();
}

/**
 * @param {() => Promise<true | string>} check
 * @param {number} [timeout]
 */
async function eventually(check, timeout = 15_000) {
	const deadline = Date.now() + timeout;
	let detail = 'timed out';
	while (Date.now() < deadline) {
		detail = String(await check());
		if (detail === 'true') return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	expect.fail(detail);
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { build, createServer } from 'vite';
import { enhancedImages } from '../src/index.js';

/** @type {string} */
let root;
const package_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

beforeAll(async () => {
	// Keep the fixture beneath the package so Vite can resolve this package's dev dependencies.
	root = await fs.mkdtemp(path.join(package_root, '.integration-'));
	await Promise.all([
		fs.mkdir(path.join(root, 'src/assets'), { recursive: true }),
		fs.mkdir(path.join(root, 'public/images'), { recursive: true })
	]);
	await Promise.all([
		write_image(path.join(root, 'src/assets/red.png'), { r: 255, g: 0, b: 0, alpha: 1 }),
		write_image(path.join(root, 'src/assets/blue.png'), { r: 0, g: 0, b: 255, alpha: 1 }),
		write_image(path.join(root, 'src/assets/upper.PNG'), { r: 180, g: 0, b: 180, alpha: 1 }),
		write_image(path.join(root, 'public/images/public.png'), {
			r: 0,
			g: 180,
			b: 0,
			alpha: 1
		})
	]);
	await Promise.all([
		fs.writeFile(
			path.join(root, 'index.html'),
			'<div id="app"></div><script type="module" src="/src/main.js"></script>'
		),
		fs.writeFile(
			path.join(root, 'src/main.js'),
			"import { mount } from 'svelte'; import App from './App.svelte'; mount(App, { target: document.querySelector('#app') });"
		),
		fs.writeFile(
			path.join(root, 'src/entry-server.js'),
			"import { render } from 'svelte/server'; import App from './App.svelte'; export const renderApp = () => render(App).body;"
		),
		fs.writeFile(path.join(root, 'src/App.svelte'), APP_SOURCE),
		fs.writeFile(
			path.join(root, 'src/opaque.js'),
			"import { mount } from 'svelte'; import Opaque from './Opaque.svelte'; mount(Opaque, { target: document.body });"
		),
		fs.writeFile(path.join(root, 'src/Opaque.svelte'), OPAQUE_SOURCE)
	]);
}, 20_000);

afterAll(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
});

it('builds dynamic source and publicDir catalogs without private path leaks', async () => {
	await build(vite_config('dist-client'));
	const files = await read_tree(path.join(root, 'dist-client'));
	const bundle = files.map((file) => file.content).join('\n');
	const emitted = new Set(files.map((file) => `/${file.name}`));
	const referenced_assets = new Set(
		[...bundle.matchAll(/(?:^|["'\s,(])(\/assets\/[A-Za-z0-9_.-]+)/gm)].map((match) => match[1])
	);

	expect(files.some((file) => file.name.endsWith('.avif'))).toBe(true);
	expect(files.some((file) => file.name.endsWith('.webp'))).toBe(true);
	expect(files.some((file) => file.name.endsWith('.png'))).toBe(true);
	expect(referenced_assets.size).toBeGreaterThan(0);
	expect([...referenced_assets].filter((asset) => !emitted.has(asset))).toEqual([]);
	expect(bundle).not.toContain('virtual:enhanced-img');
	expect(bundle).not.toContain('/@fs/');
	expect(bundle).not.toContain(root);
}, 30_000);

it('keeps the no-options Vite build path free of dynamic virtual modules', async () => {
	await build(vite_config('dist-no-options', false));
	const files = await read_tree(path.join(root, 'dist-no-options'));
	const bundle = files.map((file) => file.content).join('\n');

	expect(files.some((file) => file.name.endsWith('.avif'))).toBe(true);
	expect(files.some((file) => file.name.endsWith('.webp'))).toBe(true);
	expect(bundle).not.toContain('virtual:enhanced-img');
	expect(bundle).not.toContain('/@fs/');
	expect(bundle).not.toContain(root);
}, 30_000);

it('tree-shakes the path-only catalog from production opaque-query builds', async () => {
	const config = vite_config('dist-opaque');
	config.build = {
		...config.build,
		rollupOptions: { input: path.join(root, 'src/opaque.js') }
	};
	await build(config);
	const files = await read_tree(path.join(root, 'dist-opaque'));
	const bundle = files.map((file) => file.content).join('\n');

	expect(bundle).not.toContain('__eimg_paths');
	expect(bundle).not.toContain('virtual:enhanced-img/catalog');
	expect(bundle).not.toContain('/src/assets/red.png');
	expect(bundle).not.toContain('/images/public.png');
}, 30_000);

it('renders optimized and pass-through branches during SSR', async () => {
	await build({
		...vite_config('dist-ssr'),
		build: {
			ssr: 'src/entry-server.js',
			outDir: 'dist-ssr',
			emptyOutDir: true
		}
	});
	const entry = path.join(root, 'dist-ssr/entry-server.js');
	const { renderApp } = await import(`${pathToFileURL(entry).href}?test=${Date.now()}`);
	const html = renderApp();

	expect(html.match(/<picture>/g)).toHaveLength(7);
	expect(html).toContain('alt="Upper"');
	expect(html).toContain('/assets/public-');
	expect(html).toContain('src="/src/assets/missing.png"');
	expect(html).toContain('src="https://example.com/photo.jpg?token=kept"');
	expect(html).not.toContain('virtual:enhanced-img');
	expect(html).not.toContain('/@fs/');
	expect(html).not.toContain(root);
}, 30_000);

it('deduplicates development miss warnings across repeated SSR renders', async () => {
	const server = await createServer({
		...vite_config('unused-dev-output'),
		mode: 'development',
		define: { 'import.meta.env.DEV': 'true' },
		server: { middlewareMode: true }
	});
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		const { renderApp } = await server.ssrLoadModule('/src/entry-server.js');
		renderApp();
		renderApp();
		const misses = warn.mock.calls.filter((values) =>
			values.some((value) => String(value).includes('@itznotabug/enhanced-img: /src/App.svelte'))
		);
		expect(misses).toHaveLength(1);
	} finally {
		warn.mockRestore();
		await server.close();
	}
}, 30_000);

/**
 * @param {string} out_dir
 * @param {boolean} [dynamic]
 * @returns {import('vite').InlineConfig}
 */
function vite_config(out_dir, dynamic = true) {
	return {
		root,
		mode: 'production',
		configFile: false,
		define: { 'import.meta.env.DEV': 'false' },
		logLevel: 'silent',
		plugins: [
			...enhancedImages(
				dynamic
					? {
							dynamic: ['src/assets/**/*.png', 'src/assets/**/*.PNG', 'public/images/**/*.png']
						}
					: undefined
			),
			svelte()
		],
		build: {
			outDir: out_dir,
			emptyOutDir: true,
			minify: false
		}
	};
}

/**
 * @param {string} filename
 * @param {{ r: number, g: number, b: number, alpha: number }} background
 */
async function write_image(filename, background) {
	await sharp({
		create: { width: 16, height: 8, channels: 4, background }
	})
		.png()
		.toFile(filename);
}

/** @param {string} directory */
async function read_tree(directory, base = directory) {
	/** @type {Array<{ name: string, content: string }>} */
	const output = [];
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const filename = path.join(directory, entry.name);
		if (entry.isDirectory()) output.push(...(await read_tree(filename, base)));
		else {
			const is_text = /\.(?:css|html|js)$/.test(entry.name);
			output.push({
				name: path.relative(base, filename),
				content: is_text ? await fs.readFile(filename, 'utf8') : ''
			});
		}
	}
	return output;
}

const APP_SOURCE = `<script>
  import imported from './assets/blue.png?enhanced';
  const compact = Math.random() > 0.5;
  const items = [
    { src: '/src/assets/red.png', alt: 'Red' },
    { src: './assets/blue.png', alt: 'Blue' },
    { src: '/src/assets/upper.PNG', alt: 'Upper' },
    { src: '/images/public.png', alt: 'Public' }
  ];
  const missing = '/src/assets/missing.png';
  const remote = 'https://example.com/photo.jpg?token=kept';
  let selected = $state('/src/assets/red.png');
</script>

{#each items as item (item.src)}
  <enhanced:img
    src={\`${'${item.src}'}?w=8;16&quality=${'${compact ? 60 : 80}'}\`}
    sizes="(max-width: 600px) 100vw, 600px"
    alt={item.alt}
  />
{/each}
<enhanced:img id="missing" src={missing} width="8" height="4" alt="Missing" />
<enhanced:img id="remote" src={remote} width="8" height="4" alt="Remote" />
<enhanced:img id="imported" src={imported} alt="Imported" />
<enhanced:img id="literal" src="./assets/red.png" alt="Literal" />
<button onclick={() => (selected = selected.endsWith('red.png') ? './assets/blue.png' : '/src/assets/red.png')}>Switch</button>
<enhanced:img id="switcher" src={selected} alt="Switchable" />`;

const OPAQUE_SOURCE = `<script>
  let { src, query } = $props();
</script>

<enhanced:img src={\`${'${src}'}?${'${query}'}\`} width="16" height="8" alt="Opaque" />`;

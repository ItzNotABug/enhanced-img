import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { enhancedImages } from '@itznotabug/emage-vue/vite';
import { workspace_root } from '#test/support/workspace.js';

/** @type {string} */
let root;

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(workspace_root, '.vue-integration-'));
	await fs.mkdir(path.join(root, 'src/assets'), { recursive: true });
	await Promise.all([
		write_image(path.join(root, 'src/assets/red.png'), { r: 255, g: 0, b: 0, alpha: 1 }),
		write_image(path.join(root, 'src/assets/blue.png'), { r: 0, g: 0, b: 255, alpha: 1 })
	]);
	await Promise.all([
		fs.writeFile(
			path.join(root, 'index.html'),
			'<div id="app"></div><script type="module" src="/src/main.js"></script>'
		),
		fs.writeFile(
			path.join(root, 'src/main.js'),
			"import { createApp } from 'vue'; import App from './App.vue'; createApp(App).mount('#app');"
		),
		fs.writeFile(
			path.join(root, 'src/entry-server.js'),
			"import { createSSRApp } from 'vue'; import { renderToString } from 'vue/server-renderer'; import App from './App.vue'; export const renderApp = () => renderToString(createSSRApp(App));"
		),
		fs.writeFile(path.join(root, 'src/App.vue'), APP_SOURCE),
		fs.writeFile(path.join(root, 'src/OptionsCollision.vue'), OPTIONS_COLLISION_SOURCE),
		fs.writeFile(path.join(root, 'src/SlotCollector.vue'), SLOT_COLLECTOR_SOURCE)
	]);
}, 20_000);

afterAll(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
});

it('builds optimized imports and runtime-selected local images', async () => {
	await build(vite_config('dist-client'));
	const files = await read_tree(path.join(root, 'dist-client'));
	const bundle = files.map((file) => file.content).join('\n');

	expect(files.some((file) => file.name.endsWith('.avif'))).toBe(true);
	expect(files.some((file) => file.name.endsWith('.webp'))).toBe(true);
	expect(files.some((file) => file.name.endsWith('.png'))).toBe(true);
	expect(bundle).not.toContain('virtual:enhanced-img');
	expect(bundle).not.toContain('/@fs/');
	expect(bundle).not.toContain('vue/compiler-sfc');
	expect(bundle).not.toContain('fsevents.node');
}, 30_000);

it('renders Picture and pass-through branches during SSR', async () => {
	await build({
		...vite_config('dist-ssr'),
		build: {
			ssr: 'src/entry-server.js',
			outDir: 'dist-ssr',
			emptyOutDir: true,
			minify: false
		}
	});
	const entry = path.join(root, 'dist-ssr/entry-server.js');
	const { renderApp } = await import(`${pathToFileURL(entry).href}?test=${Date.now()}`);
	const html = await renderApp();

	expect(html.match(/<picture>/g)).toHaveLength(8);
	expect(html).toContain('alt="Static"');
	expect(html).toContain('alt="Red"');
	expect(html).toContain('alt="Blue"');
	expect(html).toContain('alt="Options API"');
	expect(html).toContain('alt="Slot red"');
	expect(html).toContain('alt="Slot blue"');
	expect(html).toContain('alt="First named slot"');
	expect(html).toContain('alt="Second named slot"');
	expect(html).toContain('src="https://example.com/photo.jpg?token=kept&amp;size=large"');
	expect(html).toContain('src="/src/assets/missing.png"');
	expect(html).toContain('src="/literal.png"');
	expect(html).not.toContain('virtual:enhanced-img');
	expect(html).not.toContain('/@fs/');
	expect(html).not.toContain(root);
}, 30_000);

/**
 * @param {string} out_dir
 * @returns {import('vite').InlineConfig}
 */
function vite_config(out_dir) {
	return {
		root,
		mode: 'production',
		configFile: false,
		define: { 'import.meta.env.DEV': 'false' },
		logLevel: 'silent',
		plugins: [...enhancedImages({ dynamic: 'src/assets/**/*.png' }), vue()],
		build: {
			outDir: out_dir,
			emptyOutDir: true,
			minify: false
		}
	};
}

/** @param {string} filename @param {{ r: number, g: number, b: number, alpha: number }} background */
function write_image(filename, background) {
	return sharp({
		create: { width: 16, height: 8, channels: 4, background }
	})
		.png()
		.toFile(filename);
}

/** @param {string} directory @param {string} [base] */
async function read_tree(directory, base = directory) {
	/** @type {Array<{ name: string, content: string }>} */
	const output = [];
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const filename = path.join(directory, entry.name);
		if (entry.isDirectory()) output.push(...(await read_tree(filename, base)));
		else {
			output.push({
				name: path.relative(base, filename),
				content: /\.(?:css|html|js)$/.test(entry.name) ? await fs.readFile(filename, 'utf8') : ''
			});
		}
	}
	return output;
}

const APP_SOURCE = `<script setup>
import { EnhancedImg } from '@itznotabug/emage-vue';
import staticImage from './assets/red.png?enhanced';
import OptionsCollision from './OptionsCollision.vue';
import SlotCollector from './SlotCollector.vue';

const products = [
  { name: 'Red', image: '/src/assets/red.png' },
  { name: 'Blue', image: '/src/assets/blue.png?w=8' }
];
const remote = 'https://example.com/photo.jpg?token=kept&size=large';
const missing = '/src/assets/missing.png';
const slotProducts = [
  { name: 'red', image: '/src/assets/red.png?w=4' },
  { name: 'blue', image: '/src/assets/blue.png?w=12' }
];
const firstSlot = '/src/assets/red.png?w=5';
const secondSlot = '/src/assets/blue.png?w=13';
</script>

<template>
  <EnhancedImg :src="staticImage" alt="Static" />
  <EnhancedImg
    v-for="product in products"
    :key="product.name"
    :src="product.image"
    :alt="product.name"
    sizes="100vw"
  />
  <EnhancedImg :src="remote" alt="Remote" />
  <EnhancedImg :src="missing" alt="Missing" />
  <EnhancedImg src="/literal.png" alt="Literal" />
  <OptionsCollision />
  <SlotCollector>
    <template v-for="product in slotProducts" #[product.name]>
      <EnhancedImg :src="product.image" :alt="\`Slot \${product.name}\`" />
    </template>
  </SlotCollector>
  <SlotCollector>
    <template #first>
      <EnhancedImg :src="firstSlot" alt="First named slot" />
    </template>
    <template #second>
      <EnhancedImg :src="secondSlot" alt="Second named slot" />
    </template>
  </SlotCollector>
</template>
`;

const OPTIONS_COLLISION_SOURCE = `<script>
import { EnhancedImg } from '@itznotabug/emage-vue';

const image = '/src/assets/red.png?w=8';

export default {
  components: { EnhancedImg },
  data() {
    return { image: '/src/assets/blue.png' };
  }
};
</script>

<template>
  <EnhancedImg :src="image" alt="Options API" />
</template>
`;

const SLOT_COLLECTOR_SOURCE = `<script setup>
import { useSlots } from 'vue';

const slots = useSlots();
</script>

<template>
  <template v-for="(_, name) in slots" :key="name">
    <slot :name="name" />
  </template>
</template>
`;

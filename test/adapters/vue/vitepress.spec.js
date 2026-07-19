import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { workspace_root } from '#test/support/workspace.js';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

/** @type {string} */
let root;

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(workspace_root, '.integration-vitepress-'));
	await Promise.all([
		fs.mkdir(path.join(root, '.vitepress/theme'), { recursive: true }),
		fs.mkdir(path.join(root, 'assets'), { recursive: true }),
		fs.mkdir(path.join(root, 'public/images'), { recursive: true })
	]);
	await Promise.all([
		write_image(path.join(root, 'assets/static.png'), { r: 255, g: 120, b: 0, alpha: 1 }),
		write_image(path.join(root, 'public/images/runtime.png'), {
			r: 0,
			g: 150,
			b: 255,
			alpha: 1
		}),
		fs.writeFile(path.join(root, '.vitepress/config.mjs'), CONFIG_SOURCE),
		fs.writeFile(path.join(root, '.vitepress/theme/index.mjs'), THEME_SOURCE),
		fs.writeFile(path.join(root, 'index.md'), PAGE_SOURCE),
		fs.writeFile(path.join(root, 'fenced.md'), FENCED_PAGE_SOURCE),
		fs.writeFile(path.join(root, 'inline.md'), INLINE_PAGE_SOURCE)
	]);
	await build_vitepress(root);
}, 30_000);

afterAll(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
});

it('enhances imported and runtime-selected images in VitePress Markdown', async () => {
	const output = path.join(root, '.vitepress/dist');
	const html = await fs.readFile(path.join(output, 'index.html'), 'utf8');
	const files = await read_filenames(output);

	expect(html).toContain('<picture>');
	expect(html).toMatch(/<picture>.*?alt="Static".*?<\/picture>/s);
	expect(html).toMatch(/<picture>.*?alt="Runtime".*?<\/picture>/s);
	expect(html).toContain('src="https://example.com/docs.png?token=kept&amp;size=large"');
	expect(files.some((file) => file.endsWith('.avif'))).toBe(true);
	expect(files.some((file) => file.endsWith('.webp'))).toBe(true);
	expect(html).not.toContain('virtual:enhanced-img');
	expect(html).not.toContain('/@fs/');
	expect(html).not.toContain(root);
}, 30_000);

it('ignores component imports shown in Markdown code examples', async () => {
	const output = path.join(root, '.vitepress/dist');
	const [fenced_html, inline_html] = await Promise.all([
		fs.readFile(path.join(output, 'fenced.html'), 'utf8'),
		fs.readFile(path.join(output, 'inline.html'), 'utf8')
	]);

	expect(fenced_html).toMatch(/<picture>.*?alt="Fenced example".*?<\/picture>/s);
	expect(inline_html).toMatch(/<picture>.*?alt="Inline example".*?<\/picture>/s);
}, 30_000);

/** @param {string} site_root */
async function build_vitepress(site_root) {
	const manifest_path = require.resolve('vitepress/package.json');
	const manifest = JSON.parse(await fs.readFile(manifest_path, 'utf8'));
	const executable = path.resolve(path.dirname(manifest_path), manifest.bin.vitepress);
	await execute(process.execPath, [executable, 'build', site_root], {
		cwd: workspace_root,
		maxBuffer: 10 * 1024 * 1024
	});
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
async function read_filenames(directory, base = directory) {
	const output = [];
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const filename = path.join(directory, entry.name);
		if (entry.isDirectory()) output.push(...(await read_filenames(filename, base)));
		else output.push(path.relative(base, filename));
	}
	return output;
}

const CONFIG_SOURCE = `import { defineConfig } from 'vitepress';
import { enhancedImages } from '@itznotabug/emage-vue/vite';

export default defineConfig({
  title: 'Emage fixture',
  vite: {
    define: { 'import.meta.env.DEV': 'false' },
    plugins: [...enhancedImages({ dynamic: 'public/images/**/*.png' })]
  }
});
`;

const THEME_SOURCE = `import DefaultTheme from 'vitepress/theme';
import { EnhancedImg } from '@itznotabug/emage-vue';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('EnhancedImg', EnhancedImg);
  }
};
`;

const PAGE_SOURCE = `<script setup>
import { EnhancedImg } from '@itznotabug/emage-vue';
import staticImage from './assets/static.png?enhanced';

const runtimeImage = '/images/runtime.png';
const remoteImage = 'https://example.com/docs.png?token=kept&size=large';
</script>

# Emage in VitePress

<EnhancedImg :src="staticImage" alt="Static" />
<EnhancedImg :src="runtimeImage" alt="Runtime" sizes="100vw" />
<EnhancedImg :src="remoteImage" alt="Remote" />
`;

const FENCED_PAGE_SOURCE = `<script setup>
const runtimeImage = '/images/runtime.png';
</script>

# Fenced example

<EnhancedImg :src="runtimeImage" alt="Fenced example" sizes="100vw" />

\`\`\`vue
<script setup>
import EnhancedImg from './Example.vue';
</script>
\`\`\`

- \`\`\`vue
  <script setup>
  import EnhancedImg from './ListExample.vue';
  </script>
  \`\`\`

> ~~~vue
> <script setup>
> import EnhancedImg from './QuoteExample.vue';
> </script>
> ~~~

    <script setup>
    import EnhancedImg from './IndentedExample.vue';
    </script>
`;

const INLINE_PAGE_SOURCE = `# Inline example

Use \`<script setup>\` to add component-local bindings.

An unmatched \` remains ordinary text in this paragraph.

<script setup lang="ts" generic="T extends Record<string, unknown>">
const runtimeImage = \`/images/runtime.png\`;
</script>

Another unmatched \` remains ordinary text in a separate paragraph.

<EnhancedImg :src="runtimeImage" alt="Inline example" sizes="100vw" />

\`<script setup>import EnhancedImg from './Example.vue';<\/script>\`
`;

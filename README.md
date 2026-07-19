# Emage

Build-time responsive images for Vite, split into a framework-neutral engine and small
framework adapters.

- [`@itznotabug/emage-core`](./packages/core) owns image processing, catalogs, queries,
  and virtual modules.
- [`@itznotabug/emage-svelte`](./packages/svelte) owns the Svelte transform and
  `<enhanced:img>` integration.
- [`@itznotabug/emage-vue`](./packages/vue) provides `EnhancedImg` and the Vue/VitePress
  compiler integration.

## Svelte

`@itznotabug/emage-svelte` is an extended successor to
[`@sveltejs/enhanced-img@0.11.0`](https://github.com/sveltejs/kit/tree/main/packages/enhanced-img).
It retains `enhancedImages()`, `<enhanced:img>`, and `?enhanced`, while adding finite
dynamic image catalogs.

```sh
bun add --dev @itznotabug/emage-svelte
```

```js
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { enhancedImages } from '@itznotabug/emage-svelte';

export default {
  plugins: [enhancedImages(), svelte()]
};
```

See the [Svelte package README](./packages/svelte/README.md) for literal and dynamic
image examples.

## Vue and VitePress

Use `@itznotabug/emage-vue` with Vue or VitePress. It supports optimized imports and
finite catalogs for runtime-selected local paths. See the
[Vue package README](./packages/vue/README.md) for setup and examples.

## Development

```sh
bun install --frozen-lockfile
bun run verify
```

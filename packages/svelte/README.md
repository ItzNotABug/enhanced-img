# `@itznotabug/emage-svelte`

Build-time image optimization for Svelte + Vite, including opt-in finite catalogs for
image paths selected at runtime.

An extended successor to
[`@sveltejs/enhanced-img@0.11.0`](https://github.com/sveltejs/kit/tree/main/packages/enhanced-img),
with the familiar `enhancedImages()`, `<enhanced:img>`, and `?enhanced` API.

## Install

```sh
bun add --dev @itznotabug/emage-svelte
```

Place the plugin before Svelte:

```js
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { enhancedImages } from '@itznotabug/emage-svelte';

export default {
  plugins: [enhancedImages(), svelte()]
};
```

```svelte
<enhanced:img src="./hero.jpg" alt="Product screenshot" />
```

For runtime-selected local paths, declare a finite catalog:

```js
enhancedImages({
  dynamic: 'src/assets/**/*.{avif,gif,jpeg,jpg,png,tiff,webp}'
});
```

```svelte
{#each products as product}
  <enhanced:img src={product.image} alt={product.name} />
{/each}
```

Files must exist at build time. Remote URLs, SVGs, and unmatched paths pass through as
plain `<img>` elements.

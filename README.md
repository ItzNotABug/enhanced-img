# `@itznotabug/enhanced-img`

Build-time image optimization for Svelte + Vite, based on `@sveltejs/enhanced-img@0.11.0` -
plus opt-in support for image paths selected at runtime. Without the `dynamic` option,
behavior matches the upstream package.

## Install

```sh
bun add --dev @itznotabug/enhanced-img
```

Place the plugin before Svelte:

```js
// vite.config.js
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { enhancedImages } from '@itznotabug/enhanced-img';

export default {
  plugins: [enhancedImages(), svelte()]
};
```

Literal sources need no configuration:

```svelte
<enhanced:img src="./hero.jpg" alt="Product screenshot" />
```

## Dynamic images

Declare the files a runtime string may select — a glob or an array of globs:

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

Paths can be Vite-root (`/src/assets/hero.jpg`), public (`/images/hero.jpg`),
component-relative, or serializable Vite aliases. Queries work when their values are finite
at build time:

```svelte
<enhanced:img
  src={`${product.image}?w=400;800&quality=${compact ? 60 : 80}`}
  sizes="(max-width: 600px) 100vw, 600px"
  alt={product.name}
/>
```

Unmatched paths, unbounded queries, remote URLs, and SVGs render as plain `<img>`,
untouched — development warns once per miss, production stays silent. Files must exist at
build time; use an image CDN for anything uploaded after deployment.

## Development

```sh
bun install --frozen-lockfile
bun run verify
```

## Attribution

Derived from the MIT-licensed
[`@sveltejs/enhanced-img`](https://github.com/sveltejs/kit/tree/main/packages/enhanced-img);
the original notice is retained in [NOTICE.md](./NOTICE.md).

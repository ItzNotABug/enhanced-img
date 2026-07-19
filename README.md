# Emage

Build-time responsive images for Vite, split into a framework-neutral engine and small
framework adapters.

- [`@itznotabug/emage-core`](./packages/core) owns image processing, catalogs, queries,
  and virtual modules.
- [`@itznotabug/emage-svelte`](./packages/svelte) owns the Svelte transform and
  `<enhanced:img>` integration.

Vue support is planned separately and is not part of this release.

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

## Development

```sh
bun install --frozen-lockfile
bun run verify
```

# `@itznotabug/emage-vue`

Build-time responsive images for Vue + Vite, including finite catalogs for local image
paths selected at runtime. It also works in Vue components used by VitePress.

## Install

```sh
bun add @itznotabug/emage-vue
```

Place Emage before Vue:

```js
import vue from '@vitejs/plugin-vue';
import { enhancedImages } from '@itznotabug/emage-vue/vite';

export default {
  plugins: [enhancedImages(), vue()]
};
```

Import an optimized image and pass it to the component:

```vue
<script setup>
import { EnhancedImg } from '@itznotabug/emage-vue';
import hero from './hero.jpg?enhanced';
</script>

<template>
  <EnhancedImg :src="hero" alt="Product screenshot" />
</template>
```

For runtime-selected paths, declare a finite catalog and bind `src`:

```js
enhancedImages({
  dynamic: 'src/assets/**/*.{avif,gif,jpeg,jpg,png,tiff,webp}'
});
```

```vue
<EnhancedImg :src="product.image" :alt="product.name" />
```

VitePress uses the same component. Add `enhancedImages()` to `vite.plugins` in its
config, then import `EnhancedImg` in a Markdown `<script setup>` block or register it in
the theme. Files must exist at build time; remote URLs, SVGs, unmatched paths, and a
literal `src="..."` pass through as plain `<img>` elements.

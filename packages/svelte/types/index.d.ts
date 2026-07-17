import type { HTMLImgAttributes } from 'svelte/elements';
import type { EnhancedImagesOptions, Picture } from '@itznotabug/emage-core';

export type { EnhancedImagesOptions, Picture } from '@itznotabug/emage-core';

export type EnhancedImgAttributes = Omit<HTMLImgAttributes, 'src'> & {
	/**
	 * A `Picture` imported with `?enhanced`, or a local runtime string selected by
	 * the catalog configured through `enhancedImages({ dynamic: ... })`.
	 *
	 * ```js
	 * import hero from '$lib/assets/hero.jpg?enhanced';
	 * ```
	 *
	 * Note that this object is created automatically if you use `<enhanced:img>` directly:
	 *
	 * ```svelte
	 * <enhanced:img src="$lib/assets/hero.jpg" alt="..." />
	 * ```
	 */
	src: string | Picture;
};

// https://svelte.dev/docs/svelte/typescript#enhancing-built-in-dom-types
declare module 'svelte/elements' {
	export interface SvelteHTMLElements {
		'enhanced:img': Omit<HTMLImgAttributes, 'src'> & {
			/**
			 * If the `src` is a string, it will be treated as an asset import relative to the current module:
			 *
			 * ```svelte
			 * <enhanced:img src="$lib/assets/hero.jpg" alt="..." />
			 * ```
			 *
			 * A dynamic string can select a local file from the catalog configured with
			 * `enhancedImages({ dynamic: ... })`. The original `Picture` object created
			 * with `?enhanced` remains supported:
			 *
			 * ```js
			 * import hero from '$lib/assets/hero.jpg?enhanced';
			 * ```
			 */
			src: string | Picture;
		};
	}
}

// Structural on purpose: linked consumers may use another supported Vite version.
export function enhancedImages(options?: EnhancedImagesOptions): Array<{ name: string }>;

import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import { EnhancedImg } from '@itznotabug/emage-vue';

const picture = {
	sources: {
		avif: '/assets/hero.avif 640w, /assets/hero-wide.avif 1280w',
		webp: '/assets/hero.webp 640w, /assets/hero-wide.webp 1280w'
	},
	img: { src: '/assets/hero.jpg', w: 1280, h: 720 }
};

describe('EnhancedImg', () => {
	it('renders string sources as plain images with native attributes', async () => {
		const html = await render({
			src: 'https://example.com/photo.jpg?token=kept&size=large',
			alt: 'Remote photo',
			class: 'hero',
			loading: 'lazy'
		});

		expect(html).toBe(
			'<img alt="Remote photo" class="hero" loading="lazy" src="https://example.com/photo.jpg?token=kept&amp;size=large">'
		);
	});

	it('renders Picture sources and keeps image attributes on the img', async () => {
		const html = await render({
			src: picture,
			alt: 'Product screenshot',
			class: 'hero',
			sizes: '(min-width: 60rem) 50vw, 100vw'
		});

		expect(html).toContain('<picture>');
		expect(html).toContain(
			'<source srcset="/assets/hero.avif 640w, /assets/hero-wide.avif 1280w" sizes="(min-width: 60rem) 50vw, 100vw" type="image/avif">'
		);
		expect(html).toContain(
			'<img alt="Product screenshot" class="hero" src="/assets/hero.jpg" width="1280" height="720">'
		);
		expect(html).not.toMatch(/<picture[^>]+class=/);
	});

	it('infers the missing intrinsic dimension without overriding user values', async () => {
		const with_width = await render({ src: picture, alt: '', width: 640 });
		const with_height = await render({ src: picture, alt: '', height: '360' });

		for (const html of [with_width, with_height]) {
			expect(html).toContain('width="640"');
			expect(html).toContain('height="360"');
		}
	});
});

/** @param {import('@itznotabug/emage-vue').EnhancedImgProps} props */
function render(props) {
	return renderToString(createSSRApp({ render: () => h(EnhancedImg, props) }));
}

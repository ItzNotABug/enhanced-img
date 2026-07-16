import {
	enhancedImages,
	type EnhancedImagesOptions,
	type EnhancedImgAttributes,
	type Picture
} from '@itznotabug/emage-svelte';

enhancedImages();
enhancedImages({ dynamic: 'src/assets/**/*.jpg' });
enhancedImages({ dynamic: ['src/assets/**', '!src/assets/drafts/**'] });

const options: EnhancedImagesOptions = { dynamic: ['public/images/**/*.png'] };
enhancedImages(options);

declare const picture: Picture;
const imported: EnhancedImgAttributes = { src: picture, alt: 'Imported' };
const catalogued: EnhancedImgAttributes = { src: '/images/runtime.jpg', alt: 'Catalogued' };
void imported;
void catalogued;

// @ts-expect-error unknown options are rejected
enhancedImages({ queries: [] });

// @ts-expect-error dynamic accepts only a string or readonly string array
enhancedImages({ dynamic: { root: 'src' } });

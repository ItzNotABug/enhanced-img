import { EnhancedImg, type EnhancedImgProps, type Picture } from '@itznotabug/emage-vue';
import { enhancedImages, type EnhancedImagesOptions } from '@itznotabug/emage-vue/vite';
import type { GlobalComponents } from 'vue';

enhancedImages();
enhancedImages({ dynamic: 'src/assets/**/*.jpg' });
enhancedImages({ dynamic: ['src/assets/**', '!src/assets/drafts/**'] });

const options: EnhancedImagesOptions = { dynamic: ['public/images/**/*.png'] };
enhancedImages(options);

declare const picture: Picture;
const imported: EnhancedImgProps = { src: picture, alt: 'Imported' };
const catalogued: EnhancedImgProps = { src: '/images/runtime.jpg', alt: 'Catalogued' };
const locally_registered: 'EnhancedImg' extends keyof GlobalComponents ? false : true = true;
void EnhancedImg;
void imported;
void catalogued;
void locally_registered;

// @ts-expect-error src is required
const missing: EnhancedImgProps = { alt: 'Missing' };
void missing;

// @ts-expect-error unknown options are rejected
enhancedImages({ queries: [] });

// @ts-expect-error dynamic accepts only a string or readonly string array
enhancedImages({ dynamic: { root: 'src' } });

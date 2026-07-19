import type { DefineComponent, ImgHTMLAttributes } from 'vue';
import type { Picture } from '@itznotabug/emage-core';

export type { Picture } from '@itznotabug/emage-core';

export type EnhancedImgProps = Omit<ImgHTMLAttributes, 'src'> & {
	src: string | Picture;
};

export const EnhancedImg: DefineComponent<EnhancedImgProps>;

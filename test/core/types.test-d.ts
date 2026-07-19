import {
	create_image_plugins,
	normalize_options,
	type EnhancedImagesOptions,
	type EvaluationResult,
	type Picture
} from '@itznotabug/emage-core';

const options: EnhancedImagesOptions = {
	dynamic: ['src/assets/**/*.jpg', '!src/assets/drafts/**']
};
const normalized = normalize_options(options);
const plugins = create_image_plugins(Boolean(normalized.dynamic));

declare const picture: Picture;
void picture.img.src;
void plugins.publicPlugin;
void plugins.catalogPlugin;

declare const evaluation: EvaluationResult;
if (evaluation.kind === 'overflow') {
	const count: number = evaluation.count;
	const projected: number | undefined = evaluation.projected_count;
	void count;
	void projected;
}

// @ts-expect-error unknown options are rejected
const invalid: EnhancedImagesOptions = { queries: [] };
void invalid;

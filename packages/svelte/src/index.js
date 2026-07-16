import process from 'node:process';
import { create_image_plugins, normalize_options } from '@itznotabug/emage-core';
import { image_plugin } from './vite-plugin.js';

/**
 * @param {import('../types/index.js').EnhancedImagesOptions} [options]
 * @returns {import('vite').Plugin[]}
 */
export function enhancedImages(options) {
	const normalized = normalize_options(options);
	const dynamic_enabled = Boolean(normalized.dynamic);
	const { publicPlugin, catalogPlugin } = create_image_plugins(dynamic_enabled);
	return !process.versions.webcontainer
		? [image_plugin(publicPlugin, normalized, catalogPlugin), publicPlugin]
		: [];
}

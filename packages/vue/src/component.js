import { defineComponent, h } from 'vue';

/**
 * Render a vite-imagetools Picture without taking ownership of native image
 * attributes. Fallthrough attributes, including listeners, stay on the img.
 */
export const EnhancedImg = defineComponent({
	name: 'EnhancedImg',
	inheritAttrs: false,
	props: {
		src: {
			type: [String, Object],
			required: true
		}
	},
	setup(props, { attrs }) {
		return () => {
			if (!is_picture(props.src)) {
				return h('img', {
					...attrs,
					...(typeof props.src === 'string' ? { src: props.src } : {})
				});
			}

			const sources = Object.entries(props.src.sources).map(([format, srcset]) =>
				h('source', {
					key: format,
					srcset,
					...(attrs.sizes == null ? {} : { sizes: attrs.sizes }),
					type: `image/${format}`
				})
			);
			const image_attrs = { ...attrs };
			delete image_attrs.sizes;

			return h('picture', null, [
				...sources,
				h('img', picture_img_attributes(image_attrs, props.src))
			]);
		};
	}
});

/**
 * @param {unknown} value
 * @returns {value is import('@itznotabug/emage-core').Picture}
 */
function is_picture(value) {
	if (value === null || typeof value !== 'object') return false;
	const candidate = /** @type {{ sources?: unknown, img?: unknown }} */ (value);
	if (candidate.img === null || typeof candidate.img !== 'object') return false;
	const image = /** @type {{ src?: unknown, w?: unknown, h?: unknown }} */ (candidate.img);

	return (
		candidate.sources !== null &&
		typeof candidate.sources === 'object' &&
		!Array.isArray(candidate.sources) &&
		typeof image.src === 'string' &&
		typeof image.w === 'number' &&
		Number.isFinite(image.w) &&
		typeof image.h === 'number' &&
		Number.isFinite(image.h)
	);
}

/**
 * @param {Readonly<Record<string, unknown>>} attrs
 * @param {import('@itznotabug/emage-core').Picture} picture
 */
function picture_img_attributes(attrs, picture) {
	/** @type {Record<string, unknown>} */
	const result = { ...attrs, src: picture.img.src };
	const has_width = attrs.width != null;
	const has_height = attrs.height != null;

	if (!has_width && !has_height) {
		result.width = picture.img.w;
		result.height = picture.img.h;
	} else if (!has_width) {
		const height = finite_number(attrs.height);
		if (height !== undefined) result.width = Math.round((picture.img.w * height) / picture.img.h);
	} else if (!has_height) {
		const width = finite_number(attrs.width);
		if (width !== undefined) result.height = Math.round((picture.img.h * width) / picture.img.w);
	}

	return result;
}

/** @param {unknown} value */
function finite_number(value) {
	const number =
		typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	return Number.isFinite(number) ? number : undefined;
}

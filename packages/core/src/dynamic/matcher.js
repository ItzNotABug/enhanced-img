import path from 'node:path';
import picomatch from 'picomatch';
import { is_negative_pattern } from '../options.js';
import { RASTER_EXTENSION } from './paths.js';

/**
 * Match watcher events against the same positive and negative glob set used
 * by discovery, without starting another filesystem scan.
 *
 * @param {readonly string[]} patterns
 * @param {string} root
 */
export function create_dynamic_file_matcher(patterns, root) {
	const positives = patterns.filter((pattern) => !is_negative_pattern(pattern));
	const negatives = patterns.filter(is_negative_pattern).map((pattern) => pattern.slice(1));
	const included = picomatch(positives, { dot: false, nocase: false });
	const excluded = negatives.length
		? picomatch(negatives, { dot: false, nocase: false })
		: () => false;
	const resolved_root = path.resolve(root);

	return (filename) => {
		const absolute = path.isAbsolute(filename)
			? path.resolve(filename)
			: path.resolve(resolved_root, filename);
		const relative = path.relative(resolved_root, absolute);
		if (
			relative === '' ||
			relative === '..' ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative) ||
			!RASTER_EXTENSION.test(absolute)
		) {
			return false;
		}
		const key = relative.split(path.sep).join('/');
		return included(key) && !excluded(key);
	};
}

/**
 * @param {import('vite').ViteDevServer | undefined} server
 * @param {readonly string[]} ids
 * @param {Set<import('vite').ModuleNode>} [seen]
 */
export function invalidate_virtual_modules(server, ids, seen = new Set()) {
	if (!server) return;
	for (const id of ids) {
		const module = server.moduleGraph.getModuleById(id);
		if (module) server.moduleGraph.invalidateModule(module, seen);
	}
}

/**
 * Compare only the runtime mapping inputs. Discovery metadata such as the
 * matched spelling does not require resolver regeneration.
 *
 * @param {readonly { source: string, key: string, keys: readonly string[] }[]} left
 * @param {readonly { source: string, key: string, keys: readonly string[] }[]} right
 */
export function same_dynamic_candidates(left, right) {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const left_candidate = left[index];
		const right_candidate = right[index];
		if (
			left_candidate.source !== right_candidate.source ||
			left_candidate.key !== right_candidate.key ||
			left_candidate.keys.length !== right_candidate.keys.length ||
			left_candidate.keys.some((key, key_index) => key !== right_candidate.keys[key_index])
		) {
			return false;
		}
	}
	return true;
}

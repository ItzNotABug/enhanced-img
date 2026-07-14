import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { is_negative_pattern, resolve_dynamic_patterns } from '../options.js';
import {
	RASTER_EXTENSION,
	canonical_collision_key,
	canonicalize_candidate_path,
	runtime_path_config
} from './paths.js';

/**
 * @typedef {{ dynamic?: readonly string[] }} DiscoveryOptions
 * @typedef {{ key: string, keys: string[], source: string, file: string, relativePath: string, rootKey: string, public: boolean }} DynamicCandidate
 */

/**
 * Discover and validate the finite dynamic image catalog once per plugin
 * instance. Image bytes and metadata are deliberately not read here.
 *
 * @param {Readonly<DiscoveryOptions>} options
 * @param {{ root: string, publicDir?: string | false, resolve?: { alias?: unknown } }} config
 * @param {{ warn?: (message: string) => void, glob?: typeof glob }} [hooks]
 */
export async function discover_candidates(options, config, hooks = {}) {
	const root = path.resolve(config.root);
	const public_dir = resolve_public_dir(config.publicDir, root);
	const patterns = resolve_dynamic_patterns(options, root) ?? [];

	if (patterns.length === 0) {
		return {
			patterns,
			root,
			publicDir: public_dir,
			aliases: [],
			candidates: /** @type {DynamicCandidate[]} */ ([]),
			byKey: /** @type {Map<string, DynamicCandidate>} */ (new Map())
		};
	}

	const real_root = await fs.realpath(root);
	await validate_glob_symlinks(patterns, root, real_root);
	const runtime = runtime_path_config(
		{ root, publicDir: public_dir, resolve: config.resolve },
		{ warn: hooks.warn }
	);

	const globber = hooks.glob ?? glob;
	const matches = await globber(patterns, {
		cwd: root,
		absolute: true,
		onlyFiles: true,
		followSymbolicLinks: true,
		expandDirectories: false,
		caseSensitiveMatch: true
	});

	const files = [...new Set(matches.map((file) => path.resolve(root, file)))].sort(compare_paths);
	/** @type {DynamicCandidate[]} */
	const candidates = [];

	for (const file of files) {
		const relative = confined_relative(root, file);
		if (relative === null) {
			throw discovery_error(`glob matched a path outside the Vite root: ${JSON.stringify(file)}`);
		}
		if (!RASTER_EXTENSION.test(file)) continue;

		let source;
		try {
			source = await fs.realpath(file);
		} catch (error) {
			throw discovery_error(`could not resolve dynamic candidate ${JSON.stringify(file)}`, error);
		}

		if (confined_relative(real_root, source) === null) {
			throw discovery_error(
				`dynamic candidate resolves outside the Vite root through a symlink: ${JSON.stringify(file)} -> ${JSON.stringify(source)}`
			);
		}

		const stats = await fs.stat(source);
		if (!stats.isFile()) continue;

		const relative_path = to_posix(relative);
		const public_relative = public_dir ? confined_relative(public_dir, file) : null;
		let canonical;
		try {
			canonical = canonicalize_candidate_path(
				relative_path,
				public_relative === null ? undefined : to_posix(public_relative)
			);
		} catch (error) {
			throw discovery_error(`invalid dynamic candidate ${JSON.stringify(file)}`, error);
		}

		candidates.push({
			key: canonical.key,
			keys: [canonical.key],
			source,
			file,
			relativePath: relative_path,
			rootKey: canonical.rootKey,
			public: public_relative !== null
		});
	}

	candidates.sort((a, b) => a.key.localeCompare(b.key, 'en') || compare_paths(a.file, b.file));
	/** @type {Map<string, DynamicCandidate>} */
	const by_key = new Map();
	/** @type {Map<string, DynamicCandidate>} */
	const portable_keys = new Map();

	for (const candidate of candidates) {
		const existing = by_key.get(candidate.key);
		if (existing && existing.file !== candidate.file) {
			throw collision_error(candidate.key, existing.file, candidate.file);
		}

		const portable_key = canonical_collision_key(candidate.key);
		const portable_existing = portable_keys.get(portable_key);
		if (portable_existing && portable_existing.file !== candidate.file) {
			throw collision_error(candidate.key, portable_existing.file, candidate.file);
		}

		by_key.set(candidate.key, candidate);
		portable_keys.set(portable_key, candidate);
	}

	return {
		patterns,
		root,
		publicDir: public_dir,
		aliases: runtime.aliases,
		candidates,
		byKey: by_key
	};
}

/**
 * @param {string | false | undefined} public_dir
 * @param {string} root
 */
function resolve_public_dir(public_dir, root) {
	if (!public_dir) return undefined;
	return path.isAbsolute(public_dir) ? path.resolve(public_dir) : path.resolve(root, public_dir);
}

/**
 * @param {string} base
 * @param {string} file
 */
function confined_relative(base, file) {
	const relative = path.relative(base, file);
	if (relative === '') return '';
	if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return null;
	}
	return relative;
}

/** @param {string} value */
function to_posix(value) {
	return value.split(path.sep).join('/');
}

/**
 * @param {string} a First path.
 * @param {string} b Second path.
 */
function compare_paths(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Validate every symlink reachable from tinyglobby's positive-pattern scan
 * roots before starting the glob crawl. Internal directory targets are walked
 * by real path with cycle detection; escaping targets are rejected without
 * ever traversing them.
 *
 * @param {readonly string[]} patterns
 * @param {string} root
 * @param {string} real_root
 */
async function validate_glob_symlinks(patterns, root, real_root) {
	const roots = patterns
		.filter((pattern) => !is_negative_pattern(pattern))
		.map((pattern) => path.resolve(root, static_glob_root(pattern)))
		.sort(compare_paths);
	const scan_roots = roots.filter(
		(candidate, index) =>
			roots.findIndex(
				(other) =>
					other === candidate ||
					(confined_relative(other, candidate) !== null && other !== candidate)
			) === index
	);
	const visited = new Set();

	for (const scan_root of scan_roots) {
		let stats;
		try {
			stats = await fs.lstat(scan_root);
		} catch (error) {
			if (is_missing_file_error(error)) continue;
			throw discovery_error(
				`could not inspect dynamic glob root ${JSON.stringify(scan_root)}`,
				error
			);
		}
		await validate_filesystem_entry(scan_root, stats, real_root, visited);
	}
}

/**
 * Return the non-magical prefix tinyglobby can use as a crawl root. For an
 * exact pattern the path itself is enough to validate a file symlink.
 *
 * @param {string} pattern
 */
function static_glob_root(pattern) {
	const segments = pattern.split('/');
	const prefix = [];
	for (const segment of segments) {
		if (/[*?[\]{}()!+@]/.test(segment)) break;
		prefix.push(segment);
	}
	return prefix.join('/');
}

/**
 * @param {string} entry_path
 * @param {import('node:fs').Stats} stats
 * @param {string} real_root
 * @param {Set<string>} visited
 */
async function validate_filesystem_entry(entry_path, stats, real_root, visited) {
	let resolved_path = entry_path;
	let resolved_stats = stats;

	if (stats.isSymbolicLink()) {
		try {
			resolved_path = await fs.realpath(entry_path);
			resolved_stats = await fs.stat(resolved_path);
		} catch (error) {
			throw discovery_error(
				`could not resolve dynamic candidate symlink ${JSON.stringify(entry_path)}`,
				error
			);
		}
		if (confined_relative(real_root, resolved_path) === null) {
			throw discovery_error(
				`dynamic candidate resolves outside the Vite root through a symlink: ${JSON.stringify(entry_path)} -> ${JSON.stringify(resolved_path)}`
			);
		}
	} else {
		// `entry_path` itself may sit below a symlinked ancestor when it is an
		// exact (non-glob) scan root. Resolve every entry before returning for a
		// regular file so the crawl cannot be the first operation to cross it.
		try {
			resolved_path = await fs.realpath(entry_path);
		} catch (error) {
			throw discovery_error(
				`could not resolve dynamic glob entry ${JSON.stringify(entry_path)}`,
				error
			);
		}
		if (confined_relative(real_root, resolved_path) === null) {
			throw discovery_error(
				`dynamic candidate resolves outside the Vite root through a symlinked ancestor: ${JSON.stringify(entry_path)} -> ${JSON.stringify(resolved_path)}`
			);
		}
	}

	if (!resolved_stats.isDirectory()) return;
	const real_directory = await fs.realpath(resolved_path);
	if (confined_relative(real_root, real_directory) === null) {
		throw discovery_error(
			`dynamic glob directory resolves outside the Vite root: ${JSON.stringify(entry_path)} -> ${JSON.stringify(real_directory)}`
		);
	}
	if (visited.has(real_directory)) return;
	visited.add(real_directory);

	let directory;
	try {
		directory = await fs.opendir(real_directory);
	} catch (error) {
		throw discovery_error(
			`could not inspect dynamic glob directory ${JSON.stringify(entry_path)}`,
			error
		);
	}

	for await (const entry of directory) {
		const child = path.join(real_directory, entry.name);
		let child_stats;
		try {
			child_stats = await fs.lstat(child);
		} catch (error) {
			throw discovery_error(`could not inspect dynamic glob entry ${JSON.stringify(child)}`, error);
		}
		await validate_filesystem_entry(child, child_stats, real_root, visited);
	}
}

/** @param {unknown} error */
function is_missing_file_error(error) {
	return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

/**
 * @param {string} key
 * @param {string} first
 * @param {string} second
 */
function collision_error(key, first, second) {
	return discovery_error(
		`canonical runtime key collision for ${JSON.stringify(key)} between ${JSON.stringify(first)} and ${JSON.stringify(second)}`
	);
}

/**
 * @param {string} message
 * @param {unknown} [cause]
 */
function discovery_error(message, cause) {
	return new Error(
		`@itznotabug/enhanced-img: ${message}`,
		cause === undefined ? undefined : { cause }
	);
}

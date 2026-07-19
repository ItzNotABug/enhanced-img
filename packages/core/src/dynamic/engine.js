import { discover_candidates } from './discover.js';
import {
	create_dynamic_file_matcher,
	invalidate_virtual_modules,
	same_dynamic_candidates
} from './matcher.js';
import { create_dynamic_virtual_modules } from './virtual.js';
import { format_emage_log } from '../logger.js';

/**
 * Own the framework-neutral dynamic catalog, virtual-module graph, and watcher
 * lifecycle. A framework adapter supplies only its owner-file predicate and
 * root-relative module key function.
 *
 * @param {{
 *   options: Readonly<{ dynamic?: readonly string[] }>,
 *   imagetoolsPlugin: import('vite').Plugin,
 *   isOwner: (filename: string) => boolean,
 *   ownerKey: (filename: string, root: string) => string,
 *   logLabel?: string
 * }} config
 */
export function create_dynamic_image_engine(config) {
	const log_label = config.logLabel ?? 'emage';
	/** @type {import('vite').ResolvedConfig} */
	let vite_config;
	/** @type {Awaited<ReturnType<typeof discover_candidates>> | undefined} */
	let catalog;
	/** @type {ReturnType<typeof create_dynamic_virtual_modules> | undefined} */
	let modules;
	/** @type {import('vite').ViteDevServer | undefined} */
	let dev_server;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let catalog_refresh_timer;
	/** @type {(() => void) | undefined} */
	let cleanup_dynamic_watcher;
	let catalog_refresh_generation = 0;
	let catalog_refresh_running = false;
	let catalog_refresh_rerun = false;
	/** @type {(filename: string) => boolean} */
	let matches_dynamic_file = () => false;
	let summary_logged = false;

	/** @param {import('vite').ResolvedConfig} resolved */
	async function initialize(resolved) {
		vite_config = resolved;
		catalog = await discover_candidates(config.options, resolved, {
			warn: (message) => resolved.logger.warn(message)
		});
		modules = create_dynamic_virtual_modules({
			imagetools_plugin: config.imagetoolsPlugin,
			candidates: catalog.candidates,
			patterns: catalog.patterns,
			aliases: catalog.aliases
		});
		matches_dynamic_file = create_dynamic_file_matcher(catalog.patterns, resolved.root);
	}

	/** @param {import('vite').ViteDevServer} server */
	function configure_server(server) {
		cleanup_dynamic_watcher?.();
		dev_server = server;
		if (!summary_logged && catalog && vite_config.logLevel !== 'silent') {
			summary_logged = true;
			console.log(
				format_emage_log(
					log_label,
					`watching ${catalog.candidates.length} catalogued ${catalog.candidates.length === 1 ? 'image' : 'images'}`,
					'success'
				)
			);
		}

		/** @param {string} filename */
		const on_catalog_event = (filename) => {
			if (!matches_dynamic_file(filename)) return;
			catalog_refresh_generation += 1;
			arm_catalog_refresh();
		};
		/** @param {string} filename */
		const on_owner_unlink = (filename) => {
			if (!modules || !config.isOwner(filename)) return;
			let owner;
			try {
				owner = config.ownerKey(filename, vite_config.root);
			} catch {
				return;
			}
			const retired = modules.release_owner(owner);
			invalidate_virtual_modules(server, [...retired.profileIds, ...retired.removedAssetIds]);
		};

		const cleanup = () => {
			server.watcher.off('add', on_catalog_event);
			server.watcher.off('unlink', on_catalog_event);
			server.watcher.off('unlink', on_owner_unlink);
			server.httpServer?.off('close', cleanup);
			if (dev_server !== server) return;
			dev_server = undefined;
			catalog_refresh_generation += 1;
			catalog_refresh_rerun = false;
			if (catalog_refresh_timer) clearTimeout(catalog_refresh_timer);
			catalog_refresh_timer = undefined;
			cleanup_dynamic_watcher = undefined;
		};

		cleanup_dynamic_watcher = cleanup;
		server.watcher.on('add', on_catalog_event);
		server.watcher.on('unlink', on_catalog_event);
		server.watcher.on('unlink', on_owner_unlink);
		server.httpServer?.once('close', cleanup);
	}

	function arm_catalog_refresh() {
		if (catalog_refresh_timer) clearTimeout(catalog_refresh_timer);
		const generation = catalog_refresh_generation;
		catalog_refresh_timer = setTimeout(() => {
			catalog_refresh_timer = undefined;
			void refresh_catalog(generation);
		}, 50);
	}

	/** @param {number} generation */
	async function refresh_catalog(generation) {
		const server = dev_server;
		if (!server || generation !== catalog_refresh_generation) return;
		if (catalog_refresh_running) {
			catalog_refresh_rerun = true;
			return;
		}

		catalog_refresh_running = true;
		catalog_refresh_rerun = false;
		try {
			const next_catalog = await discover_candidates(config.options, vite_config);
			if (dev_server !== server || generation !== catalog_refresh_generation) return;
			if (!catalog || !modules) return;
			if (same_dynamic_candidates(catalog.candidates, next_catalog.candidates)) {
				catalog = next_catalog;
				return;
			}

			const invalidated = modules.set_candidates(next_catalog.candidates);
			catalog = next_catalog;
			/** @type {Set<import('vite').ModuleNode>} */
			const seen = new Set();
			invalidate_virtual_modules(
				server,
				[...invalidated.catalogIds, ...invalidated.profileIds, ...invalidated.removedAssetIds],
				seen
			);
			server.ws.send({ type: 'full-reload', path: '*' });
		} catch (error) {
			if (dev_server === server && generation === catalog_refresh_generation) {
				vite_config.logger.error(
					format_emage_log(
						log_label,
						`failed to refresh the dynamic image catalog: ${format_error(error)}`,
						'error'
					)
				);
			}
		} finally {
			catalog_refresh_running = false;
			if (
				dev_server &&
				(catalog_refresh_rerun ||
					(dev_server === server && generation !== catalog_refresh_generation))
			) {
				catalog_refresh_rerun = false;
				arm_catalog_refresh();
			}
		}
	}

	/** @param {import('vite').HmrContext} context */
	function handle_hot_update(context) {
		if (!modules || !config.isOwner(context.file)) return;
		let owner;
		try {
			owner = config.ownerKey(context.file, vite_config.root);
		} catch {
			return;
		}
		const retired = modules.release_owner(owner);
		invalidate_virtual_modules(context.server, [...retired.profileIds, ...retired.removedAssetIds]);
	}

	/**
	 * @param {string} owner
	 * @param {Iterable<string>} profile_hashes
	 */
	function set_owner_profiles(owner, profile_hashes) {
		if (!modules) throw new Error('@itznotabug/emage-core: dynamic modules are not initialized');
		const retired = modules.set_owner_profiles(owner, profile_hashes);
		invalidate_virtual_modules(dev_server, [...retired.profileIds, ...retired.removedAssetIds]);
	}

	function log_summary() {
		if (
			summary_logged ||
			!catalog ||
			!modules ||
			vite_config.command !== 'build' ||
			Boolean(vite_config.build?.ssr) ||
			vite_config.logLevel === 'silent'
		) {
			return;
		}
		summary_logged = true;
		let pairs = 0;
		for (const profile of modules.profiles.values()) pairs += profile.entries.length;
		if (pairs > 2_000) {
			vite_config.logger.warn(
				format_emage_log(
					log_label,
					`the dynamic catalog projects ${pairs} image/profile pairs; consider narrowing the configured glob`,
					'warning'
				)
			);
		}
	}

	return Object.freeze({
		get catalog() {
			return catalog;
		},
		get modules() {
			return modules;
		},
		initialize,
		configure_server,
		set_owner_profiles,
		resolve_id(id) {
			return modules?.resolve_id(id);
		},
		load_with_context(context, id) {
			return modules?.load_with_context(context, id);
		},
		handle_hot_update,
		write_bundle() {
			log_summary();
		},
		close_bundle() {
			cleanup_dynamic_watcher?.();
		}
	});
}

/** @param {unknown} error */
function format_error(error) {
	return error instanceof Error ? error.message : String(error);
}

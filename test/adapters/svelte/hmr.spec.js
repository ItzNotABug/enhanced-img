import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { image_plugin } from '#svelte/vite-plugin.js';

/** @type {string | undefined} */
let fixture_root;

afterEach(async () => {
	vi.restoreAllMocks();
	if (fixture_root) await fs.rm(fixture_root, { recursive: true, force: true });
	fixture_root = undefined;
});

describe('dynamic catalog HMR', () => {
	it('coalesces catalog events, refreshes resolver modules, and ignores unchanged catalogs', async () => {
		fixture_root = await fs.mkdtemp(path.join(os.tmpdir(), 'enhanced-img-hmr-'));
		const assets = path.join(fixture_root, 'src/assets');
		await fs.mkdir(assets, { recursive: true });
		const first = path.join(assets, 'first.png');
		await fs.writeFile(first, 'first');

		const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const plugin = image_plugin(
			{
				name: 'imagetools-mock',
				load: vi.fn(() => 'export default {}')
			},
			{
				dynamic: ['src/assets/**/*.png', 'src/assets/**/*.PNG', '!src/assets/ignored.png']
			}
		);
		const config = /** @type {import('vite').ResolvedConfig} */ (
			/** @type {unknown} */ ({
				root: fixture_root,
				publicDir: path.join(fixture_root, 'public'),
				logLevel: 'silent',
				resolve: { alias: [] },
				logger,
				plugins: [
					{
						name: 'vite-plugin-svelte:config',
						api: { filter: { id: { include: [/\.svelte$/], exclude: [] } } }
					}
				]
			})
		);
		await call_hook(plugin.configResolved, config);

		const watcher = new EventEmitter();
		const http_server = new EventEmitter();
		const profile_node = /** @type {import('vite').ModuleNode} */ (
			/** @type {unknown} */ ({ marker: 'profile' })
		);
		/** @type {string | undefined} */
		let resolved_profile_id;
		const module_graph = {
			getModuleById: vi.fn((id) => (id === resolved_profile_id ? profile_node : undefined)),
			invalidateModule: vi.fn()
		};
		const send = vi.fn();
		const server = /** @type {import('vite').ViteDevServer} */ (
			/** @type {unknown} */ ({
				watcher,
				httpServer: http_server,
				moduleGraph: module_graph,
				ws: { send }
			})
		);
		await call_hook(plugin.configureServer, server);

		const component = path.join(fixture_root, 'src/App.svelte');
		const transformed = await call_transform(
			plugin,
			`<script>const src = '/src/assets/first.png';</script>\n<enhanced:img {src} alt="First" />`,
			component
		);
		const profile_id = transformed.code.match(
			/from "(virtual:enhanced-img\/dynamic\/[a-f\d]+)"/
		)?.[1];
		expect(profile_id).toBeDefined();
		const resolved = await call_hook(plugin.resolveId, profile_id);
		if (typeof resolved !== 'string') throw new Error('expected resolved profile ID');
		resolved_profile_id = resolved;
		const realpath = vi.spyOn(fs, 'realpath');
		const scans_before_unrelated_events = realpath.mock.calls.length;

		const outside_catalog = path.join(fixture_root, 'outside.png');
		await fs.writeFile(outside_catalog, 'outside');
		watcher.emit('add', outside_catalog);
		const excluded = path.join(assets, 'ignored.png');
		await fs.writeFile(excluded, 'ignored');
		watcher.emit('add', excluded);
		await delay(120);
		expect(realpath).toHaveBeenCalledTimes(scans_before_unrelated_events);
		expect(send).not.toHaveBeenCalled();
		expect(module_graph.invalidateModule).not.toHaveBeenCalled();

		const second = path.join(assets, 'second.png');
		await fs.writeFile(second, 'second');
		watcher.emit('add', second);
		watcher.emit('add', second);
		watcher.emit('add', second);
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

		expect(module_graph.getModuleById).toHaveBeenCalledWith(resolved_profile_id);
		expect(module_graph.invalidateModule).toHaveBeenCalledWith(profile_node, expect.any(Set));
		const refreshed_resolver = await call_hook(plugin.load, resolved_profile_id);
		expect(String(refreshed_resolver).match(/virtual:enhanced-img\/asset\//g)).toHaveLength(2);

		const uppercase = path.join(assets, 'UPPER.PNG');
		await fs.writeFile(uppercase, 'uppercase');
		watcher.emit('add', uppercase);
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
		const uppercase_resolver = await call_hook(plugin.load, resolved_profile_id);
		expect(String(uppercase_resolver)).toContain('/src/assets/UPPER.PNG');
		expect(String(uppercase_resolver).match(/virtual:enhanced-img\/asset\//g)).toHaveLength(3);

		const renamed = path.join(assets, 'renamed.png');
		await fs.rename(second, renamed);
		watcher.emit('unlink', second);
		watcher.emit('add', renamed);
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
		const renamed_resolver = await call_hook(plugin.load, resolved_profile_id);
		expect(String(renamed_resolver).match(/virtual:enhanced-img\/asset\//g)).toHaveLength(3);

		await fs.rm(renamed);
		watcher.emit('unlink', renamed);
		watcher.emit('unlink', renamed);
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));

		watcher.emit('unlink', component);
		expect(await call_hook(plugin.resolveId, profile_id)).toBeUndefined();

		await call_hook(plugin.closeBundle);
		await fs.writeFile(second, 'second');
		watcher.emit('add', second);
		await delay(120);
		expect(send).toHaveBeenCalledTimes(4);
	});
});

/**
 * @param {any} hook
 * @param {...any} args
 * @returns {Promise<any>}
 */
async function call_hook(hook, ...args) {
	if (!hook) throw new Error('expected plugin hook');
	const handler = typeof hook === 'object' ? hook.handler : hook;
	return handler(...args);
}

/**
 * @param {import('vite').Plugin} plugin
 * @param {string} code
 * @param {string} filename
 */
async function call_transform(plugin, code, filename) {
	const hook = plugin.transform;
	if (!hook) throw new Error('expected transform hook');
	const handler = typeof hook === 'object' ? hook.handler : hook;
	const result = await handler.call(
		/** @type {import('rollup').TransformPluginContext} */ (
			/** @type {unknown} */ ({ warn: vi.fn() })
		),
		code,
		filename
	);
	if (!result || typeof result === 'string') throw new Error('expected transformed code');
	return result;
}

/** @param {number} milliseconds */
function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspace_root } from '#test/support/workspace.js';

const root = workspace_root;

async function read_json(relative) {
	return JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'));
}

async function source_text(directory) {
	const entries = await fs.readdir(path.join(root, directory), {
		recursive: true,
		withFileTypes: true
	});
	const files = entries.filter((entry) => entry.isFile() && /\.[jt]s$/.test(entry.name));
	return Promise.all(
		files.map((entry) =>
			fs.readFile(path.join(entry.parentPath, entry.name), {
				encoding: 'utf8'
			})
		)
	).then((sources) => sources.join('\n'));
}

describe('workspace package boundaries', () => {
	it('keeps the workspace private and publishes two independent packages', async () => {
		const [workspace, core, svelte] = await Promise.all([
			read_json('package.json'),
			read_json('packages/core/package.json'),
			read_json('packages/svelte/package.json')
		]);

		expect(workspace.private).toBe(true);
		expect(workspace.workspaces).toEqual(['packages/*']);
		expect(core.name).toBe('@itznotabug/emage-core');
		expect(svelte.name).toBe('@itznotabug/emage-svelte');
		expect(core.version).toBe(svelte.version);
		expect(svelte.dependencies['@itznotabug/emage-core']).toBe(core.version);
	});

	it('keeps framework code and dependencies out of core', async () => {
		const manifest = await read_json('packages/core/package.json');
		const source = await source_text('packages/core/src');
		const dependencies = {
			...manifest.dependencies,
			...manifest.peerDependencies,
			...manifest.optionalDependencies
		};
		const names = Object.keys(dependencies);

		expect(names.some((name) => /^(?:svelte|@sveltejs\/|vue|@vue\/)/.test(name))).toBe(false);
		expect(source).not.toMatch(/from\s+['"](?:svelte|svelte\/|@sveltejs\/|vue|@vue\/)/);
		expect(source).not.toMatch(/\b(?:svelte|ConstTag|EachBlock)\b/i);
	});

	it('makes the Svelte adapter consume only the public core entry', async () => {
		const source = await source_text('packages/svelte/src');
		expect(source).toContain("from '@itznotabug/emage-core'");
		expect(source).not.toMatch(/packages\/core\/src|@itznotabug\/emage-core\//);
		expect(source).not.toMatch(/from\s+['"](?:vue|@vue\/)/);
	});

	it('loads both workspace package exports', async () => {
		const [core, svelte] = await Promise.all([
			import('@itznotabug/emage-core'),
			import('@itznotabug/emage-svelte')
		]);

		expect(core.create_image_plugins).toBeTypeOf('function');
		expect(core.create_dynamic_virtual_modules).toBeTypeOf('function');
		expect(svelte.enhancedImages).toBeTypeOf('function');
	});
});

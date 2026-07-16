import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspace_root = find_workspace_root(path.dirname(fileURLToPath(import.meta.url)));

/** @param {string} start */
function find_workspace_root(start) {
	let directory = start;
	while (true) {
		const manifest_path = path.join(directory, 'package.json');
		if (existsSync(manifest_path)) {
			const manifest = JSON.parse(readFileSync(manifest_path, 'utf8'));
			if (
				manifest.private === true &&
				Array.isArray(manifest.workspaces) &&
				manifest.workspaces.includes('packages/*')
			) {
				return directory;
			}
		}

		const parent = path.dirname(directory);
		if (parent === directory) throw new Error('Could not locate the Emage workspace root');
		directory = parent;
	}
}

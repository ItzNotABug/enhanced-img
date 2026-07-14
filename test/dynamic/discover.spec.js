import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discover_candidates } from '../../src/dynamic/discover.js';
import { normalize_options } from '../../src/options.js';

const temporary_directories = [];

afterEach(async () => {
	await Promise.all(
		temporary_directories
			.splice(0)
			.map((directory) => fs.rm(directory, { recursive: true, force: true }))
	);
});

describe('candidate discovery', () => {
	it('discovers only selected rasters with deterministic root/public keys', async () => {
		const root = await temporary_directory();
		await write(root, 'src/z.PNG');
		await write(root, 'src/a.jpg');
		await write(root, 'src/skip.svg');
		await write(root, 'src/draft.jpg');
		await write(root, 'public/images/public.webp');

		const registry = await discover_candidates(
			normalize_options({
				dynamic: ['src/**/*', 'public/images/**/*', '!src/draft.jpg']
			}),
			{ root, publicDir: path.join(root, 'public') }
		);

		expect(registry.candidates.map(({ key }) => key)).toEqual([
			'/images/public.webp',
			'/src/a.jpg',
			'/src/z.PNG'
		]);
		expect(registry.candidates.every(({ source }) => path.isAbsolute(source))).toBe(true);
		expect([...registry.byKey]).toHaveLength(3);
	});

	it('rejects publicDir stripping collisions', async () => {
		const root = await temporary_directory();
		await write(root, 'images/a.jpg');
		await write(root, 'public/images/a.jpg');

		await expect(
			discover_candidates(normalize_options({ dynamic: ['images/*.jpg', 'public/images/*.jpg'] }), {
				root,
				publicDir: path.join(root, 'public')
			})
		).rejects.toThrow(/collision.*images\/a\.jpg/i);
	});

	it('rejects percent-decoding collisions', async () => {
		const root = await temporary_directory();
		await write(root, 'src/a.jpg');
		await write(root, 'src/%61.jpg');

		await expect(
			discover_candidates(normalize_options({ dynamic: 'src/*.jpg' }), {
				root
			})
		).rejects.toThrow('collision');
	});

	it('rejects a symlink escaping Vite root', async () => {
		const root = await temporary_directory();
		const outside = await temporary_directory();
		await write(outside, 'secret.jpg');
		await fs.mkdir(path.join(root, 'src'), { recursive: true });
		await fs.symlink(path.join(outside, 'secret.jpg'), path.join(root, 'src', 'escape.jpg'));

		await expect(
			discover_candidates(normalize_options({ dynamic: 'src/*.jpg' }), {
				root
			})
		).rejects.toThrow(/outside the Vite root.*symlink/i);
	});

	it('rejects an escaping directory symlink before starting glob recursion', async () => {
		const root = await temporary_directory();
		const outside = await temporary_directory();
		await write(outside, 'nested/secret.jpg');
		await fs.mkdir(path.join(root, 'src'), { recursive: true });
		await fs.symlink(outside, path.join(root, 'src', 'outside'), 'dir');
		let glob_called = false;

		await expect(
			discover_candidates(
				normalize_options({ dynamic: 'src/**/*.jpg' }),
				{ root },
				{
					glob: async () => {
						glob_called = true;
						return [];
					}
				}
			)
		).rejects.toThrow(/outside the Vite root.*symlink/i);
		expect(glob_called).toBe(false);
	});

	it('rejects an exact file below an escaping symlinked ancestor before globbing', async () => {
		const root = await temporary_directory();
		const outside = await temporary_directory();
		await write(outside, 'nested/secret.jpg');
		await fs.mkdir(path.join(root, 'src'), { recursive: true });
		await fs.symlink(outside, path.join(root, 'src', 'outside'), 'dir');
		let glob_called = false;

		await expect(
			discover_candidates(
				normalize_options({
					dynamic: 'src/outside/nested/secret.jpg'
				}),
				{ root },
				{
					glob: async () => {
						glob_called = true;
						return [];
					}
				}
			)
		).rejects.toThrow(/outside the Vite root.*symlink/i);
		expect(glob_called).toBe(false);
	});
});

async function temporary_directory() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'enhanced-img-'));
	temporary_directories.push(directory);
	return directory;
}

async function write(root, relative) {
	const file = path.join(root, relative);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, 'not read by discovery');
}

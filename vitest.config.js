import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.spec.js'],
		exclude: ['test/apps/**']
	}
});

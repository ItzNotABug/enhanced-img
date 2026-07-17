import type { EnhancedImagesOptions } from '@itznotabug/emage-core';

export type { EnhancedImagesOptions } from '@itznotabug/emage-core';

// Structural on purpose: linked consumers may use another supported Vite version.
export function enhancedImages(options?: EnhancedImagesOptions): Array<{ name: string }>;

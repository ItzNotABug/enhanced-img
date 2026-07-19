declare module 'picomatch' {
	export interface PicomatchOptions {
		dot?: boolean;
		nocase?: boolean;
	}

	export type PicomatchMatcher = (input: string) => boolean;

	export default function picomatch(
		patterns: string | readonly string[],
		options?: PicomatchOptions
	): PicomatchMatcher;
}

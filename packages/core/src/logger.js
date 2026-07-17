import process from 'node:process';

const DIM_CYAN = '\x1b[2m\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/**
 * @param {string} label
 * @param {string} message
 * @param {'info' | 'success' | 'warning' | 'error'} [kind]
 * @param {boolean} [colors]
 */
export function format_emage_log(label, message, kind = 'info', colors = colors_enabled()) {
	const prefix = colors ? `${DIM_CYAN}[${label}]${RESET}` : `[${label}]`;
	const symbols = {
		info: '',
		success: colors ? `${GREEN}✓${RESET}` : '✓',
		warning: colors ? `${YELLOW}⚠${RESET}` : '⚠',
		error: colors ? `${RED}✖${RESET}` : '✖'
	};
	const symbol = symbols[kind];
	return `${prefix}${symbol ? ` ${symbol}` : ''} ${message}`;
}

function colors_enabled() {
	if (process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === '0') return false;
	return Boolean(process.stdout.isTTY || process.env.FORCE_COLOR);
}

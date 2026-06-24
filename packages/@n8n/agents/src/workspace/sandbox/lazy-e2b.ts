import type * as E2BSdk from 'e2b';

let _e2bMod: typeof E2BSdk | undefined;

export function loadE2B(): typeof E2BSdk {
	if (!_e2bMod) {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const mod = require('e2b') as typeof E2BSdk;
		_e2bMod = mod;
	}
	return _e2bMod;
}

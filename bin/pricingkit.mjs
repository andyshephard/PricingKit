#!/usr/bin/env node
// pricingkit CLI launcher. The CLI is TypeScript in src/cli; tsx compiles it
// on the fly with the repo's tsconfig (for the @/ path alias), so there is no
// build step. The repo's .ts files load as CommonJS, so both hooks are needed.
import { fileURLToPath } from 'node:url';
import { register as registerCjs } from 'tsx/cjs/api';
import { register as registerEsm } from 'tsx/esm/api';

const tsconfig = fileURLToPath(new URL('../tsconfig.json', import.meta.url));
// The CommonJS hook reads the tsconfig location from this variable
process.env.TSX_TSCONFIG_PATH = tsconfig;
registerCjs();
registerEsm({ tsconfig });

const { main } = await import(new URL('../src/cli/main.ts', import.meta.url).href);
process.exitCode = await main(process.argv.slice(2));

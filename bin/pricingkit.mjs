#!/usr/bin/env node
// pricingkit CLI launcher. The CLI is TypeScript in src/cli; tsx compiles it
// on the fly with the repo's tsconfig (for the @/ path alias), so there is no
// build step. The repo's .ts files load as CommonJS, so both hooks are needed.
import { fileURLToPath } from 'node:url';

// tsx's disk cache lives in a shared temporary folder (/tmp/tsx-<uid> on
// Linux) whose entries it trusts. On a multi-user machine or a shared CI
// runner, someone else who can write there could plant compiled code that
// this process would run with the store credentials in its environment.
// tsx reads this variable when its modules load, so it is set before they
// are imported (dynamically, below). Compiling without the cache costs a
// little start-up time.
process.env.TSX_DISABLE_CACHE = '1';

const { register: registerCjs } = await import('tsx/cjs/api');
const { register: registerEsm } = await import('tsx/esm/api');

const tsconfig = fileURLToPath(new URL('../tsconfig.json', import.meta.url));
// The CommonJS hook reads the tsconfig location from this variable
process.env.TSX_TSCONFIG_PATH = tsconfig;
registerCjs();
registerEsm({ tsconfig });

const { main } = await import(new URL('../src/cli/main.ts', import.meta.url).href);
process.exitCode = await main(process.argv.slice(2));

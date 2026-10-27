// PricingKit pricing core.
//
// Framework-free TypeScript: no Next.js or React imports and no network
// access (enforced by src/lib/pricing/__tests__/core-boundary.test.ts and an
// ESLint rule). Store I/O lives in the platform adapters (src/lib/adapters).

export * from './strategies';
export * from './rounding';
export * from './decimal';
export * from './snap';

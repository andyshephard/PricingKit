// PricingKit pricing core.
//
// Framework-free TypeScript: no Next.js or React imports and no network
// access (enforced by src/lib/pricing/__tests__/core-boundary.test.ts and an
// ESLint rule). Store I/O lives in the platform adapters (src/lib/adapters).

export * from './strategies';
export * from './rounding';
export * from './decimal';
export * from './snap';
export * from './concurrency';
export * from './model';
export * from './changeset';
export * from './diff';
export * from './inverse';
export * from './state';
export * from './adapter';
export * from './run';
export * from './executor';
export * from './offers';
export * from './offer-derivation';
export * from './offer-ops';
export * from './offer-plan';

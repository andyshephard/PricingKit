# Netflix Price Index Implementation Plan

## Goal

Add a Netflix Price Index pricing strategy for regional pricing. The strategy uses Netflix Standard ad-free subscription prices as a market-based affordability signal and must cover every App Store Connect territory supported by this project.

## Data Source

Use `tompec/netflix-prices` as the source dataset:

`https://github.com/tompec/netflix-prices`

Use the latest JSON snapshot:

`https://raw.githubusercontent.com/tompec/netflix-prices/main/data/latest.json`

The dataset is licensed under CC-BY-4.0. Any copied or transformed data must retain attribution:

`Source: tompec/netflix-prices, CC-BY-4.0, https://github.com/tompec/netflix-prices`

## Index Definition

Use the `standard` Netflix plan, not `standard_with_ads`.

For each country or territory:

```ts
netflixMultiplier = countryStandardUsd / usStandardUsd
```

The current source dataset reports `US.standard.price_usd = 19.99`, so the United States normalizes to `1.0`.

Example:

```ts
Brazil = 8.80 / 19.99 = 0.44
Switzerland = 28.93 / 19.99 = 1.45
```

Clamp multipliers to the same practical range used by the other indexes: `0.1` to `2.0`.

## Coverage Requirement

Use `getSupportedAppleTerritories()` from `src/lib/apple-connect/territories.ts` as the canonical territory set.

This excludes territories currently unsupported by the app's Apple IAP pricing path:

- `BGD` / `BD`: Bangladesh
- `MCO` / `MC`: Monaco
- `WSM` / `WS`: Samoa

The latest Netflix dataset covers all supported App Store Connect territories except:

- `CN` / `CHN`: China mainland
- `XK` / `XKS`: Kosovo
- `RU` / `RUS`: Russia

Add explicit inferred entries for those missing territories:

- `CN`: infer from `HK`
- `XK`: infer from `AL`
- `RU`: infer from `BY`

Direct source entries and inferred entries should be distinguishable in metadata.

## Data Module

Create `src/lib/conversion-indexes/netflix.ts`.

Recommended shape:

```ts
export interface NetflixPriceIndexEntry {
  multiplier: number;
  standardPriceUsd: number;
  source: 'tompec-netflix-prices' | 'inferred';
  inferredFrom?: string;
}

export const NETFLIX_PRICE_INDEX: Record<string, NetflixPriceIndexEntry> = {
  US: {
    multiplier: 1.0,
    standardPriceUsd: 19.99,
    source: 'tompec-netflix-prices',
  },
};
```

Export helpers mirroring `big-mac.ts`:

```ts
export const DEFAULT_NETFLIX_MULTIPLIER = 0.70;

export function getNetflixMultiplier(regionCode: string): number;

export function getAllNetflixData(): Record<
  string,
  { multiplier: number; source: 'tompec-netflix-prices' | 'inferred' | 'default'; inferredFrom?: string }
>;
```

Use alpha-2 region codes in `NETFLIX_PRICE_INDEX`. Existing pricing code already converts Apple alpha-3 territory codes to alpha-2 via `alpha3ToAlpha2()`.

## Pricing Engine Changes

Update `src/lib/google-play/currency.ts`:

- Import `getNetflixMultiplier`.
- Extend `PricingStrategy` with `'netflix'`.
- Extend `CalculatedPrice['multiplierSource']` with `'netflix'`.
- Calculate the Netflix strategy like Big Mac:

```ts
const netflixMultiplier = getNetflixMultiplier(alpha2Code);
const baseNetflixMultiplier = getNetflixMultiplier(alpha2BaseRegion);

effectiveMultiplier = netflixMultiplier / baseNetflixMultiplier;
calculatedPrice = baseUsdPrice * effectiveMultiplier * exchangeRate;
multiplierSource = 'netflix';
```

## API Changes

Update `src/app/api/ppp/route.ts`:

- Import `NETFLIX_PRICE_INDEX` and `DEFAULT_NETFLIX_MULTIPLIER`.
- Include `netflixMultiplier` in the merged data response alongside `bigMacMultiplier`.
- Include it in both static fallback response paths.

Update `DynamicPPPData` in `src/lib/google-play/currency.ts` to include:

```ts
netflixMultiplier?: number;
```

Then prefer dynamic API data when present:

```ts
const netflixMultiplier = dynamicEntry?.netflixMultiplier ?? getNetflixMultiplier(alpha2Code);
```

## UI Changes

Add a Netflix radio option wherever pricing strategies are selectable:

- `src/components/products/bulk-pricing-modal.tsx`
- `src/components/subscriptions/bulk-pricing-modal.tsx`
- `src/components/subscriptions/apple-subscription-bulk-pricing-modal.tsx`
- `src/app/index-checker/page.tsx`

Use copy similar to:

```text
Netflix Index
Prices based on Netflix Standard ad-free subscription prices by country.
Data: tompec/netflix-prices (CC-BY-4.0)
```

The strategy grid currently uses three columns in several modals. Adding Netflix makes four strategy options plus custom. Check responsive layout after adding the option.

## Tests

Add `src/lib/conversion-indexes/__tests__/netflix.test.ts`:

- `NETFLIX_PRICE_INDEX` has entries.
- Every key is ISO alpha-2.
- Every multiplier is finite and within `[0.1, 2.0]`.
- `getNetflixMultiplier()` returns direct values.
- Unknown regions return `DEFAULT_NETFLIX_MULTIPLIER`.
- Every `getSupportedAppleTerritories()` alpha-2 code exists in `NETFLIX_PRICE_INDEX`.
- `CN`, `XK`, and `RU` are marked `source: 'inferred'` and have `inferredFrom` set.

Update `src/lib/google-play/__tests__/currency.test.ts`:

- Add a `calculateRegionalPrice` test for the Netflix strategy.
- Verify the multiplier is normalized against the selected base region.
- Verify `multiplierSource` is `'netflix'`.

## Verification

Run:

```bash
npm run lint
```

If a test script exists in `package.json`, run the targeted tests or the full suite.

## Maintenance

The source repository updates `data/latest.json` over time. If the index is stored statically, add a short script or documented manual process to regenerate `src/lib/conversion-indexes/netflix.ts` from the latest snapshot.

The generated file should include the source snapshot date if available from the filename or commit used. Since `latest.json` is mutable, prefer pinning the generated data to a dated source file or source commit SHA in the file comment.

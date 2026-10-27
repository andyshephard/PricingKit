// When the static Apple price tier table (price-tier-data.json) was generated.
// Kept apart from the table so the pricing core can report its age without
// loading 400K lines of data. scripts/fetch-apple-price-tiers.ts updates it.

/** YYYY-MM-DD */
export const PRICE_TIER_DATA_GENERATED_AT = '2026-02-02';

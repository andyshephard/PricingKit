# Smart regional pricing

`Smart` is PricingKit's recommended default for digital apps. It is not meant
to be a claim that a static formula can discover the mathematically optimal
price. It is a better **prior** than raw PPP, Big Mac, Netflix, or FX-only
pricing until the app has enough first-party data to run market-level tests.

## Objective

For software with near-zero marginal cost per additional customer, optimize
**revenue / LTV per eligible user**, not conversion rate and not cost-plus
margin.

For a market `c` and tested price `p`, the long-run objective is approximately:

`RPU365(c, p) = paid_conversion(c, p) * realized_LTV365(c, p)`

Lower prices are good only when the resulting conversion/retention lift more
than offsets the lower price. There is no arbitrary cost floor in the model.

## Why not raw PPP?

World Bank PPP describes population-wide purchasing power. The people who own
an iPhone and pay for a subscription are usually a richer subset of the local
population, so raw PPP commonly discounts too much.

The `Smart` model compresses raw PPP with exponents below 1, then applies broad
regional floors/caps derived from current mobile-subscription benchmarks.

## Why not Netflix / Big Mac?

- Big Mac pricing reflects food, labor and real-estate costs that do not map to
  a digital app.
- Netflix has local content/licensing/value differences and very different
  retention/plan economics.
- A basket of relevant apps plus first-party experiments is a better signal
  than any single global brand.

## Current priors

The exact code lives in `src/lib/conversion-indexes/smart.ts`.

- Western Europe: heavily compressed PPP, ~0.85-1.08x.
- Developed APAC: ~0.80-0.95x.
- Emerging Asia: iOS floor ~0.45x; Google can go lower.
- Latin America: roughly reproduces the large-app BR/MX benchmark ranges.
- MEA: lower Google floor than App Store.
- Sparse markets: compressed PPP (`sqrt(PPP)` on iOS) with safety floors/caps.

Example iOS outputs from representative raw PPP values:

| Market | Raw PPP | Smart |
|---|---:|---:|
| Spain | 0.65x | ~0.85x |
| Sweden | 0.88x | ~0.95x |
| Norway | 0.99x | ~1.00x |
| Switzerland | 1.14x | ~1.05x |
| Taiwan | 0.60x | ~0.77x |
| India | 0.22x | ~0.45x |
| Brazil | 0.48x | ~0.56x |
| Mexico | 0.57x | ~0.64x |

## How to supersede Smart with real data

Once a country has enough traffic:

1. Randomize eligible users between the current price and +/- 15-25% price
   variants.
2. Do not choose a winner from conversion alone.
3. Compare revenue per eligible user and, for subscriptions, projected or
   realized 365-day LTV including trial activation, renewals, refunds and churn.
4. Keep markets/platforms separate where behavior differs materially.
5. Promote the winning country-specific multiplier to a custom override.

This is especially important for the largest markets because one locally wrong
price matters more than perfect pricing across dozens of low-volume storefronts.

## Research references

- RevenueCat, State of Subscription Apps 2026:
  https://www.revenuecat.com/state-of-subscription-apps
- RevenueCat, Ultimate guide to price localization:
  https://www.revenuecat.com/blog/growth/price-localization-for-apps
- Flo / Dmitry Gurski, regional pricing:
  https://subclub.com/episode/how-to-maximize-revenue-with-regional-pricing-dmitry-gurski-flo
- Jacob Rushfinn, global pricing guidance:
  https://www.retention.blog/p/global-pricing-guidance
- Apple, auto-renewable subscription pricing:
  https://developer.apple.com/app-store/subscriptions/

## Apple storefront baseline (V2)

For Apple, Smart pricing does **not** start from a raw foreign-exchange
conversion. PricingKit resolves the selected base price to an actual App Store
Connect price point and calls Apple's price-point `equalizations` endpoint.

The returned customer prices are Apple's comparable storefront prices and
already reflect Apple's localization machinery: exchange rates, certain taxes,
and local pricing conventions. Smart then applies its app-market multiplier to
that local baseline and snaps the result to a valid Apple price point.

Conceptually:

```text
selected Apple base price point
        ↓
Apple equalized storefront customer price
        ↓
Smart app-market multiplier
        ↓
nearest valid Apple price point
```

That means a displayed `0.95×` in Austria is approximately 5% below Apple's
equalized Austrian baseline; it is no longer 5% below a raw USD→EUR conversion.

If Apple's equalizations cannot be loaded, the Apple Smart preview is paused
rather than silently falling back to the old raw-FX behavior. Google Play keeps
the existing Smart calculation path.

Smart remains a starting prior, not a proof of the revenue-maximizing price.
Country/platform RPU or LTV experiments should supersede the prior once enough
first-party data exists.

## V3 revenue-tuned calibration

V3 keeps the V2 Apple equalized-storefront baseline and changes only the
no-first-party-data prior.

The main calibration changes are:

- Western Europe is kept closer to North American pricing (roughly 0.90–1.00x
  for most markets rather than allowing an 0.85x floor).
- Japan and South Korea move upward into a roughly 0.85–0.95x band.
- Singapore and Hong Kong move upward into a roughly 0.90–1.00x band.
- UAE, Qatar, Kuwait, Bahrain, Saudi Arabia, and Oman are removed from the
  generic MEA curve and receive a dedicated high-income Gulf prior.
- Emerging Asia, Latin America, and genuinely lower-income MEA markets retain
  the V2 behavior.

The purpose is not to maximize conversion rate. The prior is intentionally
biased toward maximizing revenue / payer LTV for digital apps with negligible
marginal cost. It should still be replaced by country/platform RPU or LTV
experiments as soon as first-party data is statistically useful.

## V4 consumer-price equalization guardrail

V4 changes the role of Apple's equalized storefront prices.

V2/V3 treated Apple's equalized customer price as the complete local baseline:

```text
Apple equalized customer price
        ×
Smart willingness-to-pay factor
```

That is useful for keeping developer proceeds comparable, but it can overstate
the price a customer should see when Apple's equalization matrix is materially
above the current FX + tax equivalent.

V4 instead targets the customer-facing price:

```text
US/base customer price
        ↓
current FX conversion
        ↓
Smart app-market willingness-to-pay factor
        ↓
bounded Apple tax/local-convention uplift (max 1.25x)
        ↓
nearest valid Apple price point
```

Apple equalization is therefore still used, but only as a signal for taxes and
local pricing conventions. The uplift is measured as:

```text
Apple equalized local price / raw-FX local price
```

and capped at `1.25x`.

Example with a $4.99 US base and EUR/USD around 0.86:

```text
raw FX:                     about €4.29
Apple equalized baseline:        €5.99
equalization uplift:             ~1.40x
V4 bounded uplift:                1.25x
AT Smart WTP factor:             ~0.96x
consumer target:            ~€5.15
```

The exact final value is then snapped to an available Apple price point.

Why this is closer to the intended objective:

- Apple says its automatic equalization is driven by FX, certain taxes and
  local pricing conventions and is designed to keep global earnings consistent.
- Revenue-oriented app pricing should instead optimize the customer-facing
  price / RPU / LTV.
- Large app publishers do not use one universal rule: observed video-app
  pricing ranges from same-numeric USD/EUR pricing to Apple's higher equalized
  EUR tiers, and companies such as Mojo explicitly A/B test local prices.
- The 1.25x cap is a guardrail, not a claimed universal optimum. It roughly
  accommodates high VAT/GST storefronts while stopping the equalization matrix
  from overwhelming the willingness-to-pay model.

The next upgrade after V4 should be first-party price experimentation. Once a
country/platform has enough volume, measured RPU/LTV should replace the prior.

## V4.1 final revenue prior

V4.1 is the production candidate before first-party price experiments.

Changes from V4:

- Apple customer tax is inferred from App Store Connect price-point proceeds
  (`customerPrice`, `proceeds`, `proceedsYear2`) instead of using the hard
  1.25x equalization cap as the primary path.
- A persistent App Store Small Business Program toggle switches proceeds
  estimation to the 85% developer share from day one.
- Afghanistan and other sparse low-income markets no longer inherit the
  accidental `sqrt(0.50) ~= 0.71` missing-data behavior.
- Taiwan, Macao and Brunei receive a secondary high-income Asia prior below
  Singapore/Hong Kong.
- Central/Eastern Europe and high-income LATAM receive audited iOS priors.
- Pacific island outliers such as Vanuatu, Solomon Islands and Micronesia are
  prevented from inheriting implausibly high app-WTP from local price levels.
- Bulgaria uses EUR for Apple's storefront.
- Open Exchange Rates remains primary when configured; otherwise Frankfurter
  v2 provides no-key live USD exchange rates.

The customer-price path is:

```text
base customer price
  -> live FX
  -> app-market / iOS willingness-to-pay prior
  -> Apple-derived local tax factor
  -> nearest valid Apple price point
```

This is a no-first-party-data prior, not a mathematical proof of the revenue
optimum. Once enough traffic exists, country/platform revenue-per-install and
LTV experiments should replace the prior.

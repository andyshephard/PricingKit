import Link from 'next/link';
import { Callout, CodeBlock, DocLink, DocTable } from '@/components/docs/doc-blocks';
import type { DocPage } from '../types';

export const pricingStrategies: DocPage = {
  slug: 'pricing-strategies',
  title: 'Pricing strategies',
  description:
    'A strategy turns one base price into a price for every country. PricingKit then snaps each result to a real store price point.',
  sections: [
    {
      id: 'choosing-a-strategy',
      title: 'Choosing a strategy',
      body: (
        <>
          <DocTable
            caption="Pricing strategies"
            head={['Strategy', 'Uses', 'Data']}
            rows={[
              ['PPP', 'World Bank purchasing power parity (PPP conversion factor over the market exchange rate)', 'Static snapshot synced 2026-02-01 (2024 data assumed); the web app can also use live World Bank data'],
              ['Big Mac', "The Economist's Big Mac index", '2025 (month not recorded)'],
              ['Netflix', "Netflix's standard plan price in each country", 'Snapshot of 2026-04-09'],
              ['Direct', 'Exchange rates only: the same price everywhere, converted', 'Live rates with an Open Exchange Rates key, otherwise fallback rates of 2026-02-01'],
              ['Custom', 'Your own multiplier per country, from a table or a CSV', 'Yours'],
            ]}
          />
          <p>
            Each territory is priced in the currency it uses now: the base price is converted to that currency and multiplied by the territory&apos;s
            factor relative to the base territory (not to the US directly). Index factors are clamped to 0.1–2.0, live World Bank PPP included.
          </p>
          <p>
            A territory whose currency has no exchange rate is never priced as if one unit were one US dollar: it is shown as &quot;No exchange
            rate&quot;, can&apos;t be selected and is never applied.
          </p>
          <p>
            Compare the strategies for any base price on the public <Link href="/index-checker">index checker</Link>.
          </p>
        </>
      ),
    },
    {
      id: 'in-the-web-app',
      title: 'In the web app',
      body: (
        <p>
          The bulk pricing dialogs (App Store subscriptions, Google Play base plans, and in-app purchases on both stores) take a strategy, a base
          territory and a base price, preview every country, and show the changes for review before anything is applied. App Store subscriptions
          remember their own base territory; in-app purchase bulk pricing starts from the product&apos;s own price schedule base territory.
        </p>
      ),
    },
    {
      id: 'in-a-spec-file',
      title: 'In a spec file',
      body: (
        <>
          <p>
            On the command line, a <code>strategy</code> target in a <DocLink to="spec-and-rules-files">pricing spec</DocLink> spreads one base price
            the same way:
          </p>
          <CodeBlock
            example
            lang="json"
            code={`{
  "type": "strategy",
  "strategy": "ppp",
  "base": { "territory": "US", "amount": "9.99" },
  "rounding": "nearest-99"
}`}
          />
          <ul>
            <li>
              <code>strategy</code>: <code>ppp</code>, <code>bigmac</code>, <code>netflix</code>, <code>direct</code> or <code>custom</code>.
            </li>
            <li>
              <code>base.territory</code> may be left out when the product gives its own <code>baseTerritory</code>. The base territory is per product:
              there is no app-wide default. <code>base.currency</code> defaults to the base territory&apos;s current currency.
            </li>
            <li>
              <code>rounding</code>: <code>none</code> (the App Store default: snapping picks the price point), <code>nearest-99</code> (the Google Play
              default) or <code>round-up</code>.
            </li>
            <li>
              <code>territories</code> defaults to every priced territory. A territory with no price yet, or no exchange rate, is skipped with the
              reason.
            </li>
            <li>
              The built-in indexes and fallback exchange rates make a plan reproducible offline. <code>exchangeRates</code> (units per US dollar, for
              example <code>{'{ "EUR": "0.92" }'}</code>) overrides rates, and <code>exchangeRatesAsOf</code> dates them.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: 'custom-multipliers',
      title: 'Custom multipliers',
      body: (
        <>
          <p>
            The <code>custom</code> strategy prices each territory as the base price converted to its currency, times{' '}
            <code>multipliers[territory] / multipliers[base territory]</code> (the base territory&apos;s own defaults to 1). Multipliers must be between
            0.01 and 10.
          </p>
          <CodeBlock
            example
            lang="json"
            code={`{ "type": "strategy", "strategy": "custom", "base": { "territory": "US", "amount": "9.99" },
  "multipliers": { "GB": "0.95", "IN": "0.35", "BR": "0.5" } }`}
          />
          <ul>
            <li>
              Without <code>territories</code> it prices the territories in its table. With <code>&quot;all&quot;</code> or a list, territories without
              a multiplier are skipped, never priced at 1.0.
            </li>
            <li>
              <code>&quot;multipliersFile&quot;: &quot;multipliers.csv&quot;</code> reads the table from a CSV next to the spec (inside the working
              directory) with <code>territory</code> and <code>multiplier</code> columns, so a price export with a <code>multiplier</code> column added
              works. Rows with an empty multiplier are skipped.
            </li>
            <li>
              The web app&apos;s bulk pricing dialogs take the same table: one <code>GB=0.9</code> per line, or the CSV.
            </li>
          </ul>
        </>
      ),
    },
  ],
};

export const plans: DocPage = {
  slug: 'plans',
  title: 'Plans, confirm and undo',
  description:
    'Price changes become files you can review and commit. Applying one is confirmed with its hash, checks every price first, and keeps a log you can resume or undo.',
  sections: [
    {
      id: 'the-files',
      title: 'The files',
      body: (
        <DocTable
          caption="Plan files"
          head={['File', <code key="k">kind</code>, 'What it holds']}
          rows={[
            [
              'Plan',
              <code key="k">pricingkit.changeset</code>,
              <>
                Every change a run will make. Each op names a product and territory, the price it expects to find (<code>before</code>), the price it
                sets (<code>after</code>) and an idempotency key. Amounts are decimal strings, never floats.
              </>,
            ],
            [
              'Run log',
              <code key="k">pricingkit.applyRun</code>,
              <>
                Per-op status (<code>pending</code>, <code>ok</code>, <code>skipped</code>, <code>failed</code>), attempts, the store&apos;s response
                and the price observed before writing.
              </>,
            ],
            ['State', <code key="k">pricingkit.state</code>, 'Current prices of one or more products. Price exports import as state.'],
          ]}
        />
      ),
    },
    {
      id: 'how-a-plan-is-applied',
      title: 'How a plan is applied',
      body: (
        <ul>
          <li>
            <strong>Confirmed.</strong> A plan applies only with its hash: the first 32 hex digits of a SHA-256 hash of its app and ops, whatever its
            schema version. <code>pricingkit plan</code> and <code>pricingkit diff</code> print it; <code>pricingkit apply --confirm</code> must match
            it, checked before anything is read.
          </li>
          <li>
            <strong>Idempotent.</strong> Before writing, PricingKit reads each product and compares every territory with its op: one already at{' '}
            <code>after</code> is skipped, one at <code>before</code> is applied, anything else fails with <code>STATE_CHANGED</code> and nothing is
            sent. Applying a plan twice changes nothing the second time.
          </li>
          <li>
            <strong>Resumable.</strong> The run log is saved before every write (marking the op as attempted) and after it, so a log saved before a
            crash still shows a write that was in flight. Resuming retries only pending or failed ops; an attempted op found at its target counts as
            done. If the log can&apos;t be saved, the run stops before writing anything else.
          </li>
          <li>
            <strong>Budgeted.</strong> Every request counts against a request budget (Apple&apos;s rate-limit header feeds it too). An op starts only
            if the budget covers all its requests; otherwise the run stops and leaves the rest pending.
          </li>
          <li>
            <strong>Never guesses.</strong> If a territory&apos;s price can&apos;t be read unambiguously (for example two future App Store prices), the
            planner skips it and the executor refuses ops on it.
          </li>
          <li>
            <strong>Safe with scheduled prices.</strong> An App Store scheduled price is deleted only after its replacement exists.
          </li>
        </ul>
      ),
    },
    {
      id: 'undo',
      title: 'Undo',
      body: (
        <>
          <p>
            <code>pricingkit undo &lt;plan.json&gt; &lt;run.json&gt;</code> writes the plan that reverses a run, newest first, from the{' '}
            <code>before</code> prices. It is itself a plan to review and apply. It runs offline and lists what can&apos;t be reversed: the App Store
            can&apos;t remove a territory&apos;s current price, so an op that added one is not reversible; redeemed offer codes stay redeemed.
          </p>
          <p>
            Undo also reverts ops that failed after being sent, since a store write that answered with an error may have taken effect; if it
            didn&apos;t, applying the revert skips it as already at target.
          </p>
        </>
      ),
    },
    {
      id: 'in-the-web-app',
      title: 'In the web app',
      body: (
        <>
          <p>
            Every bulk change ends in a review step: the number of decreases, increases and new prices, every country before and after with the
            percentage, notes about existing subscribers, and Download plan (a CSV of the changes, or the plan JSON for offers). Nothing is written
            until you apply.
          </p>
          <p>
            Google Play bulk updates are two requests: a preview (<code>dryRun: true</code>) that writes nothing, then the update carrying the
            previewed prices (<code>expectedPrices</code>). A region whose price changed in between is left alone and reported, and the write
            re-checks the previewed prices against a fresh read just before sending (<code>PRICE_CHANGED</code>). &quot;Set fixed price&quot; names its
            currency and changes only regions billed in it: it is never converted. Items selected twice, or a subscription and one of its base plans,
            write each base plan once, and the results list what was left out.
          </p>
          <p>
            The web app keeps nothing server-side and can&apos;t resume or undo a run. The offer dialog offers its plan and run log for download so the
            command line can; for everything else, use plans and the command line when you need resume and undo.
          </p>
        </>
      ),
    },
    {
      id: 'base-prices-from-the-cli',
      title: 'Base prices from the CLI',
      body: (
        <>
          <p>
            <code>pricingkit apply --allow-base-prices</code> applies plans that change base prices: from a <code>pricingkit.spec</code>, a combined{' '}
            <code>plan --spec --rules</code>, or the undo plan of such a run. Without the flag, a plan with base-price ops is refused before any store
            request. The same safety applies as for offers: the hash, the run log, <code>--resume</code>, <code>undo</code>, the product checked
            against the plan&apos;s app, and the <code>PRICINGKIT_EXPECT_*</code> pins.
          </p>
          <Callout tone="warn" title="Try it on a test app before relying on it for the App Store.">
            Two App Store Connect behaviours it relies on are not yet confirmed against a real account: that an immediate price change replaces the
            territory&apos;s older price entries, and that a second scheduled price can be created before the old one is deleted. The executor re-reads
            every territory before writing and refuses anything ambiguous, so the failure mode is a refused or unverified op, not a silent wrong price;
            but run a small plan on a test app first. Google Play base plans and one-time products don&apos;t have this caveat.
          </Callout>
        </>
      ),
    },
    {
      id: 'library',
      title: 'As a library',
      body: (
        <>
          <p>
            <code>src/lib/pricing</code> is a framework-free TypeScript core (no Next.js or React; a test checks the whole import graph) shared by the
            web app and the command line:
          </p>
          <CodeBlock
            example
            lang="ts"
            code={`import { buildChangeSet, applyChangeSet, buildUndoChangeSet, serializeChangeSet } from '@/lib/pricing';
import { AppleAdapter } from '@/lib/adapters';
import { RequestBudget } from '@/lib/utils/request-budget';

const budget = new RequestBudget();                       // 3600 requests/hour by default
const apple = new AppleAdapter({ credentials, budget });
const product = { platform: 'apple', type: 'subscription', id: '1234567890' } as const;

const state = await apple.fetchState(product);
const { resolved } = await apple.resolvePricePoints(product, {
  GB: { currency: 'GBP', amount: '26.10' },               // snapped to a live price point
});
const plan = buildChangeSet({ app: { bundleId: 'com.example.app' }, products: [{ state, targets: resolved }] });
await writeFile('plan.json', serializeChangeSet(plan));   // review, commit

const run = await applyChangeSet(plan, { adapter: apple, budget, onUpdate: saveRunLog });
const undo = buildUndoChangeSet(plan, run);               // itself a plan to review and apply`}
          />
        </>
      ),
    },
  ],
};

export const existingSubscribers: DocPage = {
  slug: 'existing-subscribers',
  title: 'Existing subscribers',
  description:
    'Every base-price change in a plan is classified per territory by what existing subscribers see: a lower price, nothing, a notice, or a request for consent.',
  sections: [
    {
      id: 'classes',
      title: 'Classes',
      body: (
        <>
          <DocTable
            caption="Existing-subscriber classes"
            head={['Class', 'Meaning']}
            rows={[
              [<code key="k">decrease</code>, 'App Store: existing subscribers renew at the lower price. Google Play: new purchases only (see below).'],
              [
                <code key="k">increase-to-new-subscribers-only</code>,
                <>
                  App Store with <code>preserveCurrentPrice</code> (the default), or any Google Play base plan change.
                </>,
              ],
              [<code key="k">increase-within-no-consent-threshold</code>, 'App Store: subscribers are notified; no consent needed.'],
              [<code key="k">increase-needs-consent</code>, 'App Store: subscribers must agree before renewal, or the subscription expires.'],
              [
                <>
                  <code>new-price</code> / <code>unchanged</code>
                </>,
                'No current price / the same amount.',
              ],
            ]}
          />
          <p>
            <code>pricingkit diff</code> shows the class in an &quot;Existing subscribers&quot; column, and the web app&apos;s App Store subscription
            preview shows the same.
          </p>
        </>
      ),
    },
    {
      id: 'app-store-rules',
      title: 'App Store rules',
      body: (
        <>
          <p>
            Consent is needed if the storefront always requires it (Austria, Germany, Poland, Republic of Korea), or the subscriber had an increase in
            the last 12 months, or the increase is both more than 50% and above the storefront&apos;s threshold (for example US$5 per period, or US$50 a
            year for annual subscriptions; local amounts per storefront come from Apple&apos;s table, transcribed on 2026-10-27).
          </p>
          <ul>
            <li>
              PricingKit can&apos;t read the price history. Give <code>{'"consent": { "lastIncreaseAt": "2026-03-01" }'}</code> (or per territory);
              otherwise no recent increase is assumed and the plan says so. A date PricingKit can&apos;t use (it must be a real day), or one after the
              change takes effect, counts as needing consent.
            </li>
            <li>
              Give <code>&quot;billingPeriod&quot;: &quot;P1Y&quot;</code> for annual subscriptions; otherwise the lower non-annual threshold is used.
            </li>
            <li>
              An op with <code>preserveCurrentPrice: false</code> moves existing subscribers to the new price. <code>diff</code> always marks it MOVES
              EXISTING SUBSCRIBERS and warns at the top. The undo plan of such a decrease raises the price back for new subscribers only, with a warning,
              rather than raising existing subscribers&apos; price.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: 'google-play-rules',
      title: 'Google Play rules',
      body: (
        <p>
          A base plan price change applies to new purchases. Existing subscribers stay on their price in a legacy cohort until it is migrated, and
          PricingKit doesn&apos;t migrate cohorts. <code>ifMigrated</code> says what a migration would need: decreases need no approval; an increase can
          be an opt-out (notice only) increase if it is at most the greater of 50% and 17 US cents a day, at most once a year, in a country that allows
          it (not checked); otherwise subscribers must opt in.
        </p>
      ),
    },
    {
      id: 'refusing-a-plan',
      title: 'Refusing a plan that needs consent',
      body: (
        <>
          <p>
            <code>{'"consent": { "maxIncreaseWithoutConsent": true }'}</code> on a spec product refuses the whole plan (<code>CONSENT_REQUIRED</code>,
            nothing written) if any territory would need consent.
          </p>
          <Callout title="These are planner notes.">
            The classes stored in a plan are not covered by its hash, so anyone can edit them without changing the hash you confirm.{' '}
            <code>pricingkit diff</code> recomputes the class of every immediate subscription price change from the op itself (before, after,{' '}
            <code>preserveCurrentPrice</code>), shows that value and prints a WARNING where a stored note disagrees. Scheduled changes show the stored
            class marked &quot;(unverified)&quot;. Sources and what isn&apos;t encoded are listed in <code>src/lib/pricing/price-increase.ts</code>.
          </Callout>
        </>
      ),
    },
  ],
};

export const pricingByProceeds: DocPage = {
  slug: 'pricing-by-proceeds',
  title: 'Pricing by proceeds',
  description:
    'Target what you receive, net of tax and the store’s commission, instead of the price the customer pays.',
  sections: [
    {
      id: 'proceeds-targets',
      title: 'Proceeds targets',
      body: (
        <>
          <p>
            On a spec product, <code>&quot;measure&quot;: &quot;proceeds&quot;</code> makes <code>fixed</code> and <code>strategy</code> targets mean
            your proceeds. <code>percentOfCurrent</code> keeps meaning the customer price.
          </p>
          <CodeBlock
            example
            lang="json"
            code={`{ "product": { "platform": "google", "type": "subscription", "productId": "pro", "basePlanId": "annual" },
  "targets": { "type": "strategy", "strategy": "ppp", "base": { "territory": "US", "amount": "25.00" } },
  "measure": "proceeds", "commission": "0.15" }`}
          />
        </>
      ),
    },
    {
      id: 'app-store',
      title: 'App Store',
      body: (
        <>
          <p>
            Each territory snaps to the price point whose <code>proceeds</code>, as App Store Connect reports it for the subscription&apos;s price
            points, is nearest the target; <code>snap</code> applies to proceeds.
          </p>
          <Callout tone="warn" title="Unconfirmed.">
            That figure is Apple&apos;s per-price-point proceeds, which may not reflect your rate. It may not include the App Small Business
            Program&apos;s 15%, or the lower rate on a subscription&apos;s second year (price points also report <code>proceedsYear2</code>, which
            PricingKit doesn&apos;t use). Check a few territories against App Store Connect before relying on proceeds targets.
          </Callout>
        </>
      ),
    },
    {
      id: 'google-play',
      title: 'Google Play',
      body: (
        <p>
          Play reports tax but not its fee, so PricingKit asks Play&apos;s price conversion for <code>target / (1 - commission)</code> as the
          tax-exclusive price. <code>&quot;commission&quot;</code> defaults to <code>&quot;0.15&quot;</code> (Play&apos;s rate for subscriptions, and for
          the first US$1M a year of one-time products in the 15% tier); set <code>&quot;0.30&quot;</code> if that is your rate. Play proceeds are
          estimates: (price - tax) x (1 - commission).
        </p>
      ),
    },
    {
      id: 'in-the-plan',
      title: 'In the plan',
      body: (
        <p>
          Plans record per op the proceeds before and after (App Store) or the estimated proceeds and Play&apos;s tax (<code>priceChanges</code>), and{' '}
          <code>pricingkit diff</code> shows Proceeds and Tax columns. Like the existing-subscriber classes, these are planner notes not covered by the
          plan hash, and <code>diff</code> marks them as such. Only store-reported proceeds (App Store) go into the ops themselves.
        </p>
      ),
    },
  ],
};

export const referenceData: DocPage = {
  slug: 'reference-data',
  title: 'Reference data and freshness',
  description: 'Every built-in data set has a date. Plans and the web app show how old the data behind a price is, and warn when it is stale.',
  sections: [
    {
      id: 'built-in-data',
      title: 'Built-in data',
      body: (
        <DocTable
          caption="Built-in reference data"
          head={['Data', 'As of', 'Stale after (default)']}
          rows={[
            ['PPP snapshot (World Bank)', 'Synced 2026-02-01; 2024 data assumed (per-country years weren’t recorded)', '913 days'],
            ['Big Mac index', '2025 (month not recorded)', '400 days'],
            ['Netflix price index', '2026-04-09', '400 days'],
            ['Fallback exchange rates', '2026-02-01', '45 days'],
            ['Live exchange rates', 'When fetched', '7 days'],
            ['App Store price tier table (web previews)', '2026-02-02', '180 days'],
          ]}
        />
      ),
    },
    {
      id: 'in-plans',
      title: 'In plans',
      body: (
        <>
          <p>
            Plans record the data their strategy targets came from and its age (<code>dataFreshness</code>). <code>pricingkit diff</code> lists it, and
            stale data is a plan warning. Spec exchange rates can carry <code>exchangeRatesAsOf</code>.
          </p>
          <CodeBlock
            example
            lang="json"
            code={`"freshness": { "maxAgeDays": { "ppp": 900, "fallbackExchangeRates": 30 }, "refuseStale": true }`}
          />
          <p>
            A top-level <code>freshness</code> in the spec changes the limits, and <code>refuseStale</code> refuses a plan built on stale data. The web
            app shows the same as badges (index checker, bulk pricing dialogs), with the live exchange-rate timestamp.
          </p>
        </>
      ),
    },
    {
      id: 'stale-ppp-factors',
      title: 'Stale PPP factors',
      body: (
        <>
          <p>
            PPP conversion factors are annual and lag. For high-inflation currencies an old factor against today&apos;s exchange rate prices badly. With
            the <code>ppp</code> strategy:
          </p>
          <ul>
            <li>
              <code>{'"pppStaleness": { "mode": "cap", "maxAgeYears": 3 }'}</code> (the default) skips territories whose PPP data is older (
              <code>STALE_REFERENCE_DATA</code>).
            </li>
            <li>
              <code>&quot;mode&quot;: &quot;inflate&quot;</code> carries the factor forward with <code>cpi</code>: each territory&apos;s CPI now over
              its CPI in the data year (the base territory&apos;s is required), so the multiplier becomes multiplier x cpi[t] / cpi[base]. Territories
              without a ratio are skipped.
            </li>
          </ul>
          <p>
            The web app&apos;s <code>/api/ppp</code> applies the same policy per country with live World Bank years (
            <code>?pppStale=cap|inflate&amp;pppMaxAge=3</code>): capped countries use the static index, and inflate uses World Bank CPI (FP.CPI.TOTL)
            relative to the US.
          </p>
        </>
      ),
    },
    {
      id: 'apple-tier-table',
      title: 'App Store tier table',
      body: (
        <>
          <p>The web app&apos;s App Store previews use a static price tier table. Regenerate it from the live API (read-only), then review the diff:</p>
          <CodeBlock lang="bash" code={`npx --no-install tsx scripts/fetch-apple-price-tiers.ts --iap <in-app purchase ID>   # --dry-run to check without writing`} />
          <p>
            It needs App Store Connect credentials in the command line&apos;s <code>ASC_*</code> variables (see{' '}
            <DocLink to="cli-install">Install and credentials</DocLink>).
          </p>
        </>
      ),
    },
  ],
};

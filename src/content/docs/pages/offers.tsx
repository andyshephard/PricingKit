import { Callout, CodeBlock, DocLink, DocTable } from '@/components/docs/doc-blocks';
import type { DocPage } from '../types';

export const appleOffers: DocPage = {
  slug: 'apple-offers',
  title: 'Apple offers',
  description:
    'App Store subscription offers in plan files: introductory offers, promotional offers, offer codes and win-back offers, priced per territory from a rule.',
  sections: [
    {
      id: 'in-the-web-app',
      title: 'In the web app',
      body: (
        <>
          <p>
            An App Store subscription&apos;s page lists its offers (introductory, promotional, offer codes, win-back) with their terms and every
            territory&apos;s price, read from App Store Connect&apos;s relationships only: a price without a territory, price point or currency is shown
            as a problem, never guessed.
          </p>
          <p>The Offers card can do two things, both for promotional offers only:</p>
          <ul>
            <li>
              <strong>Create from rule:</strong> a new promotional offer priced at a percent of each territory&apos;s own current price (basis,
              snapping, duration, mode, offer code and name).
            </li>
            <li>
              <strong>Update prices to rule:</strong> re-price an existing promotional offer to such a rule. Its terms stay as they are.
            </li>
          </ul>
          <p>
            Both preview every territory first, then show the review step (every territory&apos;s offer price before and after, and what is left out).
            Apply sends the plan with its hash. The web flow keeps nothing and can&apos;t resume or undo, so download the plan (
            <code>&lt;plan&gt;.json</code>) and, after applying, the run log (<code>&lt;plan&gt;.run.json</code>). With them the command line can:
          </p>
          <ul>
            <li>
              resume an incomplete run: <code>pricingkit apply &lt;plan&gt;.json --confirm &lt;hash&gt; --resume &lt;plan&gt;.run.json</code>
            </li>
            <li>
              undo it: <code>pricingkit undo &lt;plan&gt;.json &lt;plan&gt;.run.json</code> writes <code>&lt;plan&gt;.undo.json</code>; review it, then{' '}
              <code>pricingkit apply &lt;plan&gt;.undo.json --confirm &lt;its hash&gt; --force-delete</code>
            </li>
          </ul>
          <p>Use the command line for every other offer kind.</p>
        </>
      ),
    },
    {
      id: 'offer-plan-specs',
      title: 'Offer plan specs',
      body: (
        <>
          <p>
            Offers use the same plan files as base prices. Plan them from an offer plan spec; several products go in one spec, each with its own key
            (Apple needs promotional offer codes to be unique across a subscription group):
          </p>
          <CodeBlock
            example
            lang="json"
            code={`{
  "kind": "pricingkit.offerPlanSpec", "schemaVersion": 1, "app": { "bundleId": "com.example.app" },
  "offers": [{
    "id": "example_annual_50", "name": "Half off a year", "kind": "apple.promo",
    "productRef": { "platform": "apple", "type": "subscription", "id": "1234567890" },
    "mode": "PAY_UP_FRONT", "duration": "P1Y", "territories": "all", "syncWithBase": true,
    "pricing": { "type": "percentOfCurrent", "percent": "50", "basis": "totalOverDuration", "snap": "nearest" }
  }]
}`}
          />
          <CodeBlock
            example
            lang="bash"
            code={`pricingkit plan --spec offers.json --out offers-plan.json
pricingkit diff offers-plan.json
pricingkit apply offers-plan.json --confirm <hash from diff>`}
          />
        </>
      ),
    },
    {
      id: 'pricing-from-a-rule',
      title: 'Pricing from a rule',
      body: (
        <ul>
          <li>
            Each territory&apos;s price is that territory&apos;s own current price times the rule, snapped to its own price points (ties go lower).
          </li>
          <li>
            <code>basis</code>: <code>perPeriod</code> (current price x percent) or <code>totalOverDuration</code> (the price over the offer&apos;s whole
            duration, for example a 1-year pay-up-front offer on a monthly plan is 12 x price x percent). Without a basis, pay-up-front offers use{' '}
            <code>totalOverDuration</code>. A pay-up-front promotional offer&apos;s price is the total for its whole duration.
          </li>
          <li>
            The preview flags a territory where the offer isn&apos;t below the current price, no price point fits, or snapping moves the price by more
            than 5%.
          </li>
        </ul>
      ),
    },
    {
      id: 'what-a-plan-can-do',
      title: 'What a plan can do',
      body: (
        <>
          <p>
            Offer ops: <code>createOffer</code>, <code>updateOfferPrices</code> (promotional offers), <code>deactivateOffer</code> /{' '}
            <code>activateOffer</code>, and <code>deleteOffer</code>. Each names the offer by its key (promotional offer code, offer code name, win-back
            offer ID) and carries the offer&apos;s terms and every territory&apos;s price before and after.
          </p>
          <ul>
            <li>Applying needs the plan&apos;s hash; nothing is read or sent otherwise.</li>
            <li>
              Offers are found by key, so a create that errored but took effect is recognised on resume and never sent twice. Introductory offers (one
              store resource per territory) resume territory by territory, and territories with an overlapping introductory offer are left out.
            </li>
            <li>
              The planner refuses what App Store Connect would refuse: an 11th promotional offer, changing an existing offer&apos;s duration, mode or
              periods, or re-pricing an offer code or win-back offer.
            </li>
            <li>
              Deleting an offer needs <code>--force-delete</code>: App Store Connect&apos;s API doesn&apos;t report redemptions. Offer codes can&apos;t be
              deleted at all; undo deactivates them, and codes already redeemed stay redeemed.
            </li>
            <li>
              <code>pricingkit offer deactivate|activate|delete</code> plans one lifecycle change of an existing offer (deactivating an introductory or
              win-back offer sets its end date, <code>--end-date</code>). See <DocLink to="cli-commands">Commands</DocLink>.
            </li>
          </ul>
          <Callout>
            Before reading or writing a subscription, PricingKit checks it belongs to the plan&apos;s app. App Store Connect API keys work across a
            team&apos;s apps, so a subscription ID copied from another app is refused with <code>APP_MISMATCH</code>.
          </Callout>
        </>
      ),
    },
    {
      id: 'known-gaps',
      title: 'Known gaps',
      body: (
        <p>
          Still to be checked against a test app: what the duration means for pay-as-you-go offers, the 10-promotional-offer limit, and free-trial and
          win-back price details on create. Confirmed with PricingKit&apos;s own writes on a test app: inline price IDs for promotional offer creates; a
          promotional offer price update replaces the whole price list; a create that answered a transient 500 having created nothing was created once
          on resume; and the confirm gate, idempotent re-apply, and undo of a re-price and of a create.
        </p>
      ),
    },
  ],
};

export const googlePlayOffers: DocPage = {
  slug: 'google-play-offers',
  title: 'Google Play offers',
  description:
    'A Play offer belongs to one base plan and is found by its offer ID. PricingKit lists, plans, applies, resumes and undoes them from the command line.',
  sections: [
    {
      id: 'what-an-offer-is',
      title: 'What an offer is',
      body: (
        <>
          <p>An offer has one or two phases, each priced per region with one of:</p>
          <ul>
            <li>
              Play&apos;s relative discount (<code>&quot;0.5&quot;</code> = 50% off), which follows the base price by itself;
            </li>
            <li>an absolute discount, a fixed price, or free.</li>
          </ul>
          <p>
            Its eligibility is a new-customer rule (&quot;never had any subscription in the app&quot; / &quot;never had this subscription&quot;), an
            upgrade rule, or none (developer-determined: the app decides who sees it). Tags (<code>offerTags</code>) are passed to the app by the billing
            library, for example for RevenueCat (<code>rc-customer-center</code>, <code>rc-ignore-offer</code>).
          </p>
          <p>The web app lists a subscription&apos;s Play offers on its page, read-only: state, eligibility, tags, phases and every region&apos;s price.</p>
        </>
      ),
    },
    {
      id: 'planning-offers',
      title: 'Planning offers',
      body: (
        <>
          <p>Use an offer plan spec for a <code>packageName</code> app. Eligibility is always spelled out: PricingKit never assumes one.</p>
          <CodeBlock
            example
            lang="json"
            code={`{
  "kind": "pricingkit.offerPlanSpec", "schemaVersion": 1, "app": { "packageName": "com.example.app" },
  "offers": [
    {
      "id": "annual-half-off", "kind": "play.offer",
      "productRef": { "platform": "google", "type": "subscription", "productId": "com.example.pro", "basePlanId": "annual" },
      "mode": "PAY_UP_FRONT", "duration": "P1Y", "territories": "all", "syncWithBase": false,
      "pricing": { "type": "play.relativeDiscount", "fraction": "0.5" },
      "eligibility": { "type": "play.targeting", "rule": { "type": "developerDetermined" } },
      "tags": ["rc-customer-center", "rc-ignore-offer"]
    },
    {
      "id": "new-customer-trial", "kind": "play.offer",
      "productRef": { "platform": "google", "type": "subscription", "productId": "com.example.pro", "basePlanId": "annual" },
      "mode": "FREE_TRIAL", "duration": "P1W", "territories": "all", "syncWithBase": false,
      "pricing": { "type": "free" },
      "eligibility": { "type": "play.targeting", "rule": { "type": "acquisition", "scope": "anySubscriptionInApp" } }
    }
  ]
}`}
          />
          <CodeBlock
            example
            lang="bash"
            code={`export GOOGLE_APPLICATION_CREDENTIALS=~/keys/service-account.json
pricingkit offers --package-name com.example.app --subscription com.example.pro [--base-plan annual]
pricingkit plan --spec play-offers.json --out play-plan.json
pricingkit apply play-plan.json --confirm <hash>`}
          />
        </>
      ),
    },
    {
      id: 'spec-fields',
      title: 'Spec fields',
      body: (
        <ul>
          <li>
            <strong>One phase per spec offer.</strong> <code>PAY_UP_FRONT</code> is one recurrence of <code>duration</code>,{' '}
            <code>PAY_AS_YOU_GO</code> is <code>periods</code> recurrences, <code>FREE_TRIAL</code> is free. Existing two-phase offers are read, listed
            and kept in step, but a spec creates single-phase offers only.
          </li>
          <li>
            <strong>Pricing:</strong> <code>play.relativeDiscount</code>, <code>play.absoluteDiscount</code> (<code>amounts</code> per region, in its
            currency), <code>fixed</code> (<code>prices</code> per region) or <code>percentOfCurrent</code> (each region&apos;s own base price times the
            percent, prorated over the phase, made a valid price by Play&apos;s own price conversion and written as a fixed price). <code>snap</code>{' '}
            doesn&apos;t apply on Play.
          </li>
          <li>
            <strong>Eligibility:</strong> <code>{'{ "type": "developerDetermined" }'}</code>,{' '}
            <code>{'{ "type": "acquisition", "scope": "anySubscriptionInApp" | "thisSubscription" }'}</code> or{' '}
            <code>{'{ "type": "upgrade", "scope": "thisSubscription" | { "specificSubscriptionInApp": "<product id>" }, "billingPeriodDuration"?, "oncePerUser"? }'}</code>.
          </li>
          <li>
            <strong>Regions:</strong> <code>&quot;all&quot;</code> is every region of the base plan. The offer is open to new subscribers where the base
            plan is, and not in locations Play launches later.
          </li>
          <li>
            <strong>State:</strong> a created offer is activated (<code>{'"play": { "state": "DRAFT" }'}</code> leaves it a draft). A planned offer
            that already matches and is a draft or inactive is activated.
          </li>
        </ul>
      ),
    },
    {
      id: 'changes-and-checks',
      title: 'Changes and checks',
      body: (
        <ul>
          <li>
            An existing offer is patched (prices, eligibility, tags); regions the spec leaves out keep their price. Changing its phase durations or
            recurrences is refused: create a new offer ID.
          </li>
          <li>
            The preview and <code>pricingkit diff</code> show state, eligibility and tags before and after, and the plan warns by name (&quot;removes
            tag rc-ignore-offer&quot;). A spec that leaves out a tag the offer has is refused (<code>TAG_REMOVAL</code>) unless it sets{' '}
            <code>{'"play": { "allowTagRemoval": true }'}</code>.
          </li>
          <li>
            Relative discounts are the share taken off, as the Android Publisher reference describes them. Until that is confirmed on a test app, the
            plan warns for any fraction other than 0.5.
          </li>
          <li>
            Percent-of-current regions where Play&apos;s price is further from the target than <code>play.deviationThreshold</code> (default{' '}
            <code>&quot;0.05&quot;</code>) are left out, and <code>pricingkit plan</code> exits 1. Fixed prices and amounts off may not have more
            decimals than the region&apos;s currency.
          </li>
          <li>
            Anything Play returns that PricingKit can&apos;t hold exactly (an unknown field, a region priced two ways, a phase that misses a region) is
            shown as a problem, and such an offer is never written to.
          </li>
        </ul>
      ),
    },
    {
      id: 'applying-and-undo',
      title: 'Applying and undo',
      body: (
        <>
          <ul>
            <li>
              The same safety as App Store offers: the plan&apos;s hash, offers found by offer ID so a create that took effect is never sent twice,
              resume, undo, and every request within the budget.
            </li>
            <li>
              Creates and activations are retried on 429 only, never after a 5xx or a timeout; a failed create counts as &quot;may have applied&quot;
              and the next read or a resume decides. One whose activation failed resumes with the activation alone.
            </li>
            <li>
              Undo deactivates a created (active) offer, never deletes it (Play deletes drafts only); deletes a draft the run created but couldn&apos;t
              activate; reverses patches; and lists an activation that got no answer as not reversible.
            </li>
            <li>
              Deleting a draft offer needs <code>--force-delete</code>: it is irreversible. A plan for another package is refused with{' '}
              <code>APP_MISMATCH</code> before anything is read, and every base plan is checked to be one of the app&apos;s.
            </li>
          </ul>
          <Callout tone="warn" title="Not yet confirmed on a Play test app:">
            the answer to a duplicate offer ID, which state changes Play allows, how a developer-determined offer reads back, the regions version taken
            from Play&apos;s price conversion, patching an active offer&apos;s eligibility or tags, and Play&apos;s rounding of discounted prices
            (previews show estimates).
          </Callout>
        </>
      ),
    },
  ],
};

export const offersInStep: DocPage = {
  slug: 'offers-in-step',
  title: 'Keeping offers in step',
  description:
    'Offer prices are absolute: when a base price changes, an offer priced at “50% of each territory’s price” no longer is. A rules file in your repository says which offers follow which rule, and sync plans re-price them.',
  sections: [
    {
      id: 'rules-files',
      title: 'Rules files',
      body: (
        <>
          <p>The stores don&apos;t record an offer&apos;s rule, so you keep the rules in a file next to your code:</p>
          <CodeBlock
            example
            lang="json"
            code={`{
  "kind": "pricingkit.offerRules", "schemaVersion": 1, "app": { "bundleId": "com.example.app" },
  "offers": [{
    "product": { "platform": "apple", "type": "subscription", "id": "1234567890" },
    "kind": "apple.promo", "key": "example_annual_50",
    "pricing": { "type": "percentOfCurrent", "percent": "50", "basis": "totalOverDuration", "snap": "nearest" },
    "syncWithBase": true
  }]
}`}
          />
          <ul>
            <li>
              <code>key</code> is the offer&apos;s key as <code>pricingkit offers</code> lists it (promotional offer code, offer code name, win-back
              offer ID, or an introductory offer&apos;s key) or its store ID. <code>basis</code> may be left out: pay-up-front offers then use{' '}
              <code>totalOverDuration</code>, others <code>perPeriod</code>.
            </li>
            <li>
              Optional: <code>territories</code> (default: all of the offer&apos;s) and <code>deviationThreshold</code> (default{' '}
              <code>&quot;0.05&quot;</code>).
            </li>
            <li>
              <code>syncWithBase: false</code> keeps an offer out of sync plans.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: 'sync-plans',
      title: 'Sync plans',
      body: (
        <>
          <CodeBlock
            example
            lang="bash"
            code={`pricingkit plan --rules offer-rules.json --out sync.json                     # against today's base prices
pricingkit plan --spec pricing.json --rules offer-rules.json --out plan.json # base prices and offers in one plan`}
          />
          <p>
            <code>plan --rules</code> re-derives every <code>syncWithBase</code> offer against the current base prices and plans{' '}
            <code>updateOfferPrices</code> for the ones out of step, for example right after base prices changed.{' '}
            <strong>A plan with no ops means every synced offer is in step.</strong>
          </p>
          <p>
            With a base-price spec, one plan holds the base-price ops, then offer ops re-derived against the prices that plan sets (not today&apos;s).
            Each offer op lists the base ops of its product it depends on:
          </p>
          <ul>
            <li>
              Every base-price op is applied before any offer op. If a base op an offer op depends on fails (or the price moved since planning), the
              offer op fails with <code>BASE_NOT_APPLIED</code> and nothing is sent for it; a resume applies it once the base ops are done.
            </li>
            <li>
              Undo goes the other way round: offers revert first, and a base price is never reverted under an offer still priced from the new one (
              <code>OFFER_NOT_APPLIED</code>).
            </li>
            <li>Sync only changes prices of territories the offer already has. A territory the rule can&apos;t price keeps its offer price and is listed.</li>
          </ul>
          <p>
            A combined plan changes base prices, so <code>pricingkit apply</code> needs <code>--allow-base-prices</code> for it (see{' '}
            <DocLink to="plans#base-prices-from-the-cli">Base prices from the CLI</DocLink>).
          </p>
        </>
      ),
    },
    {
      id: 'manual-actions',
      title: 'Needs manual action',
      body: (
        <p>
          Only promotional offers (and Play offers) can be re-priced. Offer codes, win-back offers and introductory offers whose prices no longer match
          are listed under &quot;Needs manual action&quot; (<code>manualActions</code> in the plan) with what to do, such as &quot;create a new offer
          code at the new prices and deactivate this one&quot;. PricingKit never deletes or re-creates an offer by itself. Missing offers, unreadable
          ones and rules on free trials are listed there too, and <code>pricingkit diff</code> shows them after the base prices and offers.
        </p>
      ),
    },
    {
      id: 'scheduled-base-prices',
      title: 'Scheduled base prices',
      body: (
        <p>
          An offer&apos;s new prices apply as soon as the plan is applied, so re-deriving an offer against a base price that starts in June would charge
          the June-based offer price from today. By default sync <strong>holds</strong> those territories: they keep their offer price and are named in
          a <code>BASE_SCHEDULED</code> manual action saying to sync again on or after the date. The offer&apos;s other territories are still re-priced
          in the same plan. <code>--scheduled-base now</code> re-derives them against the scheduled prices anyway, with a warning. A base price already
          scheduled in the store is warned about too.
        </p>
      ),
    },
    {
      id: 'google-play-rules',
      title: 'Google Play rules',
      body: (
        <>
          <p>
            A rules file for a <code>packageName</code> app lists <code>play.offer</code> rules: <code>product</code> is the base plan and{' '}
            <code>key</code> the offer ID. <code>phase</code> (1 or 2) says which phase of a two-phase offer the rule prices (default: the only one
            that isn&apos;t free).
          </p>
          <DocTable
            caption="Play rule pricing"
            head={[<code key="k">pricing</code>, 'What sync does']}
            rows={[
              [<code key="k">play.relativeDiscount</code>, 'Follows the base price by itself: listed as "follows base automatically"; patched only if the store’s fraction differs from the rule.'],
              [<code key="k">percentOfCurrent</code>, 'Fixed prices go out of step when a base price changes: re-derived against the new base prices (about one Play request per region) and patched.'],
              [
                <>
                  <code>fixed</code>, <code>play.absoluteDiscount</code>
                </>,
                'Patched back to the rule; a region where they are no longer below the base price is left and listed. An absolute discount keeps the same amount off a new base price.',
              ],
            ]}
          />
          <p>
            Play has no scheduled base prices, so <code>--scheduled-base</code> doesn&apos;t apply.
          </p>
        </>
      ),
    },
  ],
};

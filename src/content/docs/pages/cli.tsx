import { Callout, CodeBlock, DocLink, DocTable } from '@/components/docs/doc-blocks';
import type { DocPage } from '../types';

export const cliInstall: DocPage = {
  slug: 'cli-install',
  title: 'Install and credentials',
  description:
    'The pricingkit command line runs from a clone of the repository. It is not published to npm, and it takes store credentials only from environment variables.',
  sections: [
    {
      id: 'install',
      title: 'Install',
      body: (
        <>
          <p>TypeScript runs through <code>tsx</code>; there is no build step.</p>
          <CodeBlock
            lang="bash"
            code={`cd /path/to/pricingkit && npm ci
alias pricingkit="node /path/to/pricingkit/bin/pricingkit.mjs"   # or put that line in a script on your PATH
pricingkit --help`}
          />
          <p>
            The examples in these docs run <code>pricingkit</code> that way. From another folder you can also use{' '}
            <code>npm exec --prefix /path/to/pricingkit --no-install pricingkit -- &lt;command&gt;</code>.
          </p>
          <Callout tone="warn" title="Never run npx pricingkit outside the clone.">
            Where no local <code>pricingkit</code> is installed, <code>npx</code> downloads a package of that name from the npm registry and runs it
            with your store credentials in its environment, and that package is not this project. Inside the clone,{' '}
            <code>npx --no-install pricingkit</code> is safe: <code>--no-install</code> refuses to download anything.
          </Callout>
          <p>
            The launcher turns off tsx&apos;s shared disk cache before loading it, so another user on a shared machine or CI runner can&apos;t plant
            compiled code there.
          </p>
        </>
      ),
    },
    {
      id: 'credentials',
      title: 'Credentials',
      body: (
        <>
          <p>Credentials come only from environment variables, never from flags or files in the repository:</p>
          <DocTable
            caption="Credential variables"
            head={['Store', 'Variables']}
            rows={[
              [
                'App Store Connect',
                <>
                  <code>ASC_KEY_ID</code>, <code>ASC_ISSUER_ID</code>, and one of <code>ASC_PRIVATE_KEY</code> (the key&apos;s PEM text; literal{' '}
                  <code>\n</code> is accepted), <code>ASC_PRIVATE_KEY_HEX</code> (the same text, hex-encoded) or <code>ASC_PRIVATE_KEY_PATH</code> (path to
                  the key file). Select the app with <code>--bundle-id</code>.
                </>,
              ],
              [
                'Google Play',
                <>
                  <code>GOOGLE_APPLICATION_CREDENTIALS</code> (path to a service account key file) or <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> (the key
                  JSON itself). Select the app with <code>--package-name</code>.
                </>,
              ],
            ]}
          />
          <p>
            A key that can&apos;t be imported is refused up front, naming the variable. The CLI holds credentials in memory only: it never prints them,
            writes them to disk or logs request headers. As a backstop, everything it prints, and every run log it writes, is scrubbed of the key
            material it loaded, the tokens it minted, PEM blocks, bearer tokens, Google access tokens and JWTs.
          </p>
        </>
      ),
    },
    {
      id: 'macos-keychain',
      title: 'macOS Keychain',
      body: (
        <>
          <p>Keep the App Store Connect key in the login Keychain instead of a file:</p>
          <CodeBlock
            example
            lang="bash"
            code={`# Once: store the key file's text (multi-line) as a generic password
security add-generic-password -s pricingkit-asc -a "$USER" -w "$(cat ~/Downloads/AuthKey_XXXX.p8)"
# then delete the downloaded key file

# Each session (or in a wrapper script)
export ASC_KEY_ID=... ASC_ISSUER_ID=...
export ASC_PRIVATE_KEY_HEX="$(security find-generic-password -s pricingkit-asc -a "$USER" -w)"
pricingkit offers --bundle-id com.example.app --subscription 1234567890`}
          />
          <p>
            <code>security find-generic-password -w</code> prints a secret that contains newlines (like a PEM key) as hex, which is why the recipe uses{' '}
            <code>ASC_PRIVATE_KEY_HEX</code>. If you stored the key on one line, it prints as text: use <code>ASC_PRIVATE_KEY</code> instead. To turn
            the hex back into text yourself, pipe it through <code>xxd -r -p</code>. <code>add-generic-password -w &lt;value&gt;</code> puts the key on
            that command&apos;s argument list for a moment; run it on a machine you trust.
          </p>
        </>
      ),
    },
    {
      id: 'app-pins',
      title: 'App pins',
      body: (
        <>
          <p>
            Set <code>PRICINGKIT_EXPECT_BUNDLE_ID</code> and/or <code>PRICINGKIT_EXPECT_PACKAGE</code> and the CLI refuses any other App Store or Google
            Play app (from a flag, a spec, a rules file or a plan) with <code>APP_NOT_EXPECTED</code>, before loading credentials or sending anything.
            Both take a comma-separated list. Useful in CI jobs made for one app, and for <DocLink to="agents">agents</DocLink>.
          </p>
          <CodeBlock example lang="bash" code={`export PRICINGKIT_EXPECT_BUNDLE_ID=com.example.app,com.example.other`} />
        </>
      ),
    },
  ],
};

export const cliCommands: DocPage = {
  slug: 'cli-commands',
  title: 'Commands',
  description: 'Only apply writes to a store, and only with --confirm and the plan’s hash. Everything else reads, plans or works offline.',
  sections: [
    {
      id: 'commands',
      title: 'Commands',
      body: (
        <DocTable
          caption="pricingkit commands"
          head={['Command', 'What it does']}
          rows={[
            [
              <code key="k">export</code>,
              <>
                Current (and scheduled) prices of an App Store subscription or a Google Play base plan, as a <code>pricingkit.state</code> snapshot.{' '}
                <code>--in-app &lt;product id&gt;</code> exports an App Store in-app purchase or a Google Play one-time product instead.{' '}
                <code>--out &lt;file&gt;</code> also writes it; <code>--format csv [--offers]</code> writes a{' '}
                <DocLink to="workspaces#prices-csv">prices CSV</DocLink>.
              </>,
            ],
            [
              <code key="k">plan --spec &lt;file&gt;</code>,
              <>
                Reads a pricing spec, snaps its targets to real store prices and writes the plan; with an offer plan spec, plans creating or re-pricing
                offers. A dry run: it only reads. The default file, <code>pricingkit-plan.json</code>, is never replaced unless you pass{' '}
                <code>--force</code>; <code>--out</code> names the file and replaces it. <code>--state-out</code> saves the prices it planned against.
              </>,
            ],
            [
              <code key="k">plan --rules &lt;file&gt; [--spec &lt;file&gt;]</code>,
              <>
                Plans keeping <code>syncWithBase</code> offers in step. <code>--scheduled-base hold|now</code>. See{' '}
                <DocLink to="offers-in-step">Keeping offers in step</DocLink>.
              </>,
            ],
            [<code key="k">diff &lt;plan.json&gt;</code>, 'A readable summary: changes per product and territory with before, after and percent change, skipped territories by reason, warnings, manual actions, and the plan hash. No store requests.'],
            [
              <code key="k">offers</code>,
              <>
                An App Store subscription&apos;s offers with each territory&apos;s price (<code>--kind</code> filters), or a Google Play subscription&apos;s
                offers (<code>--package-name</code>, <code>--base-plan</code>).
              </>,
            ],
            [
              <code key="k">offer deactivate|activate|delete</code>,
              <>
                Plans one lifecycle change of an existing offer and writes it as a plan file. What the store doesn&apos;t allow (deactivating a
                promotional offer, deleting an offer code or an active Play offer) is refused with the reason. Reads only.
              </>,
            ],
            [
              <code key="k">apply &lt;plan.json&gt; --confirm &lt;hash&gt;</code>,
              <>
                Applies a plan. Saves the run log before and after every write (<code>--run-out</code>, default <code>&lt;plan&gt;.run.json</code> next
                to the plan file, never overwritten) and continues one with <code>--resume &lt;run.json&gt;</code>. Deleting offers needs{' '}
                <code>--force-delete</code>; base prices need <code>--allow-base-prices</code>.
              </>,
            ],
            [
              <code key="k">undo &lt;plan.json&gt; &lt;run.json&gt;</code>,
              <>
                Writes the plan that undoes a run (default <code>&lt;plan&gt;.undo.json</code>) and prints its summary, hash and anything that can&apos;t
                be reversed. Offline.
              </>,
            ],
            [
              <code key="k">plan --workspace &lt;file&gt;</code>,
              <>
                One plan per app of a <DocLink to="workspaces">workspace</DocLink>, plus an index with one hash. <code>diff</code>, <code>apply</code>{' '}
                and <code>undo</code> take <code>--workspace-plan &lt;index&gt;</code>.
              </>,
            ],
            [<code key="k">parity --workspace &lt;file&gt;</code>, 'Compares the App Store and Google Play prices of every mapped subscription per territory. Read-only.'],
            [
              <code key="k">mcp</code>,
              <>
                An <DocLink to="agents">MCP server</DocLink> over stdio for agents.
              </>,
            ],
          ]}
        />
      ),
    },
    {
      id: 'apply-at-a-terminal',
      title: 'apply at a terminal',
      body: (
        <>
          <p>
            At a terminal, <code>apply</code> first prints what the plan does (the app, ops by kind, base-price ops, deletes, App Store changes that move
            existing subscribers) and asks you to type the app&apos;s bundle ID or package name (with <code>--workspace-plan</code>, the number of
            apps) before it loads credentials. Anything else cancels with nothing sent.
          </p>
          <ul>
            <li>
              <code>--yes</code> is refused at a terminal. It is for CI and pipes, where nothing is asked.
            </li>
            <li>
              With stdin redirected but stderr still a terminal (<code>apply ... &lt; /dev/null</code>), the summary is still shown and{' '}
              <code>--yes</code> is required, so skipping the question is visible.
            </li>
          </ul>
          <CodeBlock
            example
            lang="bash"
            code={`export ASC_KEY_ID=... ASC_ISSUER_ID=... ASC_PRIVATE_KEY_PATH=~/keys/AuthKey_XXXX.p8

pricingkit export --bundle-id com.example.app --subscription 1234567890 --out state.json
pricingkit plan --spec pricing.json --out plan.json
pricingkit diff plan.json
pricingkit apply plan.json --confirm <hash from diff> --allow-base-prices`}
          />
        </>
      ),
    },
    {
      id: 'shared-options',
      title: 'Shared options',
      body: (
        <ul>
          <li>
            <code>--json</code> prints the document itself on stdout (<code>pricingkit.state</code>, <code>pricingkit.changeset</code>,{' '}
            <code>pricingkit.planSummary</code>, <code>pricingkit.offers</code>, <code>pricingkit.parity</code>), or{' '}
            <code>{'{"error": {"message", "code", "status"}}'}</code> on failure. Everything else, store client logs included, goes to stderr.
          </li>
          <li>
            <code>--budget &lt;n&gt;</code> caps the store requests one run may send (default 1000, leaving room within App Store Connect&apos;s 3600
            per hour for anything else using the same key). A spent budget stops the run with an error rather than a partial result.
          </li>
          <li>
            Plan text, store messages and errors are printed as text: control characters, escape sequences, direction overrides and zero-width
            characters are shown escaped, so a crafted plan can&apos;t drive your terminal.
          </li>
        </ul>
      ),
    },
    {
      id: 'exit-codes',
      title: 'Exit codes',
      body: (
        <DocTable
          caption="Exit codes"
          head={['Code', 'Meaning']}
          rows={[
            [<code key="k">0</code>, <>OK. For <code>plan</code> and <code>diff</code>: no changes. For <code>parity</code>: every compared territory is in parity.</>],
            [<code key="k">1</code>, 'Error: bad arguments, an invalid spec or plan, missing credentials, a store error, or a spent request budget.'],
            [
              <code key="k">2</code>,
              <>
                Something to act on: <code>plan</code>/<code>diff</code> found changes (or, for sync plans, manual actions), or <code>parity</code> found a
                gap above the threshold.
              </>,
            ],
          ]}
        />
      ),
    },
  ],
};

export const specFiles: DocPage = {
  slug: 'spec-and-rules-files',
  title: 'Spec and rules files',
  description:
    'A pricing spec says what prices you want; plan turns it into exact store prices. Specs and rules files may be JSON or YAML; plans, run logs and state are always JSON.',
  sections: [
    {
      id: 'pricing-spec',
      title: 'Pricing spec',
      body: (
        <>
          <p>
            <code>pricingkit.spec</code>, version 1. <code>plan</code> reads the products&apos; current prices, turns the targets into per-territory
            amounts and snaps them: on the App Store to each territory&apos;s own price points (<code>snap</code>, default <code>nearest</code>), on
            Google Play through Play&apos;s price conversion (a read-only call). A spec never names price point IDs.
          </p>
          <CodeBlock
            example
            lang="json"
            code={`{
  "kind": "pricingkit.spec",
  "schemaVersion": 1,
  "app": { "bundleId": "com.example.app" },
  "description": "Spring price review",
  "products": [
    {
      "product": { "platform": "apple", "type": "subscription", "id": "1234567890" },
      "targets": { "type": "fixed", "prices": { "GB": "4.99", "US": "5.99", "CA": { "amount": "7.99", "currency": "CAD" } } },
      "snap": "nearest"
    },
    {
      "product": { "platform": "apple", "type": "subscription", "id": "1234567891" },
      "targets": { "type": "percentOfCurrent", "percent": "110", "territories": "all" },
      "startDate": "2030-06-01"
    }
  ]
}`}
          />
        </>
      ),
    },
    {
      id: 'targets',
      title: 'Targets',
      level: 3,
      body: (
        <ul>
          <li>
            <code>fixed</code>: these territories get these prices (alpha-2 keys). A bare amount is in the territory&apos;s current currency; give{' '}
            <code>{'{ "amount", "currency" }'}</code> for a territory without one. Or <code>pricesFile</code>: a{' '}
            <DocLink to="workspaces#prices-csv">prices CSV</DocLink>.
          </li>
          <li>
            <code>percentOfCurrent</code>: each territory&apos;s current price times <code>percent</code> / 100 (<code>&quot;110&quot;</code> is a 10%
            rise; above 0, at most 1000, up to 4 decimals), for <code>&quot;all&quot;</code> priced territories or a list.
          </li>
          <li>
            <code>strategy</code>: one base price spread to every territory. See <DocLink to="pricing-strategies#in-a-spec-file">Pricing strategies</DocLink>.
          </li>
        </ul>
      ),
    },
    {
      id: 'product-options',
      title: 'Product options',
      level: 3,
      body: (
        <>
          <ul>
            <li>
              <code>snap</code> (App Store), <code>startDate</code> (App Store: schedule instead of changing now), <code>allowNewTerritories</code>{' '}
              (default <code>false</code>: never price a territory that has no price), <code>preserveCurrentPrice</code> (App Store, default{' '}
              <code>true</code>), <code>baseTerritory</code>.
            </li>
            <li>
              <code>measure</code> and <code>commission</code>: see <DocLink to="pricing-by-proceeds">Pricing by proceeds</DocLink>.{' '}
              <code>consent</code>: see <DocLink to="existing-subscribers">Existing subscribers</DocLink>. Top-level <code>freshness</code>: see{' '}
              <DocLink to="reference-data">Reference data</DocLink>.
            </li>
            <li>
              Products: App Store subscriptions (numeric App Store Connect ID), Google Play base plans (
              <code>{'{ "platform": "google", "type": "subscription", "productId", "basePlanId" }'}</code>) and one-time products (
              <code>{'{ "platform": "google", "type": "inapp", "productId" }'}</code>). All must belong to the spec&apos;s <code>app</code>.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: 'yaml',
      title: 'YAML',
      body: (
        <>
          <p>
            Spec and rules files may be YAML (a <code>.yaml</code> or <code>.yml</code> name). Numbers keep the digits you write, so <code>4.10</code>{' '}
            stays <code>4.10</code> and an ID with a leading zero keeps it. Tags, several documents per file, duplicate keys and alias bombs are
            refused, and errors give the line and column only, never the file&apos;s text.
          </p>
          <CodeBlock
            example
            lang="yaml"
            code={`kind: pricingkit.spec
schemaVersion: 1
app: { bundleId: com.example.app }
products:
  - product: { platform: apple, type: subscription, id: "1234567890" }
    targets: { type: strategy, strategy: ppp, base: { territory: US, amount: 9.99 } }`}
          />
        </>
      ),
    },
    {
      id: 'other-files',
      title: 'Other files',
      body: (
        <ul>
          <li>
            <code>pricingkit.offerPlanSpec</code>: offers to create or re-price. See <DocLink to="apple-offers#offer-plan-specs">Apple offers</DocLink>{' '}
            and <DocLink to="google-play-offers#planning-offers">Google Play offers</DocLink>.
          </li>
          <li>
            <code>pricingkit.offerRules</code>: which offers follow which rule. See <DocLink to="offers-in-step">Keeping offers in step</DocLink>.
          </li>
          <li>
            <code>pricingkit.workspace</code>: several apps. See <DocLink to="workspaces">Workspaces, parity and CSV</DocLink>.
          </li>
          <li>
            Plans are written as schema version 3; versions 1 to 3 are read. A plan from a newer version is refused with &quot;written by a newer
            PricingKit; upgrade&quot;.
          </li>
        </ul>
      ),
    },
  ],
};

export const workspaces: DocPage = {
  slug: 'workspaces',
  title: 'Workspaces, parity and CSV',
  description:
    'A workspace lists apps on both stores. One command plans, diffs, applies and undoes for all of them, one plan per app, and reports where the two stores’ prices differ.',
  sections: [
    {
      id: 'workspace-files',
      title: 'Workspace files',
      body: (
        <>
          <p>
            <code>pricingkit.workspace</code> v1, JSON or YAML. Each app names its own spec, rules file and offer plan spec (paths relative to the
            workspace file, inside the working directory), or gives its spec products inline. Parity mappings tie an App Store subscription to a
            Google Play base plan.
          </p>
          <CodeBlock
            example
            lang="yaml"
            code={`kind: pricingkit.workspace
schemaVersion: 1
apps:
  - id: ios
    app: { bundleId: com.example.app }
    spec: pricing/ios.yaml          # a pricingkit.spec
    rules: pricing/ios-rules.yaml   # a pricingkit.offerRules (optional)
    offers: pricing/ios-offers.yaml # a pricingkit.offerPlanSpec (optional)
  - id: android
    app: { packageName: com.example.app }
    products:                       # or the spec's products inline
      - product: { platform: google, type: subscription, productId: pro, basePlanId: monthly }
        targets: { type: percentOfCurrent, percent: "105" }
parity:
  - id: annual
    apple: { bundleId: com.example.app, subscription: "1234567890" }
    play: { packageName: com.example.app, subscription: pro, basePlan: annual }
    target: { type: strategy, strategy: ppp, base: { amount: "49.99" } }
    baseTerritory: US               # per product, never app-wide
    threshold: "0.05"               # parity gap allowed, a fraction of the lower price`}
          />
        </>
      ),
    },
    {
      id: 'one-plan-per-app',
      title: 'One plan per app',
      body: (
        <>
          <p>
            <code>plan --workspace</code> writes an ordinary plan per app (<code>&lt;id&gt;.json</code>: its spec and rules) and one per offer plan spec
            (<code>&lt;id&gt;.offers.json</code>), plus <code>workspace-plan.json</code>, an index listing them in apply order with each plan&apos;s app
            and hash and one workspace hash over them all.
          </p>
          <p>
            Every safety check PricingKit has is per plan and per app: a plan&apos;s hash covers its app, <code>apply</code> builds the adapter for that
            app only, and the executor refuses another app&apos;s plan or product. A plan never holds ops for two apps, so no op can run with another
            app&apos;s credentials, and <code>diff --workspace-plan</code> lists every app the run will touch.
          </p>
          <ul>
            <li>
              <code>apply --workspace-plan &lt;index&gt; --confirm &lt;workspace hash&gt;</code> checks, before anything is read, that every plan file
              still has the hash the index records and is for the app it lists, and that every app passes the pins. It then applies the plans one by
              one and stops at the first that doesn&apos;t complete. <code>--resume-runs</code> continues from the logs (each must belong to the plan
              next to it); <code>--force</code> replaces them. One request budget covers the whole run.
            </li>
            <li>
              Planning again into the same <code>--out-dir</code> needs <code>--force</code>; earlier run logs and undo plans are moved aside to{' '}
              <code>&lt;file&gt;.stale-&lt;timestamp&gt;</code>, never deleted.
            </li>
            <li>
              <code>undo --workspace-plan &lt;index&gt;</code> writes an undo plan per applied plan, newest first, and <code>&lt;index&gt;.undo.json</code>{' '}
              to apply the same way.
            </li>
            <li>
              Credentials stay per store: one App Store Connect key for every bundle and one service account for every package. Products are checked to
              belong to their app before their prices are read.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: 'parity',
      title: 'Parity',
      body: (
        <>
          <p>
            Each mapping with a <code>target</code> adds that target to both apps&apos; specs, and each store snaps it separately. The plan output ends
            with the parity report on the planned prices; <code>pricingkit parity --workspace</code> reports the current ones, read-only.
          </p>
          <p>
            Per territory: <code>same</code>, <code>withinThreshold</code>, <code>gap</code> (the difference is more than the threshold times the lower
            price), <code>notComparable</code> (the stores bill different currencies; never converted), <code>appleOnly</code>, <code>playOnly</code>{' '}
            or <code>unreadable</code>. A mapping is in parity, has GAPS (exit 2), or is NOT CHECKED (exit 1) when a territory couldn&apos;t be compared
            or none is priced on both stores.
          </p>
          <p>
            Prices are compared as each store lists them: both stores show tax-inclusive prices in most territories and tax-exclusive ones in a few,
            such as the United States.
          </p>
        </>
      ),
    },
    {
      id: 'prices-csv',
      title: 'Prices CSV',
      body: (
        <>
          <p>
            <code>pricingkit export ... --format csv [--offers]</code> (or <code>--workspace &lt;file&gt; --format csv</code>) writes a{' '}
            <code>pricingkit.prices</code> CSV. The web app&apos;s Export prices menu offers the same file (&quot;CSV for import&quot;).
          </p>
          <CodeBlock
            example
            lang="csv"
            code={`# pricingkit.prices v1
app,platform,product_type,product,base_plan,offer_kind,offer_key,territory,currency,price,proceeds
com.example.app,apple,subscription,1234567890,,,,GB,GBP,44.99,36.62
com.example.app,apple,subscription,1234567890,,apple.promo,retention_half,GB,GBP,22.99,18.71
com.example.app,google,basePlan,pro,annual,,,GB,GBP,49.99,`}
          />
          <DocTable
            caption="Prices CSV columns"
            head={['Column', 'Meaning']}
            rows={[
              [<code key="k">app</code>, 'Bundle ID or package name'],
              [<code key="k">platform</code>, <><code>apple</code> or <code>google</code></>],
              [
                <code key="k">product_type</code>,
                <>
                  <code>subscription</code> or <code>inAppPurchase</code> (App Store), <code>basePlan</code> or <code>oneTime</code> (Google Play). Optional
                  on import (inferred); in-app purchase rows are refused on import.
                </>,
              ],
              [<code key="k">product</code>, 'App Store: numeric subscription (or in-app purchase) ID. Google Play: product ID.'],
              [<code key="k">base_plan</code>, 'Google Play base plan ID (empty on the App Store and for one-time products)'],
              [<><code>offer_kind</code>, <code>offer_key</code></>, 'Empty for a base price; otherwise the offer’s kind and key'],
              [<><code>territory</code>, <code>currency</code>, <code>price</code></>, 'ISO alpha-2, ISO 4217 and the customer price as a plain decimal'],
              [<code key="k">proceeds</code>, 'Information only (App Store proceeds); ignored on import'],
            ]}
          />
          <p>
            Import by naming the file in a spec: <code>{'targets: { type: fixed, pricesFile: prices.csv }'}</code> on a spec product, or{' '}
            <code>{'pricing: { type: fixed, pricesFile: offers.csv }'}</code> on an offer (not introductory offers, which have no key). The plan snaps
            the rows like any target and lists every row that wasn&apos;t planned exactly as written. An offer row whose currency isn&apos;t the
            territory&apos;s is refused. The file must be relative to the spec, inside the working directory, and at most 5 MB. Errors give the line and
            column, never a cell&apos;s contents. Exporting and importing an unchanged file plans no changes.
          </p>
        </>
      ),
    },
  ],
};

export const agents: DocPage = {
  slug: 'agents',
  title: 'Agents (MCP)',
  description:
    'pricingkit mcp is a Model Context Protocol server over stdio for agents that should read prices and plan changes. People apply them.',
  sections: [
    {
      id: 'configuration',
      title: 'Configuration',
      body: (
        <>
          <p>
            Add it to your MCP client as a command that runs the launcher in your clone by its absolute path, started in the folder holding your spec
            and rules files, with the credentials in its environment:
          </p>
          <CodeBlock
            example
            lang="json"
            code={`{
  "mcpServers": {
    "pricingkit": {
      "command": "node",
      "args": ["/path/to/pricingkit/bin/pricingkit.mjs", "mcp"],
      "cwd": "/path/to/your/pricing-files",
      "env": {
        "PRICINGKIT_EXPECT_BUNDLE_ID": "com.example.app",
        "ASC_KEY_ID": "...", "ASC_ISSUER_ID": "...", "ASC_PRIVATE_KEY_PATH": "/path/to/your-key-file"
      }
    }
  }
}`}
          />
          <Callout tone="warn">
            Don&apos;t configure it as <code>npx pricingkit mcp</code>: outside the clone that downloads whatever the npm registry has under that name
            and hands it your credentials. <strong>Pin the app</strong> with <code>PRICINGKIT_EXPECT_BUNDLE_ID</code> /{' '}
            <code>PRICINGKIT_EXPECT_PACKAGE</code>, so a plan or spec for another app is refused before anything is read.
          </Callout>
        </>
      ),
    },
    {
      id: 'tools',
      title: 'Tools',
      body: (
        <>
          <DocTable
            caption="MCP tools"
            head={['Tool', 'What it does']}
            rows={[
              [<code key="k">offers</code>, <>Lists a subscription&apos;s offers (as <code>pricingkit offers --json</code>).</>],
              [<code key="k">plan</code>, <>Makes a plan from a spec and/or rules file and writes it to <code>out</code> (a dry run).</>],
              [<code key="k">diff</code>, 'Summarises a plan file, without its confirm hash. Offline.'],
              [
                <code key="k">apply_command</code>,
                <>
                  Returns the start of the <code>pricingkit apply &lt;plan&gt;</code> command for a person to finish: without <code>--confirm</code> and
                  without the opt-in flags (it names the ones the plan needs, <code>--allow-base-prices</code> / <code>--force-delete</code>, and why). It
                  applies nothing.
                </>,
              ],
            ]}
          />
          <p>
            There is no apply tool. Arguments are typed and can&apos;t start with <code>-</code>. File paths are relative, use only letters, digits,{' '}
            <code>.</code>, <code>_</code>, <code>-</code> and <code>/</code>, have no <code>..</code> segments, nothing under <code>.git/</code>, and
            must resolve (following links) inside the server&apos;s working directory. Files read must be regular files of at most 16 MB.{' '}
            <code>plan</code> writes only <code>.json</code> files, never into a folder or file whose name starts with <code>.</code>, and never
            replaces a file that isn&apos;t already a plan or state file.
          </p>
        </>
      ),
    },
    {
      id: 'the-human-step',
      title: 'The human step',
      body: (
        <>
          <p>
            No tool returns a plan&apos;s confirm hash: <code>plan</code> and <code>diff</code> leave it out, and anything shaped like one (32 or more
            hex digits) is masked in every tool result and in stderr. So <code>apply_command</code> doesn&apos;t hand over a ready-to-run command; the
            person runs <code>pricingkit diff</code> themselves to get the hash.
          </p>
          <Callout tone="warn" title="Removing the hash is a speed bump, not a gate.">
            An agent that can run code can recompute a plan&apos;s hash from the plan file. The gate is <code>pricingkit apply</code> at a terminal: it
            always shows what the plan does and asks the person to type the app&apos;s bundle ID or package name before it loads credentials, and{' '}
            <code>--yes</code> is refused there. Run apply yourself, at a terminal, and read the summary.
          </Callout>
        </>
      ),
    },
  ],
};

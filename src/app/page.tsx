import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader, pillPrimary, pillSecondary } from '@/components/site/site-header';
import { SiteFooter } from '@/components/site/site-footer';
import { OpenAppLink } from '@/components/site/open-app-link';
import { ExamplePriceTable } from '@/components/landing/example-price-table';
import { ROUTES, SITE_DESCRIPTION } from '@/config/site';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: { absolute: 'PricingKit: regional pricing for the App Store and Google Play' },
  description: SITE_DESCRIPTION,
  alternates: { canonical: '/' },
};

const STEPS = [
  { title: 'Connect', body: 'Sign in with an App Store Connect key or a Google Play service account.' },
  { title: 'Choose a strategy', body: 'Purchasing power, Big Mac, Netflix, direct conversion or your own multipliers.' },
  { title: 'Review the plan', body: 'Every country before and after, snapped to real price points.' },
  { title: 'Apply or undo', body: 'Apply with the plan hash. Resume or undo any run from its log.' },
] as const;

const FEATURES = [
  {
    title: 'Offers on both stores',
    body: 'Introductory, promotional, offer code and win-back offers on the App Store. Phases, eligibility and tags on Google Play. Each one priced per country and kept in step when base prices change.',
  },
  {
    title: 'Nothing changes without you',
    body: "Every change is a plan you review first. Apply needs that plan's hash, stopped runs resume, and any run can be undone.",
  },
  {
    title: 'From the terminal too',
    body: 'The same plans from the command line, with JSON output, CSV import and export, and workspaces that cover several apps.',
  },
  {
    title: 'Your keys stay yours',
    body: "Your key stays in your browser; PricingKit's server only receives short-lived access tokens. Run PricingKit yourself if you prefer.",
  },
] as const;

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      <main>
        <section className="mx-auto max-w-[1200px] px-4 pt-16 pb-12 text-center sm:px-8 sm:pt-[88px] sm:pb-16">
          <p className="mb-[18px] inline-block rounded-full bg-accent px-3 py-1.5 text-[13px] font-semibold text-accent-foreground">
            Free and open source
          </p>
          <h1 className="mx-auto max-w-[860px] text-[40px] leading-[1.05] font-extrabold tracking-[-0.03em] sm:text-[60px]">
            One price doesn&apos;t fit 175 countries.
          </h1>
          <p className="mx-auto mt-[22px] max-w-[640px] text-[17px] leading-relaxed text-soft sm:text-[19px]">
            PricingKit sets App Store and Google Play prices from what people can actually afford, snaps them to real
            store price points, and keeps your offers in step.
          </p>
          <div className="mt-[34px] flex flex-wrap justify-center gap-3">
            <OpenAppLink className={cn(pillPrimary, 'px-[22px] py-3.5 text-base')} />
            <Link href={ROUTES.docs} className={pillSecondary}>
              Read the docs
            </Link>
          </div>
        </section>

        <section aria-label="Example prices" className="mx-auto max-w-[1040px] px-4 pb-16 sm:px-8 sm:pb-[88px]">
          <ExamplePriceTable />
        </section>

        <section id="how-it-works" aria-labelledby="how-heading" className="scroll-mt-4 border-y bg-header">
          <div className="mx-auto max-w-[1200px] px-4 py-16 sm:px-8 sm:py-[88px]">
            <h2 id="how-heading" className="text-center text-[30px] font-bold tracking-[-0.02em] sm:text-[38px]">
              How it works
            </h2>
            <ol className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
              {STEPS.map((step, i) => (
                <li key={step.title} className="min-w-0">
                  <span
                    aria-hidden="true"
                    className="mb-3.5 flex size-9 items-center justify-center rounded-full bg-accent font-extrabold text-accent-foreground"
                  >
                    {i + 1}
                  </span>
                  <h3 className="mb-2 text-lg font-bold">
                    <span className="sr-only">Step {i + 1}: </span>
                    {step.title}
                  </h3>
                  <p className="text-[15px] leading-relaxed text-soft">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-label="Features" className="mx-auto grid max-w-[1200px] gap-6 px-4 py-16 sm:px-8 sm:py-[88px] md:grid-cols-2">
          {FEATURES.map((f) => (
            <div key={f.title} className="min-w-0 rounded-2xl border bg-card p-6 sm:p-8">
              <h3 className="mb-2.5 text-[22px] font-bold">{f.title}</h3>
              <p className="text-base leading-relaxed text-soft">{f.body}</p>
            </div>
          ))}
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

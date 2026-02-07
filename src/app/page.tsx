'use client';

import Link from 'next/link';
import {
  ArrowRight,
  Github,
  Globe,
  TrendingDown,
  DollarSign,
  Map,
  Shield,
  Code,
} from 'lucide-react';
import { LandingNav } from '@/components/landing/landing-nav';
import { LandingFooter } from '@/components/landing/landing-footer';
import { ConversionTableDemo } from '@/components/landing/conversion-table-demo';
import { Button } from '@/components/ui/button';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

export default function Home() {
  return (
    <div className="min-h-screen bg-background">
      <LandingNav />

      {/* Hero */}
      <section className="container mx-auto px-4 py-16 md:py-24">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div className="space-y-8">
            <div className="space-y-4">
              <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
                Stop losing revenue to{' '}
                <span className="text-primary">bad regional pricing</span>
              </h1>
              <p className="text-lg text-muted-foreground max-w-lg">
                Apple and Google convert your USD price to local currencies using exchange rates alone.
                PricingKit uses Purchasing Power Parity to set prices people can actually afford &mdash; across both the App Store and Google Play.
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <DollarSign className="h-3.5 w-3.5" />
                  Free to use
                </span>
                <span className="flex items-center gap-1.5">
                  <Shield className="h-3.5 w-3.5" />
                  Credentials never stored
                </span>
                <span className="flex items-center gap-1.5">
                  <Code className="h-3.5 w-3.5" />
                  Open-source
                </span>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="flex items-center justify-center h-7 w-7 rounded-full bg-primary text-white text-sm font-medium shrink-0">1</div>
                <div>
                  <p className="font-medium">Connect your App Store or Google Play account</p>
                  <p className="text-sm text-muted-foreground">Upload your API credentials &mdash; they never leave your browser.</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="flex items-center justify-center h-7 w-7 rounded-full bg-primary text-white text-sm font-medium shrink-0">2</div>
                <div>
                  <p className="font-medium">Review PPP-adjusted prices</p>
                  <p className="text-sm text-muted-foreground">See fair prices for every country, side-by-side.</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="flex items-center justify-center h-7 w-7 rounded-full bg-primary text-white text-sm font-medium shrink-0">3</div>
                <div>
                  <p className="font-medium">Push to App Store Connect or Google Play Console</p>
                  <p className="text-sm text-muted-foreground">Update all regions in one click, on either platform.</p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <Button size="lg" asChild>
                <Link href="/setup">
                  Get Started
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button variant="outline" size="lg" asChild>
                <a href="https://github.com/andyshephard/PricingKit" target="_blank" rel="noopener noreferrer">
                  <Github className="h-4 w-4" />
                  View code on GitHub
                </a>
              </Button>
            </div>
          </div>

          <div className="lg:pl-8">
            <ConversionTableDemo />
          </div>
        </div>
      </section>

      {/* Why default store pricing doesn't work */}
      <section className="bg-muted/30 border-y">
        <div className="container mx-auto px-4 py-16 md:py-24">
          <h2 className="text-3xl font-bold text-center mb-4">
            Why default store pricing doesn&apos;t work
          </h2>
          <p className="text-center text-muted-foreground max-w-2xl mx-auto mb-12">
            Apple and Google convert your base price using exchange rates. But exchange rates don&apos;t reflect what people can actually afford to pay.
          </p>

          <div className="grid sm:grid-cols-2 gap-6 max-w-3xl mx-auto">
            <div className="rounded-xl border bg-card p-6 space-y-3">
              <div className="rounded-lg bg-primary/10 p-2 w-fit">
                <Globe className="h-5 w-5 text-primary" />
              </div>
              <h3 className="font-semibold">Exchange rates &ne; affordability</h3>
              <p className="text-sm text-muted-foreground">
                A $9.99 app costs &sim;920 TRY in Turkey. The average Turk would need to spend 4x the relative income an American would for the same app.
              </p>
            </div>

            <div className="rounded-xl border bg-card p-6 space-y-3">
              <div className="rounded-lg bg-primary/10 p-2 w-fit">
                <TrendingDown className="h-5 w-5 text-primary" />
              </div>
              <h3 className="font-semibold">Lost conversions globally</h3>
              <p className="text-sm text-muted-foreground">
                Users in emerging markets skip purchases when prices are set for US wallets. Lower, fairer prices can mean higher overall revenue.
              </p>
            </div>

            <div className="rounded-xl border bg-card p-6 space-y-3">
              <div className="rounded-lg bg-primary/10 p-2 w-fit">
                <DollarSign className="h-5 w-5 text-primary" />
              </div>
              <h3 className="font-semibold">Suboptimal pricing everywhere</h3>
              <p className="text-sm text-muted-foreground">
                In high-income countries like Switzerland, you could charge more without losing conversions. One-size-fits-all leaves money on the table.
              </p>
            </div>

            <div className="rounded-xl border bg-card p-6 space-y-3">
              <div className="rounded-lg bg-primary/10 p-2 w-fit">
                <Map className="h-5 w-5 text-primary" />
              </div>
              <h3 className="font-semibold">175+ territories, zero strategy</h3>
              <p className="text-sm text-muted-foreground">
                Manually researching and updating prices across 175+ App Store and Google Play territories is impractical. PricingKit automates the entire workflow for both platforms.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* PPP Callout */}
      <section className="container mx-auto px-4 py-16 md:py-24">
        <div className="rounded-2xl bg-primary/5 border border-primary/20 p-8 md:p-12 text-center max-w-3xl mx-auto">
          <h2 className="text-2xl font-bold mb-3">
            Powered by Purchasing Power Parity data
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto">
            PricingKit uses PPP multipliers from the World Bank and Big Mac Index data to calculate what your app should cost in each country &mdash; based on real local purchasing power, not just currency conversion.
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="bg-muted/30 border-y scroll-mt-14">
        <div className="container mx-auto px-4 py-16 md:py-24">
          <h2 className="text-3xl font-bold text-center mb-12">
            Frequently Asked Questions
          </h2>

          <div className="max-w-2xl mx-auto">
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="ppp">
                <AccordionTrigger>What is Purchasing Power Parity (PPP)?</AccordionTrigger>
                <AccordionContent>
                  PPP is an economic metric that compares the relative purchasing power of different currencies. It tells you how much a basket of goods costs in one country versus another. PricingKit uses PPP data to adjust your app prices so they feel equally affordable in every market.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="subscribers">
                <AccordionTrigger>Will this affect my existing subscribers?</AccordionTrigger>
                <AccordionContent>
                  No. On Apple, existing subscribers keep their current price until they cancel and re-subscribe, or until you opt in to Apple&apos;s price increase consent flow. On Google Play, existing subscribers are similarly grandfathered unless you configure a price change notification. New subscribers on both platforms will see the updated price.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="connect">
                <AccordionTrigger>How does PricingKit connect to the App Store and Google Play?</AccordionTrigger>
                <AccordionContent>
                  For Apple, you provide an API key (.p8 file), Key ID, and Issuer ID from App Store Connect. For Google Play, you upload a service account JSON key. PricingKit uses these to authenticate directly with each platform&apos;s API. Your credentials are encrypted in a session cookie and never stored on any server.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="currencies">
                <AccordionTrigger>What currencies and countries are supported?</AccordionTrigger>
                <AccordionContent>
                  PricingKit supports all 175 App Store territories and Google Play&apos;s supported markets, covering their respective currencies. PPP adjustment data is available for most countries, with fallbacks to regional averages where individual country data isn&apos;t available.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="effectiveness">
                <AccordionTrigger>Does localized pricing actually increase revenue?</AccordionTrigger>
                <AccordionContent>
                  Yes, significantly. Publishers that adjust prices per country typically see <a href="https://wappier.com/localized-pricing-maximizing-iap-revenue/" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">20&ndash;40% more revenue</a> outside the US, with some seeing far higher gains in specific regions. <a href="https://www.revenuecat.com/blog/growth/price-localization-for-apps/" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">RevenueCat found</a> that apps using regional pricing can double subscriptions in markets like Latin America and triple paying users after adjusting prices to local purchasing power. The key insight is that lower, PPP-adjusted prices in emerging markets drive enough extra conversions to more than offset the lower price point.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="google">
                <AccordionTrigger>Does PricingKit work with Google Play?</AccordionTrigger>
                <AccordionContent>
                  Yes! PricingKit supports both Apple App Store and Google Play Store. You can connect one or both platforms and manage all your regional pricing from a single dashboard.
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="container mx-auto px-4 py-16 md:py-24 text-center">
        <h2 className="text-3xl font-bold mb-4">Start optimizing your regional pricing</h2>
        <p className="text-muted-foreground max-w-lg mx-auto mb-8">
          Set up PricingKit in minutes and start optimizing your regional pricing with PPP data.
        </p>
        <Button size="lg" asChild>
          <Link href="/setup">
            Get Started
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </section>

      <LandingFooter />
    </div>
  );
}

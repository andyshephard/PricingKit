import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Setup guide',
  description: 'Step-by-step guides for connecting PricingKit to App Store Connect and Google Play.',
  alternates: { canonical: '/setup-guide' },
};

const GUIDES = [
  {
    href: '/setup-guide/apple',
    title: 'App Store Connect',
    body: 'Generate an API key with the App Manager role and connect your Apple Developer account.',
  },
  {
    href: '/setup-guide/google',
    title: 'Google Play',
    body: 'Set up a service account, grant it access in Play Console and connect your developer account.',
  },
] as const;

export default function SetupGuideIndexPage() {
  return (
    <article className="min-w-0 max-w-[740px]">
      <h1 className="text-[32px] leading-tight font-extrabold tracking-[-0.02em] sm:text-[40px]">Setup guide</h1>
      <p className="mt-4 text-[18px] leading-[1.7] text-soft">
        PricingKit talks to each store with credentials you create. Pick the store you sell on; each guide takes about ten
        minutes.
      </p>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2">
        {GUIDES.map((g) => (
          <li key={g.href}>
            <Link href={g.href} className="group block h-full rounded-2xl border bg-card p-6 transition-colors hover:border-primary">
              <span className="flex items-center justify-between text-[19px] font-bold">
                {g.title}
                <ArrowRight className="size-4 text-muted-foreground group-hover:text-primary" aria-hidden="true" />
              </span>
              <span className="mt-2 block text-[15px] leading-relaxed text-soft">{g.body}</span>
            </Link>
          </li>
        ))}
      </ul>
    </article>
  );
}

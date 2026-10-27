'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { ServiceAccountUpload } from '@/components/auth/service-account-upload';
import { AppleConnectUpload } from '@/components/auth/apple-connect-upload';
import { useAuthStore } from '@/store/auth-store';
import { Button } from '@/components/ui/button';
import { SiteHeader } from '@/components/site/site-header';
import { SiteFooter } from '@/components/site/site-footer';
import { DOC_LINKS } from '@/config/site';
import { cn } from '@/lib/utils';

type PlatformTab = 'google' | 'apple';

const STORES: Record<PlatformTab, { name: string; body: string; needs: string[]; guide: string }> = {
  apple: {
    name: 'App Store',
    body: 'Use an App Store Connect API key with the App Manager role.',
    needs: [
      'An Apple Developer Program membership',
      'An API key (.p8 file) from App Store Connect',
      'Its Key ID and your Issuer ID',
    ],
    guide: '/setup-guide/apple',
  },
  google: {
    name: 'Google Play',
    body: 'Use a service account JSON key with access to your app in Play Console.',
    needs: [
      'A Google Cloud project with the Play Developer API enabled',
      'A service account JSON key file',
      "Your app's package name (for example com.example.app)",
    ],
    guide: '/setup-guide/google',
  },
};

// The upload components render their own card; inside the selected panel
// that card's chrome is removed so the panel is the only card.
const flattenCard =
  '[&_[data-slot=card]]:max-w-none [&_[data-slot=card]]:border-0 [&_[data-slot=card]]:bg-transparent [&_[data-slot=card]]:py-0 [&_[data-slot=card]]:gap-5 [&_[data-slot=card-header]]:px-0 [&_[data-slot=card-content]]:px-0 [&_[data-slot=card-title]]:text-[22px]';

export default function SetupPage() {
  const router = useRouter();
  const isGoogleAuthenticated = useAuthStore((state) => state.isGoogleAuthenticated);
  const isAppleAuthenticated = useAuthStore((state) => state.isAppleAuthenticated);
  const [activeTab, setActiveTab] = useState<PlatformTab>('apple');

  useEffect(() => {
    if (isGoogleAuthenticated || isAppleAuthenticated) {
      router.push('/dashboard');
    }
  }, [isGoogleAuthenticated, isAppleAuthenticated, router]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader compact />

      <main className="mx-auto w-full max-w-[920px] flex-1 px-4 py-12 sm:px-8 sm:py-[72px]">
        <h1 className="text-center text-[32px] leading-tight font-extrabold tracking-[-0.02em] sm:text-4xl">
          Connect a store
        </h1>
        <p className="mx-auto mt-3 max-w-[560px] text-center text-[17px] leading-relaxed text-soft">
          Choose where your app is sold. You can connect the other store later.
        </p>

        <div className="mt-10 grid gap-5 md:grid-cols-2">
          {(['apple', 'google'] as const).map((id) => {
            const store = STORES[id];
            const selected = activeTab === id;
            return (
              <section
                key={id}
                aria-labelledby={`store-${id}`}
                className={cn('min-w-0 rounded-2xl bg-card p-6 sm:p-7', selected ? 'border-2 border-primary' : 'border')}
              >
                {selected ? (
                  <>
                    <p className="text-[13px] font-bold text-accent-foreground">Selected</p>
                    <h2 id={`store-${id}`} className="sr-only">
                      {store.name}
                    </h2>
                    <div className={cn('mt-2', flattenCard)}>
                      {id === 'apple' ? <AppleConnectUpload /> : <ServiceAccountUpload />}
                    </div>
                  </>
                ) : (
                  <>
                    <h2 id={`store-${id}`} className="text-[22px] font-bold md:mt-6">
                      {store.name}
                    </h2>
                    <p className="mt-1.5 text-[15px] leading-relaxed text-soft">{store.body}</p>
                    <Button variant="outline" size="lg" className="mt-5 w-full" onClick={() => setActiveTab(id)}>
                      Choose {store.name}
                    </Button>
                  </>
                )}
                <div className="mt-6 border-t border-line pt-4 text-sm text-soft">
                  <p className="font-semibold text-foreground">What you&apos;ll need</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {store.needs.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                  <Link href={store.guide} className="mt-3 inline-block rounded-md font-semibold text-link hover:underline">
                    {store.name} setup guide
                  </Link>
                </div>
              </section>
            );
          })}
        </div>

        <div className="mt-7 flex items-start gap-3 rounded-[14px] border bg-card px-5 py-[18px] text-sm leading-relaxed text-soft">
          <Lock className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <p>
            Your key is sent to this server, encrypted into a short-lived session cookie, and never stored.{' '}
            <Link href={`${DOC_LINKS.security}#how-credentials-are-handled`} className="font-semibold text-link hover:underline">
              How keys are handled
            </Link>
          </p>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

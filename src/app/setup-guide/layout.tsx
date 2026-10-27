import { SiteHeader } from '@/components/site/site-header';
import { SiteFooter } from '@/components/site/site-footer';
import { GuideNav } from '@/components/site/guide-nav';

// Guide pages read like docs: a side navigation and one column of text. The
// step cards lose their card chrome here so each step reads as a section.
const flattenCards =
  '[&_[data-slot=card]]:gap-4 [&_[data-slot=card]]:border-0 [&_[data-slot=card]]:bg-transparent [&_[data-slot=card]]:py-0 [&_[data-slot=card-header]]:px-0 [&_[data-slot=card-content]]:px-0';

export default function SetupGuideLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader current="setup-guide" />
      <div className="flex flex-1 flex-col md:flex-row">
        <aside className="border-b bg-header px-4 py-6 sm:px-6 md:w-[280px] md:shrink-0 md:border-r md:border-b-0 md:py-8">
          <GuideNav />
        </aside>
        <main className={`min-w-0 flex-1 px-4 py-10 sm:px-8 lg:px-14 lg:py-12 ${flattenCards}`}>{children}</main>
      </div>
      <SiteFooter />
    </div>
  );
}

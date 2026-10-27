import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: { default: 'Google Play overview · PricingKit', template: '%s · Google Play · PricingKit' },
  robots: { index: false, follow: false },
};

export default function GoogleDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}

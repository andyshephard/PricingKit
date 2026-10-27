import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: { default: 'App Store overview · PricingKit', template: '%s · App Store · PricingKit' },
  robots: { index: false, follow: false },
};

export default function AppleDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}

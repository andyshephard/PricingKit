import type { Metadata } from 'next';
import { PlatformChooser } from '@/components/dashboard/platform-chooser';

export const metadata: Metadata = {
  title: 'Choose a store',
  robots: { index: false, follow: false },
};

export default function DashboardPage() {
  return <PlatformChooser />;
}

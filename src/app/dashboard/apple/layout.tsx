'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';

export default function AppleDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const isAppleAuthenticated = useAuthStore(
    (state) => state.isAppleAuthenticated
  );
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    // Give auth store time to rehydrate from localStorage
    const timer = setTimeout(() => {
      setIsChecking(false);
    }, 100);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!isChecking && !isAppleAuthenticated) {
      router.push('/setup');
    }
  }, [isChecking, isAppleAuthenticated, router]);

  if (isChecking) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAppleAuthenticated) {
    return null;
  }

  return <>{children}</>;
}

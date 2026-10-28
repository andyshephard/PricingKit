'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth-store';
import { AUTH_ERROR_EVENT } from '@/lib/web/client';

export { AUTH_ERROR_EVENT };

export function AuthErrorDialog() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const clearAuth = useAuthStore((state) => state.clearAuth);

  useEffect(() => {
    const handleAuthError = () => {
      setOpen(true);
    };

    window.addEventListener(AUTH_ERROR_EVENT, handleAuthError);
    return () => {
      window.removeEventListener(AUTH_ERROR_EVENT, handleAuthError);
    };
  }, []);

  // The key stays stored: connecting again replaces it. Sign out deletes it.
  const handleReturnHome = () => {
    clearAuth();
    setOpen(false);
    router.push('/setup?reconnect=1');
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LogOut className="h-5 w-5 text-muted-foreground" />
            Connect again
          </DialogTitle>
          <DialogDescription>
            The store didn&apos;t accept the key stored in this browser, or no
            key is stored here. Connect the store again to continue.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={handleReturnHome} className="w-full">
            Connect a store
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Helper function to trigger the auth error dialog
export function triggerAuthError() {
  window.dispatchEvent(new CustomEvent(AUTH_ERROR_EVENT));
}

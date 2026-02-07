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

// Global event for auth errors
export const AUTH_ERROR_EVENT = 'auth:unauthorized';

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

  const handleReturnHome = () => {
    clearAuth();
    setOpen(false);
    router.push('/setup');
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LogOut className="h-5 w-5 text-muted-foreground" />
            Session Expired
          </DialogTitle>
          <DialogDescription>
            Your session has expired or you are no longer authenticated.
            Please return to the setup page to reconnect your account.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={handleReturnHome} className="w-full">
            Return to Setup
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

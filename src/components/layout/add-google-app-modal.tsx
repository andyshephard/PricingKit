'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/store/auth-store';
import { useSetActiveApp } from '@/hooks/use-set-active-app';

interface AddGoogleAppModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddGoogleAppModal({ open, onOpenChange }: AddGoogleAppModalProps) {
  const clientEmail = useAuthStore((s) => s.clientEmail);
  const projectId = useAuthStore((s) => s.projectId);
  const addGoogleAppToHistory = useAuthStore((s) => s.addGoogleAppToHistory);
  const setActive = useSetActiveApp();
  const router = useRouter();

  const [packageName, setPackageName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = packageName.trim();
    if (!trimmed) {
      setError('Please enter a package name.');
      return;
    }
    if (!clientEmail || !projectId) {
      setError('No active service account.');
      return;
    }

    try {
      await setActive.mutateAsync({ platform: 'google', packageName: trimmed });
      addGoogleAppToHistory({ packageName: trimmed, projectId, clientEmail });
      setPackageName('');
      onOpenChange(false);
      router.push('/dashboard/google');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add app.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a Google Play app</DialogTitle>
          <DialogDescription>
            Enter the package name of another app this service account has
            access to.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="add-google-package-name">Package name</Label>
            <Input
              id="add-google-package-name"
              placeholder="com.example.app"
              value={packageName}
              onChange={(e) => setPackageName(e.target.value)}
              disabled={setActive.isPending}
              autoFocus
            />
          </div>
          <div className="text-xs text-muted-foreground">
            Service account: <span className="font-mono">{clientEmail ?? '—'}</span>
          </div>
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={setActive.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={setActive.isPending}>
              {setActive.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Add app
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

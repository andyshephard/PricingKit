'use client';

import { Fragment, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type ExportFormat = 'csv' | 'json';

interface ExportPricesButtonProps {
  platform: 'google' | 'apple';
  type: 'inapp' | 'subscription';
  id: string;
  /** Google subscriptions: one export per base plan */
  basePlanIds?: string[];
}

const FORMATS: { format: ExportFormat; label: string }[] = [
  { format: 'csv', label: 'CSV' },
  { format: 'json', label: 'JSON' },
];

function filenameFromDisposition(header: string | null): string | null {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] ?? null;
}

// Read-only: downloads a snapshot of current prices via GET /api/export.
export function ExportPricesButton({ platform, type, id, basePlanIds }: ExportPricesButtonProps) {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async (format: ExportFormat, basePlanId?: string) => {
    setIsExporting(true);
    try {
      const params = new URLSearchParams({ platform, type, id, format });
      if (basePlanId) params.set('basePlanId', basePlanId);

      const response = await fetch(`/api/export?${params.toString()}`);
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error || 'Failed to export prices');
      }

      const blob = await response.blob();
      const filename =
        filenameFromDisposition(response.headers.get('Content-Disposition')) ?? `prices.${format}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      toast.success(`Exported prices to ${filename}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to export prices');
    } finally {
      setIsExporting(false);
    }
  };

  const groups: (string | undefined)[] =
    platform === 'google' && type === 'subscription' ? basePlanIds ?? [] : [undefined];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={isExporting || groups.length === 0}>
          {isExporting ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}
          Export prices
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {groups.map((basePlanId, index) => (
          <Fragment key={basePlanId ?? 'default'}>
            {index > 0 && <DropdownMenuSeparator />}
            {basePlanId && (
              <DropdownMenuLabel className="font-mono text-xs">{basePlanId}</DropdownMenuLabel>
            )}
            {FORMATS.map(({ format, label }) => (
              <DropdownMenuItem
                key={format}
                onSelect={() => handleExport(format, basePlanId)}
              >
                {label}
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

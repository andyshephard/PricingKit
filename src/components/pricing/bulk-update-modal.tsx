'use client';

import { useState, useMemo } from 'react';
import { Loader2, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { GOOGLE_PLAY_REGIONS } from '@/lib/google-play/types';

const bulkUpdateFormSchema = z
  .object({
    operationType: z.enum(['percentage', 'fixed', 'round']),
    value: z.number().optional(),
    currency: z.string().optional(),
    roundTo: z.number().min(0).max(0.99).optional(),
    targetRegions: z.array(z.string()).min(1, 'Select at least one region'),
  })
  .superRefine((data, ctx) => {
    if (data.operationType === 'fixed') {
      if (data.value === undefined || data.value < 0) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Enter a price of 0 or more' });
      if (!/^[A-Z]{3}$/.test(data.currency ?? '')) ctx.addIssue({ code: 'custom', path: ['currency'], message: 'Enter a currency code, e.g. USD' });
    }
  });

type BulkUpdateFormData = z.infer<typeof bulkUpdateFormSchema>;

interface BulkUpdateResult {
  id: string;
  basePlanId?: string;
  success: boolean;
  error?: string;
  changes?: Array<{
    regionCode: string;
    oldPrice: string;
    newPrice: string;
  }>;
  skippedRegions?: Array<{ regionCode: string; reason: string }>;
}

interface BulkRequestBody {
  items: Array<{ type: 'product' | 'subscription'; id: string }>;
  operation: { type: BulkUpdateFormData['operationType']; value?: number; currency?: string; roundTo?: number };
  targetRegions: string[];
}

/** The preview's current prices, which the update is confirmed against: a region whose price changed since is left alone */
function expectedPricesFrom(preview: BulkUpdateResult[]): Record<string, Record<string, string>> {
  const expected: Record<string, Record<string, string>> = {};
  for (const r of preview) {
    if (!r.success || !r.changes?.length) continue;
    expected[r.basePlanId ? `${r.id}/${r.basePlanId}` : r.id] = Object.fromEntries(r.changes.map((c) => [c.regionCode, c.oldPrice]));
  }
  return expected;
}

interface BulkUpdateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: 'product' | 'subscription';
  selectedIds: string[];
  onSuccess: () => void;
}

export function BulkUpdateModal({
  open,
  onOpenChange,
  type,
  selectedIds,
  onSuccess,
}: BulkUpdateModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [results, setResults] = useState<BulkUpdateResult[] | null>(null);
  // Step 1 result: what the update would do (nothing written yet), and the request it came from
  const [preview, setPreview] = useState<{ request: BulkRequestBody; results: BulkUpdateResult[] } | null>(null);

  const form = useForm<BulkUpdateFormData>({
    resolver: zodResolver(bulkUpdateFormSchema),
    defaultValues: {
      operationType: 'percentage',
      value: 10,
      currency: 'USD',
      roundTo: 0.99,
      targetRegions: [],
    },
  });

  const operationType = form.watch('operationType');

  const allRegions = useMemo(
    () => GOOGLE_PLAY_REGIONS.map((r) => r.code),
    []
  );

  const handleSelectAllRegions = () => {
    const currentRegions = form.getValues('targetRegions');
    if (currentRegions.length === allRegions.length) {
      form.setValue('targetRegions', []);
    } else {
      form.setValue('targetRegions', allRegions);
    }
  };

  const postBulk = async (body: BulkRequestBody & { dryRun?: boolean; expectedPrices?: Record<string, Record<string, string>> }) => {
    const response = await fetch('/api/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Bulk update failed');
    return result;
  };

  // Step 1: preview. Nothing is written.
  const handlePreview = async (data: BulkUpdateFormData) => {
    setIsSubmitting(true);
    setResults(null);
    setPreview(null);
    try {
      const request: BulkRequestBody = {
        // No basePlanId: /api/bulk expands each subscription to all of its
        // base plans and returns one result per base plan
        items: selectedIds.map((id) => ({ type, id })),
        operation: {
          type: data.operationType,
          value: data.operationType === 'round' ? undefined : data.value,
          currency: data.operationType === 'fixed' ? data.currency?.trim().toUpperCase() : undefined,
          roundTo: data.operationType === 'round' ? data.roundTo : undefined,
        },
        targetRegions: data.targetRegions,
      };
      const result = await postBulk({ ...request, dryRun: true });
      setPreview({ request, results: result.results });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Preview failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Step 2: apply what the preview showed, confirmed against its current prices
  const handleApply = async () => {
    if (!preview) return;
    setIsSubmitting(true);
    try {
      const result = await postBulk({ ...preview.request, expectedPrices: expectedPricesFrom(preview.results) });
      setPreview(null);
      setResults(result.results);

      // Subscription results are per base plan
      const unit = type === 'product' ? 'item' : 'base plan';

      const skippedRegions: number = result.skippedRegions ?? 0;
      const skippedNote = skippedRegions > 0
        ? `, ${skippedRegions} region${skippedRegions !== 1 ? 's' : ''} skipped`
        : '';

      if (result.successful === 0) {
        // Never report "Successfully updated 0 items"
        toast.error(
          `No ${unit}s were updated (${result.failed} failed${skippedNote})`
        );
      } else if (result.failed > 0) {
        toast.warning(
          `Updated ${result.successful} ${unit}s, ${result.failed} failed${skippedNote}`
        );
        onSuccess();
      } else if (skippedRegions > 0) {
        toast.warning(`Updated ${result.successful} ${unit}s${skippedNote}`);
        onSuccess();
      } else {
        toast.success(`Successfully updated ${result.successful} ${unit}s`);
        onSuccess();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Bulk update failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const previewChanges = preview?.results.reduce((n, r) => n + (r.success ? r.changes?.length ?? 0 : 0), 0) ?? 0;
  const shown = results ?? preview?.results ?? null;

  const handleClose = () => {
    setResults(null);
    setPreview(null);
    form.reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Bulk Update Prices</DialogTitle>
          <DialogDescription>
            Update prices for {selectedIds.length} selected{' '}
            {type === 'product'
              ? 'products'
              : 'subscriptions (all base plans of each)'}
          </DialogDescription>
        </DialogHeader>

        {shown ? (
          <div className="flex-1 overflow-hidden">
            {preview && (
              <p className="mb-2 text-sm text-muted-foreground">
                Preview: nothing has changed yet. {previewChanges} region price{previewChanges === 1 ? '' : 's'} will change. Each is applied only if
                its price is still the one shown here.
              </p>
            )}
            <ScrollArea className="h-[400px] pr-4">
              <div className="space-y-3">
                {shown.map((result, index) => (
                  <div
                    key={`${result.id}-${result.basePlanId || index}`}
                    className={`p-3 rounded-lg border ${
                      result.success && !preview
                        ? 'bg-green-50 border-green-200 dark:bg-green-950/20 dark:border-green-900'
                        : 'bg-red-50 border-red-200 dark:bg-red-950/20 dark:border-red-900'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      {preview ? (
                        result.success ? <CheckCircle2 className="h-4 w-4 text-muted-foreground" /> : <XCircle className="h-4 w-4 text-red-600" />
                      ) : result.success ? (
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-600" />
                      )}
                      <span className="font-mono text-sm">{result.id}</span>
                      {result.basePlanId && (
                        <Badge variant="outline" className="text-xs">
                          {result.basePlanId}
                        </Badge>
                      )}
                    </div>
                    {result.error && (
                      <p className="text-sm text-red-600">{result.error}</p>
                    )}
                    {result.skippedRegions && result.skippedRegions.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {result.skippedRegions.map((skipped) => (
                          <div
                            key={skipped.regionCode}
                            className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-500"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            <Badge variant="outline">{skipped.regionCode}</Badge>
                            <span>Skipped: {skipped.reason}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {result.changes && result.changes.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {result.changes.map((change) => (
                          <div
                            key={change.regionCode}
                            className="flex items-center gap-2 text-xs"
                          >
                            <Badge variant="outline">{change.regionCode}</Badge>
                            <span className="text-muted-foreground line-through">
                              {change.oldPrice}
                            </span>
                            <span className="text-green-600">
                              {change.newPrice}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        ) : (
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(handlePreview)}
              className="space-y-4"
            >
              <FormField
                control={form.control}
                name="operationType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Operation Type</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select operation" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="percentage">
                          Percentage Change
                        </SelectItem>
                        <SelectItem value="fixed">Set Fixed Price</SelectItem>
                        <SelectItem value="round">Round to .99</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      {operationType === 'percentage' &&
                        'Increase or decrease prices by a percentage'}
                      {operationType === 'fixed' &&
                        'Set the selected prices billed in one currency to a fixed value'}
                      {operationType === 'round' &&
                        'Round prices down to the nearest whole number plus decimal'}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {operationType === 'percentage' && (
                <FormField
                  control={form.control}
                  name="value"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Percentage Change</FormLabel>
                      <FormControl>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            step="0.1"
                            {...field}
                            className="w-32"
                          />
                          <span className="text-sm text-muted-foreground">
                            %
                          </span>
                        </div>
                      </FormControl>
                      <FormDescription>
                        Use positive values to increase, negative to decrease
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {operationType === 'fixed' && (
                <FormField
                  control={form.control}
                  name="value"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Fixed Price</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          {...field}
                          className="w-32"
                        />
                      </FormControl>
                      <FormDescription>
                        Regions billed in this currency get this price; others are left alone
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {operationType === 'fixed' && (
                <FormField
                  control={form.control}
                  name="currency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Currency</FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value.toUpperCase())} maxLength={3} className="w-24 font-mono" />
                      </FormControl>
                      <FormDescription>ISO 4217 code, e.g. USD. A fixed price is never converted to other currencies.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {operationType === 'round' && (
                <FormField
                  control={form.control}
                  name="roundTo"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Round to Decimal</FormLabel>
                      <FormControl>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-muted-foreground">
                            X.
                          </span>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            max="0.99"
                            {...field}
                            className="w-24"
                          />
                        </div>
                      </FormControl>
                      <FormDescription>
                        Prices are rounded down to the nearest whole number plus
                        this decimal, so they never go up (e.g., $5.00 becomes
                        $4.99). Currencies without decimals (JPY, KRW, ...) round
                        down to a 9 / 90 ending instead.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={form.control}
                name="targetRegions"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between">
                      <FormLabel>Target Regions</FormLabel>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleSelectAllRegions}
                      >
                        {field.value.length === allRegions.length
                          ? 'Deselect All'
                          : 'Select All'}
                      </Button>
                    </div>
                    <FormControl>
                      <ScrollArea className="h-48 rounded-md border p-4">
                        <div className="grid grid-cols-2 gap-2">
                          {GOOGLE_PLAY_REGIONS.map((region) => (
                            <div
                              key={region.code}
                              className="flex items-center space-x-2"
                            >
                              <Checkbox
                                id={region.code}
                                checked={field.value.includes(region.code)}
                                onCheckedChange={(checked) => {
                                  if (checked) {
                                    field.onChange([
                                      ...field.value,
                                      region.code,
                                    ]);
                                  } else {
                                    field.onChange(
                                      field.value.filter(
                                        (v) => v !== region.code
                                      )
                                    );
                                  }
                                }}
                              />
                              <Label
                                htmlFor={region.code}
                                className="text-sm cursor-pointer"
                              >
                                {region.code} - {region.name}
                              </Label>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </FormControl>
                    <FormDescription>
                      {field.value.length} regions selected
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </form>
          </Form>
        )}

        <DialogFooter>
          {results ? (
            <Button onClick={handleClose}>Close</Button>
          ) : preview ? (
            <>
              <Button variant="outline" onClick={() => setPreview(null)} disabled={isSubmitting}>
                Back
              </Button>
              <Button onClick={handleApply} disabled={isSubmitting || previewChanges === 0}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Applying...
                  </>
                ) : (
                  `Apply ${previewChanges} change${previewChanges === 1 ? '' : 's'}`
                )}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                onClick={form.handleSubmit(handlePreview)}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Previewing...
                  </>
                ) : (
                  'Preview changes'
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

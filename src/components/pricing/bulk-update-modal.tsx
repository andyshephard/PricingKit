'use client';

import { useState, useMemo } from 'react';
import { Loader2, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
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

const bulkUpdateFormSchema = z.object({
  operationType: z.enum(['percentage', 'fixed', 'round']),
  value: z.number().optional(),
  roundTo: z.number().min(0).max(0.99).optional(),
  targetRegions: z.array(z.string()).min(1, 'Select at least one region'),
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

  const form = useForm<BulkUpdateFormData>({
    resolver: zodResolver(bulkUpdateFormSchema),
    defaultValues: {
      operationType: 'percentage',
      value: 10,
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

  const handleSubmit = async (data: BulkUpdateFormData) => {
    setIsSubmitting(true);
    setResults(null);

    try {
      const items = selectedIds.map((id) => ({
        type,
        id,
        // For subscriptions, we'd need to handle base plans
        // This simplified version targets all base plans
      }));

      const response = await fetch('/api/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          operation: {
            type: data.operationType,
            value: data.operationType === 'round' ? undefined : data.value,
            roundTo: data.operationType === 'round' ? data.roundTo : undefined,
          },
          targetRegions: data.targetRegions,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Bulk update failed');
      }

      setResults(result.results);

      if (result.failed === 0) {
        toast.success(`Successfully updated ${result.successful} items`);
        onSuccess();
      } else {
        toast.warning(
          `Updated ${result.successful} items, ${result.failed} failed`
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Bulk update failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setResults(null);
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
            {type === 'product' ? 'products' : 'subscriptions'}
          </DialogDescription>
        </DialogHeader>

        {results ? (
          <div className="flex-1 overflow-hidden">
            <ScrollArea className="h-[400px] pr-4">
              <div className="space-y-3">
                {results.map((result, index) => (
                  <div
                    key={`${result.id}-${result.basePlanId || index}`}
                    className={`p-3 rounded-lg border ${
                      result.success
                        ? 'bg-green-50 border-green-200 dark:bg-green-950/20 dark:border-green-900'
                        : 'bg-red-50 border-red-200 dark:bg-red-950/20 dark:border-red-900'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      {result.success ? (
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
              onSubmit={form.handleSubmit(handleSubmit)}
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
                        'Set all selected prices to a fixed value'}
                      {operationType === 'round' &&
                        'Round prices to the nearest whole number plus decimal'}
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
                        All selected prices will be set to this value
                      </FormDescription>
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
                        Prices will be rounded to the nearest whole number plus
                        this decimal (e.g., $4.99)
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
          ) : (
            <>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                onClick={form.handleSubmit(handleSubmit)}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Updating...
                  </>
                ) : (
                  'Apply Changes'
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

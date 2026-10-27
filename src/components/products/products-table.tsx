'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import {
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  MoreHorizontal,
  Edit,
  Globe,
} from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import type { InAppProduct } from '@/lib/google-play/types';
import { formatMoney } from '@/lib/google-play/types';
import { getProductDetailRoute, type Platform } from '@/lib/utils/platform-routes';

type SortField = 'sku' | 'status' | 'price' | 'regions' | 'type';
type SortOrder = 'asc' | 'desc';

interface ProductsTableProps {
  products: InAppProduct[];
  isLoading?: boolean;
  selectedSkus: string[];
  onSelectionChange: (skus: string[]) => void;
  searchQuery: string;
  platform: Platform;
}

function getProductTitle(product: InAppProduct): string {
  const defaultListing = product.listings?.[product.defaultLanguage];
  return defaultListing?.title || product.sku;
}

function getRegionCount(product: InAppProduct): number {
  return Object.keys(product.prices || {}).length;
}

function SortIcon({
  field,
  sortField,
  sortOrder,
}: {
  field: SortField;
  sortField: SortField;
  sortOrder: SortOrder;
}) {
  if (sortField !== field) {
    return <ChevronsUpDown className="ml-1 h-4 w-4" />;
  }
  return sortOrder === 'asc' ? (
    <ChevronUp className="ml-1 h-4 w-4" />
  ) : (
    <ChevronDown className="ml-1 h-4 w-4" />
  );
}

export function ProductsTable({
  products,
  isLoading,
  selectedSkus,
  onSelectionChange,
  searchQuery,
  platform,
}: ProductsTableProps) {
  const [sortField, setSortField] = useState<SortField>('sku');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  const filteredProducts = useMemo(() => {
    if (!searchQuery.trim()) return products;

    const query = searchQuery.toLowerCase();
    return products.filter(
      (product) =>
        product.sku.toLowerCase().includes(query) ||
        getProductTitle(product).toLowerCase().includes(query)
    );
  }, [products, searchQuery]);

  const sortedProducts = useMemo(() => {
    return [...filteredProducts].sort((a, b) => {
      let comparison = 0;

      switch (sortField) {
        case 'sku':
          comparison = a.sku.localeCompare(b.sku);
          break;
        case 'status':
          comparison = a.status.localeCompare(b.status);
          break;
        case 'price':
          const priceA = parseFloat(a.defaultPrice?.units || '0');
          const priceB = parseFloat(b.defaultPrice?.units || '0');
          comparison = priceA - priceB;
          break;
        case 'regions':
          comparison = getRegionCount(a) - getRegionCount(b);
          break;
        case 'type':
          comparison = (a.purchaseType || '').localeCompare(b.purchaseType || '');
          break;
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });
  }, [filteredProducts, sortField, sortOrder]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const handleSelectAll = () => {
    if (selectedSkus.length === sortedProducts.length) {
      onSelectionChange([]);
    } else {
      onSelectionChange(sortedProducts.map((p) => p.sku));
    }
  };

  const handleSelectOne = (sku: string) => {
    if (selectedSkus.includes(sku)) {
      onSelectionChange(selectedSkus.filter((s) => s !== sku));
    } else {
      onSelectionChange([...selectedSkus, sku]);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (sortedProducts.length === 0) {
    return (
      <div className="rounded-2xl border bg-card py-12 text-center">
        <p className="text-muted-foreground">
          {searchQuery
            ? 'No products match your search'
            : 'No products found'}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border bg-card [&_thead_tr]:bg-muted/40 [&_thead_tr]:hover:bg-muted/40">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">
              <Checkbox
                checked={
                  selectedSkus.length === sortedProducts.length &&
                  sortedProducts.length > 0
                }
                onCheckedChange={handleSelectAll}
                aria-label="Select all"
              />
            </TableHead>
            <TableHead>
              <Button
                variant="ghost"
                className="h-auto p-0 font-semibold hover:bg-transparent"
                onClick={() => handleSort('sku')}
              >
                SKU / Name
                <SortIcon field="sku" sortField={sortField} sortOrder={sortOrder} />
              </Button>
            </TableHead>
            <TableHead>
              <Button
                variant="ghost"
                className="h-auto p-0 font-semibold hover:bg-transparent"
                onClick={() => handleSort('status')}
              >
                Status
                <SortIcon field="status" sortField={sortField} sortOrder={sortOrder} />
              </Button>
            </TableHead>
            {platform !== 'apple' && (
              <TableHead>
                <Button
                  variant="ghost"
                  className="h-auto p-0 font-semibold hover:bg-transparent"
                  onClick={() => handleSort('price')}
                >
                  Base Price{products[0]?.defaultPrice?.currencyCode ? ` (${products[0].defaultPrice.currencyCode})` : ''}
                  <SortIcon field="price" sortField={sortField} sortOrder={sortOrder} />
                </Button>
              </TableHead>
            )}
            {platform !== 'apple' && (
              <TableHead>
                <Button
                  variant="ghost"
                  className="h-auto p-0 font-semibold hover:bg-transparent"
                  onClick={() => handleSort('regions')}
                >
                  Regions
                  <SortIcon field="regions" sortField={sortField} sortOrder={sortOrder} />
                </Button>
              </TableHead>
            )}
            <TableHead className="w-12"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedProducts.map((product) => {
            const detailHref = getProductDetailRoute(platform, product.sku);

            return (
              <TableRow
                key={product.sku}
                className={
                  selectedSkus.includes(product.sku) ? 'bg-muted/50' : ''
                }
              >
                <TableCell>
                  <Checkbox
                    checked={selectedSkus.includes(product.sku)}
                    onCheckedChange={() => handleSelectOne(product.sku)}
                    aria-label={`Select ${product.sku}`}
                  />
                </TableCell>
                <TableCell>
                  <Link
                    href={detailHref}
                    className="group rounded-md"
                  >
                    <div className="font-bold text-foreground group-hover:text-link">{getProductTitle(product)}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {product.sku}
                    </div>
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={product.status === 'active' ? 'success' : 'secondary'}
                    className="capitalize"
                  >
                    {product.status}
                  </Badge>
                </TableCell>
                {/* Price and regions columns are Google-only, as in the header */}
                {platform !== 'apple' && (
                  <TableCell className="font-mono">
                    {product.defaultPrice && product.defaultPrice.units !== '0' ? (
                      formatMoney(product.defaultPrice)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                )}
                {platform !== 'apple' && (
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Globe className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      <span>{getRegionCount(product)}</span>
                    </div>
                  </TableCell>
                )}
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon">
                        <MoreHorizontal className="h-4 w-4" />
                        <span className="sr-only">Actions for {product.sku}</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link href={detailHref}>
                          <Edit className="mr-2 h-4 w-4" />
                          Edit Pricing
                        </Link>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

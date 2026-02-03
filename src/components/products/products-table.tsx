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
import { useAuthStore } from '@/store/auth-store';

type SortField = 'sku' | 'status' | 'price' | 'regions' | 'type';
type SortOrder = 'asc' | 'desc';

interface ProductsTableProps {
  products: InAppProduct[];
  isLoading?: boolean;
  selectedSkus: string[];
  onSelectionChange: (skus: string[]) => void;
  searchQuery: string;
}

function getProductTitle(product: InAppProduct): string {
  const defaultListing = product.listings?.[product.defaultLanguage];
  return defaultListing?.title || product.sku;
}

function getRegionCount(product: InAppProduct): number {
  return Object.keys(product.prices || {}).length;
}

function formatProductType(type?: string): string {
  if (!type) return '—';
  // Apple types: CONSUMABLE, NON_CONSUMABLE, NON_RENEWING_SUBSCRIPTION
  // Google types: managedUser, subscription
  const typeMap: Record<string, string> = {
    CONSUMABLE: 'Consumable',
    NON_CONSUMABLE: 'Non-Consumable',
    NON_RENEWING_SUBSCRIPTION: 'Non-Renewing',
    managedUser: 'Managed',
    subscription: 'Subscription',
  };
  return typeMap[type] || type;
}

export function ProductsTable({
  products,
  isLoading,
  selectedSkus,
  onSelectionChange,
  searchQuery,
}: ProductsTableProps) {
  const platform = useAuthStore((state) => state.platform);
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

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <ChevronsUpDown className="ml-1 h-4 w-4" />;
    }
    return sortOrder === 'asc' ? (
      <ChevronUp className="ml-1 h-4 w-4" />
    ) : (
      <ChevronDown className="ml-1 h-4 w-4" />
    );
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
      <div className="text-center py-12">
        <p className="text-muted-foreground">
          {searchQuery
            ? 'No products match your search'
            : 'No products found'}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border">
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
                <SortIcon field="sku" />
              </Button>
            </TableHead>
            <TableHead>
              <Button
                variant="ghost"
                className="h-auto p-0 font-semibold hover:bg-transparent"
                onClick={() => handleSort('status')}
              >
                Status
                <SortIcon field="status" />
              </Button>
            </TableHead>
            <TableHead>
              <Button
                variant="ghost"
                className="h-auto p-0 font-semibold hover:bg-transparent"
                onClick={() => handleSort('price')}
              >
                Base Price{products[0]?.defaultPrice?.currencyCode ? ` (${products[0].defaultPrice.currencyCode})` : ''}
                <SortIcon field="price" />
              </Button>
            </TableHead>
            <TableHead>
              <Button
                variant="ghost"
                className="h-auto p-0 font-semibold hover:bg-transparent"
                onClick={() => handleSort('regions')}
              >
                Regions
                <SortIcon field="regions" />
              </Button>
            </TableHead>
            <TableHead className="w-12"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedProducts.map((product) => (
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
                  href={`/dashboard/products/${encodeURIComponent(product.sku)}`}
                  className="hover:underline"
                >
                  <div className="font-medium">{getProductTitle(product)}</div>
                  <div className="text-sm text-muted-foreground font-mono">
                    {product.sku}
                  </div>
                </Link>
              </TableCell>
              <TableCell>
                <Badge
                  variant={product.status === 'active' ? 'default' : 'secondary'}
                >
                  {product.status}
                </Badge>
              </TableCell>
              <TableCell>
                {product.defaultPrice && product.defaultPrice.units !== '0' ? (
                  formatMoney(product.defaultPrice)
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                {platform === 'apple' ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <div className="flex items-center gap-1">
                    <Globe className="h-4 w-4 text-muted-foreground" />
                    <span>{getRegionCount(product)}</span>
                  </div>
                )}
              </TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon">
                      <MoreHorizontal className="h-4 w-4" />
                      <span className="sr-only">Actions</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                      <Link
                        href={`/dashboard/products/${encodeURIComponent(product.sku)}`}
                      >
                        <Edit className="mr-2 h-4 w-4" />
                        Edit Pricing
                      </Link>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

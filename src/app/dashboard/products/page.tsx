'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Header } from '@/components/layout';
import { ProductsTable } from '@/components/products/products-table';
import { BulkUpdateModal } from '@/components/pricing/bulk-update-modal';
import { Button } from '@/components/ui/button';
import { useProducts } from '@/hooks/use-products';
import { useSelectionStore } from '@/store/selection-store';

export default function ProductsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [bulkModalOpen, setBulkModalOpen] = useState(false);

  const { data, isLoading, refetch, isRefetching, error } = useProducts();
  const { selectedProductSkus, setSelectedProducts } = useSelectionStore();

  if (error) {
    toast.error(error.message);
  }

  const products = data?.products || [];

  return (
    <div className="flex flex-col h-full">
      <Header
        onRefresh={() => refetch()}
        isRefreshing={isRefetching}
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
      />

      <div className="flex-1 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">In-App Products</h1>
            <p className="text-muted-foreground">
              Manage pricing for one-time purchase products
            </p>
          </div>

          {selectedProductSkus.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                {selectedProductSkus.length} selected
              </span>
              <Button onClick={() => setBulkModalOpen(true)}>
                Bulk Update Prices
              </Button>
              <Button
                variant="outline"
                onClick={() => setSelectedProducts([])}
              >
                Clear Selection
              </Button>
            </div>
          )}
        </div>

        <ProductsTable
          products={products}
          isLoading={isLoading}
          selectedSkus={selectedProductSkus}
          onSelectionChange={setSelectedProducts}
          searchQuery={searchQuery}
        />
      </div>

      <BulkUpdateModal
        open={bulkModalOpen}
        onOpenChange={setBulkModalOpen}
        type="product"
        selectedIds={selectedProductSkus}
        onSuccess={() => {
          setSelectedProducts([]);
          refetch();
        }}
      />
    </div>
  );
}

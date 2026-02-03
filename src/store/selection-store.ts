import { create } from 'zustand';

interface SelectionState {
  selectedProductSkus: string[];
  selectedSubscriptionIds: string[];
  setSelectedProducts: (skus: string[]) => void;
  setSelectedSubscriptions: (ids: string[]) => void;
  clearSelection: () => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  selectedProductSkus: [],
  selectedSubscriptionIds: [],
  setSelectedProducts: (skus) => set({ selectedProductSkus: skus }),
  setSelectedSubscriptions: (ids) => set({ selectedSubscriptionIds: ids }),
  clearSelection: () =>
    set({ selectedProductSkus: [], selectedSubscriptionIds: [] }),
}));

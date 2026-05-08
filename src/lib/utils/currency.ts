// Helper to get the currency symbol for a currency code (e.g. "GBP" → "£").
export function getCurrencySymbol(currencyCode: string): string {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency: currencyCode })
        .formatToParts(0)
        .find((part) => part.type === 'currency')?.value || currencyCode
    );
  } catch {
    return currencyCode;
  }
}

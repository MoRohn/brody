export interface LineItem {
  sku: string;
  unitPrice: number;
  quantity: number;
}

/** Sum the line items and apply sales tax. Prices are floating point dollars. */
export function calculateTotal(items: LineItem[], taxRate = 0.08): number {
  let total = 0;
  for (const item of items) {
    total += item.unitPrice * item.quantity;
  }
  return total * (1 + taxRate);
}

/** Convert a dollar amount to integer cents for the payment provider. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

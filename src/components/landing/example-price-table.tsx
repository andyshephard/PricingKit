/**
 * The landing page's illustrative price table. The figures are examples, not
 * live data, and the caption says so.
 */
const ROWS = [
  { country: 'United States', before: '$49.99', after: '$49.99', change: '—' },
  { country: 'United Kingdom', before: '£44.99', after: '£39.99', change: '-11%' },
  { country: 'Germany', before: '€49.99', after: '€42.99', change: '-14%' },
  { country: 'Brazil', before: 'R$249.90', after: 'R$139.90', change: '-44%' },
  { country: 'India', before: '₹4,499', after: '₹1,799', change: '-60%' },
  { country: 'Japan', before: '¥7,800', after: '¥6,800', change: '-13%' },
] as const;

const STRATEGIES = ['PPP', 'Big Mac', 'Netflix'] as const;

export function ExamplePriceTable() {
  return (
    <figure className="overflow-hidden rounded-[18px] border bg-card shadow-[var(--shadow-panel)]">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-5 py-[18px] sm:px-6">
        <div>
          <p className="font-bold">Annual subscription</p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Purchasing power parity from US $49.99 · example</p>
        </div>
        <ul aria-label="Pricing strategies" className="flex gap-2 text-[13px]">
          {STRATEGIES.map((s, i) => (
            <li
              key={s}
              className={
                i === 0
                  ? 'rounded-full bg-accent px-2.5 py-1.5 font-semibold text-accent-foreground'
                  : 'rounded-full bg-chip px-2.5 py-1.5 text-chip-foreground'
              }
            >
              {s}
              {i === 0 && <span className="sr-only"> (shown)</span>}
            </li>
          ))}
        </ul>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[15px]">
          <caption className="sr-only">Example prices before and after PricingKit, by country</caption>
          <thead>
            <tr className="text-left text-[13px] text-muted-foreground">
              <th scope="col" className="px-5 py-3 font-semibold sm:px-6">Country</th>
              <th scope="col" className="px-5 py-3 font-semibold sm:px-6">Today</th>
              <th scope="col" className="px-5 py-3 font-semibold sm:px-6">PricingKit</th>
              <th scope="col" className="px-5 py-3 font-semibold sm:px-6">Change</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.country} className="border-t border-line">
                <th scope="row" className="px-5 py-3 text-left font-semibold whitespace-nowrap sm:px-6">
                  {r.country}
                </th>
                <td className="px-5 py-3 font-mono text-muted-foreground sm:px-6">{r.before}</td>
                <td className="px-5 py-3 font-mono font-medium sm:px-6">{r.after}</td>
                <td className="px-5 py-3 font-mono text-change sm:px-6">{r.change}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption className="border-t border-line px-5 py-3.5 text-[13px] text-muted-foreground sm:px-6">
        Example prices for illustration. Every price is a valid store price point for that country.
      </figcaption>
    </figure>
  );
}

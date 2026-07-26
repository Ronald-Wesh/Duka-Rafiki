import type { Statement } from "../core/types";
import type { DailyTotal } from "./statement-queries";

// Server-rendered HTML. No template engine, no chart library, no new
// dependency. Print CSS included so the owner can save a PDF from the
// browser if a lender wants a file.

/** The full snapshot stored in statements.summary_json at generation time. */
export interface StatementSnapshot {
  metrics: Omit<Statement, "id" | "generated_at">;
  dailySales: DailyTotal[];
  daysWithActivity: number;
  daysInPeriod: number;
  daysClosed: number;
  deniRepaymentRate: number;
  unconfirmedSales: number;
  narrative: string;
}

const kes = (n: number) =>
  `KES ${n.toLocaleString("en-KE", { maximumFractionDigits: 0 })}`;
const pct = (rate: number) => `${Math.round(rate * 100)}%`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One bar per day of sales. Raw SVG, no chart library. */
function salesChart(daily: DailyTotal[]): string {
  if (daily.length === 0) {
    return `<p class="muted">No sales logged in this period.</p>`;
  }

  const width = 680;
  const height = 140;
  const gap = 2;
  const max = Math.max(...daily.map((d) => d.total));
  const barWidth = Math.max(2, (width - gap * (daily.length - 1)) / daily.length);

  const bars = daily
    .map((d, i) => {
      const barHeight = max === 0 ? 0 : Math.max(1, (d.total / max) * (height - 20));
      const x = i * (barWidth + gap);
      const y = height - barHeight;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="1"><title>${escapeHtml(d.date)}: ${kes(d.total)}</title></rect>`;
    })
    .join("");

  return `
    <svg viewBox="0 0 ${width} ${height}" class="chart" role="img"
         aria-label="Daily sales from ${escapeHtml(daily[0].date)} to ${escapeHtml(daily[daily.length - 1].date)}">
      ${bars}
    </svg>
    <div class="chart-axis"><span>${escapeHtml(daily[0].date)}</span><span>peak ${kes(max)}</span><span>${escapeHtml(daily[daily.length - 1].date)}</span></div>`;
}

export function renderStatementPage(statement: Statement): string {
  const snapshot = JSON.parse(statement.summary_json) as StatementSnapshot;
  const m = snapshot.metrics;

  const rows: Array<[string, string]> = [
    ["Total sales", kes(m.total_sales)],
    ["Estimated margin (sales less stock purchases)", kes(m.estimated_margin)],
    ["Outstanding receivables (deni owed to the trader)", kes(m.outstanding_receivables)],
    ["Deni repayment rate", pct(snapshot.deniRepaymentRate)],
    ["Days reconciled within KES 50", pct(m.reconciliation_accuracy)],
    ["Days with logged activity", `${snapshot.daysWithActivity} of ${snapshot.daysInPeriod}`],
  ];

  const tableRows = rows
    .map(([label, value]) => `<tr><td>${label}</td><td class="num">${value}</td></tr>`)
    .join("");

  const accuracyNote =
    snapshot.daysClosed === 0
      ? `<p class="muted">No days were closed in this period, so no reconciliation figure is available.</p>`
      : `<p class="muted">Based on ${snapshot.daysClosed} day${snapshot.daysClosed === 1 ? "" : "s"} the owner closed and counted.</p>`;

  const unconfirmedNote =
    snapshot.unconfirmedSales > 0
      ? `<p class="muted">Of total sales, ${kes(snapshot.unconfirmedSales)} is self-reported and not yet confirmed.</p>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transaction Record — ${escapeHtml(m.period_start)} to ${escapeHtml(m.period_end)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
         margin: 0; padding: 28px 20px; color: #16181d; background: #f6f7f9; }
  main { max-width: 720px; margin: 0 auto; background: #fff; padding: 32px;
         border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -.01em; }
  .period { color: #5b6270; margin: 0 0 24px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 20px; }
  td { padding: 11px 0; border-bottom: 1px solid #eceef1; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .06em;
       color: #5b6270; margin: 28px 0 8px; }
  .chart { width: 100%; height: auto; }
  .chart rect { fill: #2f6f4f; }
  .chart-axis { display: flex; justify-content: space-between;
                font-size: 12px; color: #5b6270; margin-top: 6px; }
  .muted { color: #5b6270; font-size: 14px; margin: 6px 0; }
  .summary { background: #f2f6f4; border-left: 3px solid #2f6f4f;
             padding: 14px 16px; border-radius: 0 6px 6px 0; margin: 8px 0 0; }
  footer { margin-top: 28px; padding-top: 16px; border-top: 1px solid #eceef1;
           font-size: 12px; color: #6b7280; }
  @media print {
    body { background: #fff; padding: 0; }
    main { box-shadow: none; padding: 0; max-width: none; }
  }
</style>
</head>
<body>
<main>
  <h1>Transaction Record</h1>
  <p class="period">${escapeHtml(m.period_start)} to ${escapeHtml(m.period_end)} &middot; generated ${escapeHtml(statement.generated_at)}</p>

  <table>${tableRows}</table>

  <h2>Daily sales</h2>
  ${salesChart(snapshot.dailySales)}
  <p class="muted">${escapeHtml(m.cashflow_consistency_note)}</p>
  ${accuracyNote}
  ${unconfirmedNote}

  <h2>Summary</h2>
  <p class="summary">${escapeHtml(snapshot.narrative)}</p>

  <footer>
    This is a record of transactions logged by the trader over the stated period.
    It is a descriptive record, not an assessment, and every figure above is
    computed directly from the underlying entries.
  </footer>
</main>
</body>
</html>`;
}

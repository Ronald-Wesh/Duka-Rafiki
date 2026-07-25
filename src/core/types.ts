// Shared types — pillars extend by asking P1/P0 to add fields here, not by
// reaching into the DB with ad-hoc queries (README section 9).

export interface Customer {
  id: number;
  name: string | null;
  phone: string | null;
  disambiguator: string | null;
  first_seen: string | null;
  last_seen: string | null;
}

export type TransactionType = "sale" | "deni" | "deni_repayment" | "restock";
export type Channel = "mpesa_buygoods" | "cash";

export interface Transaction {
  id: number;
  customer_id: number | null;
  type: TransactionType;
  amount: number;
  channel: Channel;
  confirmed: 0 | 1;
  raw_input: string | null;
  created_at: string;
}

export interface DailyReconciliation {
  id: number;
  date: string;
  expected_total: number;
  reported_total: number;
  variance: number;
  notes: string | null;
}

export interface ReconciliationResult {
  date: string;
  expected_total: number;
  reported_total: number;
  variance: number;
  notes?: string;
}

export interface Statement {
  id: number;
  generated_at: string;
  period_start: string;
  period_end: string;
  total_sales: number;
  estimated_margin: number;
  cashflow_consistency_note: string;
  outstanding_receivables: number;
  reconciliation_accuracy: number;
  summary_json: string;
}

// Parsed shape from an M-Pesa Buy Goods/Pochi SMS (P1 parse-mpesa-sms.ts).
export interface ParsedMpesaSms {
  amount: number;
  payer_name: string;
  till: string;
  timestamp: string;
}

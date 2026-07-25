/**
 * P2 — Retention: the seam other pillars call.
 *
 * Everything else in this folder is a pure function that takes ledger rows. This
 * file is the one place that reads the database, reads the clock, and decides
 * whether Claude is available — so the router can get a sendable WhatsApp
 * message from a single call and does not have to know how retention works.
 *
 * The impure bits are deliberately concentrated here rather than sprinkled
 * through the calculation modules, which is what keeps those unit-testable
 * offline (`smoke-check.ts` never imports this file).
 */

import { config } from '../core/config';
import {
  buildCustomerProfiles,
  canonicalizeCustomers,
  EAT_UTC_OFFSET_HOURS,
  findDuplicateCandidates,
  REPEAT_VISIT_THRESHOLD,
} from './customer-profile';
import {
  type DraftResult,
  draftRegularsSummary,
  draftWinBackPromo,
  type PromoDraftResult,
  type PromptRunner,
} from './promo-drafts';
import {
  loadCustomers,
  loadLedger,
  loadTransactionsForCustomer,
  type NaiveTimestampZone,
} from './queries';
import { buildRegularsSummary, detectRepeatVisit } from './repeat-detection';
import type { CustomerMerge, DuplicateCandidate, RegularsSummary } from './types';

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/**
 * Today's date in EAT, `YYYY-MM-DD`.
 *
 * The only clock read in the pillar. Every calculation takes `asOfDateKey` as an
 * argument so it stays reproducible; this is where a real "now" enters, and it is
 * injectable so a demo can pin the date.
 */
export function todayInEat(now: Date = new Date()): string {
  return new Date(now.getTime() + EAT_UTC_OFFSET_HOURS * 3_600_000)
    .toISOString()
    .slice(0, 10);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RetentionOptions {
  /** EAT `YYYY-MM-DD`. Defaults to today in Nairobi. */
  asOfDateKey?: string;
  windowDays?: number;
  limit?: number;
  includeUnconfirmed?: boolean;
  naiveTimestampZone?: NaiveTimestampZone;
  /**
   * Collapse same-name customer rows for presentation. Default `true`.
   *
   * P1 upserts on exact name, so one human paying twice with different SMS casing
   * becomes two rows and appears twice in the regulars list with her visits split.
   * This is a read-time remap only — nothing is written. Set `false` to see the
   * raw rows. See `canonicalizeCustomers`.
   */
  mergeDuplicateNames?: boolean;
}

export interface RegularsSummaryResult {
  summary: RegularsSummary;
  /** Customer rows folded together for presentation. Empty when none were. */
  merges: CustomerMerge[];
}

// ---------------------------------------------------------------------------
// Claude availability
// ---------------------------------------------------------------------------

/**
 * Resolve `askClaude`, or `undefined` if the model can't be used.
 *
 * Imported lazily and behind a key check because `core/claude-client` constructs
 * an `Anthropic` instance at module load. Importing it without a key would throw
 * during startup, which would take out the whole reply rather than just the
 * phrasing — and phrasing is the one part of this pillar that has a working
 * fallback.
 */
export async function resolvePromptRunner(): Promise<PromptRunner | undefined> {
  if (!config.anthropicApiKey) {
    console.log('[p2] ANTHROPIC_API_KEY not set — using deterministic phrasing');
    return undefined;
  }
  try {
    const { askClaude } = await import('../core/claude-client');
    return askClaude;
  } catch (err) {
    console.error('[p2] claude-client unavailable, falling back to plain text:', err);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** Read the ledger and compute the weekly regulars figures. No model, no writes. */
export function getRegularsSummary(options: RetentionOptions = {}): RegularsSummaryResult {
  const {
    asOfDateKey = todayInEat(),
    windowDays,
    limit,
    includeUnconfirmed,
    naiveTimestampZone,
    mergeDuplicateNames = true,
  } = options;

  const raw = loadLedger({ naiveTimestampZone });
  const ledger = mergeDuplicateNames
    ? canonicalizeCustomers(raw.customers, raw.transactions)
    : { ...raw, merges: [] as CustomerMerge[] };

  const summary = buildRegularsSummary(ledger.customers, ledger.transactions, {
    asOfDateKey,
    windowDays,
    limit,
    includeUnconfirmed,
  });

  return { summary, merges: ledger.merges };
}

export interface WeeklyRegularsMessage extends RegularsSummaryResult {
  /** The message to send the owner. Always non-empty. */
  text: string;
  /** How `text` was produced, and why the model was rejected if it was. */
  phrasing: DraftResult;
  /**
   * A promo the owner can edit and forward, present only when someone has
   * actually gone quiet. Carries `recipients` so the caller can see who it is
   * for. Never sent automatically — P2 sends nothing.
   */
  promo?: PromoDraftResult;
}

/**
 * The whole of demo beat 3 in one call: read the ledger, compute the figures,
 * phrase them, and attach a promo draft if any regular has gone quiet.
 *
 * Safe to call with no API key and no Twilio credentials — the phrasing falls
 * back to deterministic text and every figure is still correct.
 */
export async function getWeeklyRegularsMessage(
  options: RetentionOptions = {},
  ask?: PromptRunner,
): Promise<WeeklyRegularsMessage> {
  const { summary, merges } = getRegularsSummary(options);
  const runner = ask ?? (await resolvePromptRunner());

  const phrasing = await draftRegularsSummary(summary, runner);
  if (phrasing.rejectedReason) {
    // Worth a log line: it means Claude produced something we refused to send.
    console.log(`[p2] phrasing rejected — ${phrasing.rejectedReason}`);
  }

  const result: WeeklyRegularsMessage = {
    summary,
    merges,
    text: phrasing.text,
    phrasing,
  };

  if (summary.lapsing.length > 0) {
    // No offer supplied: the prompt forbids inventing one, so this is a plain
    // "we miss you" the owner can add a deal to herself.
    result.promo = await draftWinBackPromo(summary, '', runner);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Live repeat-visit lookup (demo beat 1)
// ---------------------------------------------------------------------------

export interface RepeatVisitResult {
  isRepeat: boolean;
  visitNumber: number;
  previousVisitDate: string | null;
}

/**
 * Is this customer a returning face? Called right after P1 writes a transaction,
 * so the bot can say "Mary is back — 4th visit" instead of just "logged".
 *
 * Reads only that customer's rows.
 */
export function getRepeatVisit(
  customerId: number,
  atTimestamp: string,
  options: Pick<RetentionOptions, 'naiveTimestampZone'> = {},
): RepeatVisitResult {
  const history = loadTransactionsForCustomer(customerId, options);
  return detectRepeatVisit(history, customerId, atTimestamp);
}

/**
 * Customer ids seen at least `REPEAT_VISIT_THRESHOLD` times in the trailing
 * window.
 *
 * Restores the export P0's router was written against. My earlier PR replaced it
 * with richer functions and broke `main`'s build — this brings the name back with
 * a real implementation so the contract P0 coded to still holds. Prefer
 * `getWeeklyRegularsMessage` for anything owner-facing: this returns bare ids,
 * which a caller then has to turn back into names the owner recognises.
 */
export function detectRepeatVisits(
  windowDays = 7,
  options: RetentionOptions = {},
): number[] {
  const { summary } = getRegularsSummary({
    ...options,
    windowDays,
    // Ranking limit must not truncate a membership question.
    limit: Number.MAX_SAFE_INTEGER,
  });
  return summary.regulars
    .filter((r) => r.visitCount >= REPEAT_VISIT_THRESHOLD)
    .map((r) => r.customerId);
}

/**
 * Customer rows that look like the same human but were left separate — i.e. at
 * least one carries a disambiguator, so `canonicalizeCustomers` refused to merge
 * them. Reporting only; resolving them is a write, and writes are P1's.
 */
export function getDuplicateCandidates(): DuplicateCandidate[] {
  return findDuplicateCandidates(loadCustomers());
}

/** Profiles for every customer, for ad-hoc inspection and debugging. */
export function getAllProfiles(options: RetentionOptions = {}) {
  const { asOfDateKey = todayInEat(), includeUnconfirmed, naiveTimestampZone } = options;
  const raw = loadLedger({ naiveTimestampZone });
  const ledger =
    options.mergeDuplicateNames === false
      ? raw
      : canonicalizeCustomers(raw.customers, raw.transactions);
  return buildCustomerProfiles(ledger.customers, ledger.transactions, {
    asOfDateKey,
    includeUnconfirmed,
  });
}

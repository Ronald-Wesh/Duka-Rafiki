/**
 * P2 — Retention: phrase the weekly summary and draft win-back promos.
 *
 * This is the **only** module in P2 that talks to Claude, and deliberately the
 * only one that can. The split is the architectural rule from README §5:
 *
 *   - `customer-profile.ts` / `repeat-detection.ts` compute every figure.
 *   - this module hands those figures to the model and asks for wording only.
 *
 * Two safeguards make that rule enforceable rather than aspirational:
 *
 *   1. `renderRegularsSummaryText` produces a complete, sendable message with no
 *      model involved. If there is no API key, the network is down, or the Twilio
 *      sandbox is flaky at 3am, the demo still has a message to send.
 *   2. `assertFiguresPreserved` re-checks that every supplied figure survived in
 *      the model's output. If the model dropped, rounded, or invented a number,
 *      the deterministic text is used instead. A wrong figure never reaches the
 *      owner.
 *
 * Replaces P0's `draftPromo` placeholder.
 */

import type { RankedRegular, RegularsSummary } from './types';

// ---------------------------------------------------------------------------
// Model seam
// ---------------------------------------------------------------------------

/**
 * Prompt file names in `src/core/prompts/`, loaded by `loadPrompt()` as the
 * system prompt (README §11 — versioned files, never inline strings).
 *
 * `draft-promo` is the name P0's scaffold already anticipated.
 */
export const REGULARS_SUMMARY_PROMPT = 'regulars-summary';
export const PROMO_DRAFT_PROMPT = 'draft-promo';

/**
 * How P2 reaches Claude — structurally identical to `askClaude` in
 * `src/core/claude-client.ts`, so the real client can be passed straight in:
 *
 *     import { askClaude } from '../core/claude-client';
 *     await draftRegularsSummary(summary, askClaude);
 *
 * Declared as a function type and injected rather than imported at module scope
 * for two reasons: importing `claude-client` constructs an `Anthropic` instance
 * as a side effect (so merely importing P2 would demand an API key), and a
 * one-line fake makes every function here unit-testable offline.
 */
export type PromptRunner = (
  promptName: string,
  input: string,
  maxTokens?: number,
) => Promise<string>;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const KES = new Intl.NumberFormat('en-KE', {
  style: 'currency',
  currency: 'KES',
  currencyDisplay: 'code',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * `Intl` separates the currency code from the digits with a non-breaking space on
 * some Node/ICU builds and an ordinary space on others. Normalising to a plain
 * space means {@link assertFiguresPreserved} cannot fail merely because the model
 * retyped "KES 1,250" with the space it would naturally use.
 */
const NBSP = String.fromCharCode(0x00a0);
const NARROW_NBSP = String.fromCharCode(0x202f);

/**
 * Format an amount the way it will appear to the owner, e.g. `KES 1,250`.
 *
 * Shillings only — cents are noise on a kiosk receipt and make the message harder
 * to scan. This is the single place money becomes text in P2, so the figure the
 * model is shown is identical to the figure that gets sent, which is what makes
 * {@link assertFiguresPreserved} reliable.
 */
export function formatKes(amount: number): string {
  return KES.format(Math.round(amount)).split(NBSP).join(' ').split(NARROW_NBSP).join(' ');
}

function visitWord(count: number): string {
  return count === 1 ? 'visit' : 'visits';
}

// ---------------------------------------------------------------------------
// Deterministic rendering (no model, no network)
// ---------------------------------------------------------------------------

/**
 * The facts block handed to Claude as the user message.
 *
 * Kept as one function so the model can never be shown a figure that the
 * fallback path doesn't also contain.
 */
export function renderFactsBlock(summary: RegularsSummary): string {
  // `namedCustomerSpend` is deliberately NOT shown to the model. It covers only
  // customer-linked rows, so an owner reading it in a WhatsApp message would
  // reasonably mistake it for her weekly takings — which it is not (P1 owns that
  // figure). It also directly contradicts the prompt's "do not add a total"
  // instruction. It stays on `RegularsSummary` for callers that know the
  // difference; it never reaches owner-facing text.
  const lines: string[] = [
    `Week: ${summary.periodStart} to ${summary.periodEnd}`,
    `Named regulars seen this week: ${summary.namedCustomerCount}`,
    `Of those, repeat visitors: ${summary.repeatCustomerCount}`,
    '',
    'Top regulars (already ranked — keep this order):',
  ];

  if (summary.regulars.length === 0) {
    lines.push('  (none — no named customer transacted this week)');
  } else {
    for (const regular of summary.regulars) {
      lines.push(
        `  ${regular.rank}. ${regular.displayName} — ${regular.visitCount} ${visitWord(
          regular.visitCount,
        )}, ${formatKes(regular.totalSpend)}`,
      );
    }
  }

  if (summary.lapsing.length > 0) {
    lines.push('', 'Regulars who have gone quiet:');
    for (const regular of summary.lapsing) {
      lines.push(
        `  ${regular.displayName} — last seen ${regular.lastVisit} (${regular.daysSinceLastVisit} days ago)`,
      );
    }
  }

  if (summary.includesUnconfirmed) {
    lines.push('', 'Note: includes entries the owner has not yet confirmed at day close.');
  }

  return lines.join('\n');
}

/**
 * A complete, sendable weekly message built without the model.
 *
 * Used as the fallback whenever phrasing is unavailable or fails verification.
 * Plainer than Claude's version, never wrong.
 */
export function renderRegularsSummaryText(summary: RegularsSummary): string {
  if (summary.regulars.length === 0) {
    return [
      `Wiki hii (${summary.periodStart} - ${summary.periodEnd}): hakuna customer wa jina aliyerekodiwa.`,
      '',
      'Forward M-Pesa messages zako na tuanze kujenga list ya regulars wako.',
    ].join('\n');
  }

  const lines: string[] = [
    `Regulars wako wiki hii (${summary.periodStart} - ${summary.periodEnd}):`,
    '',
  ];

  for (const regular of summary.regulars) {
    lines.push(
      `${regular.rank}. ${regular.displayName} - ${regular.visitCount} ${visitWord(
        regular.visitCount,
      )}, ${formatKes(regular.totalSpend)}`,
    );
  }

  lines.push(
    '',
    `Wateja wa jina: ${summary.namedCustomerCount}. Wanaorudi: ${summary.repeatCustomerCount}.`,
  );

  if (summary.lapsing.length > 0) {
    const names = summary.lapsing.map((r) => r.displayName).join(', ');
    lines.push('', `Hawa hawajaonekana kwa muda: ${names}. Ungependa kutuma promo?`);
  }

  if (summary.includesUnconfirmed) {
    lines.push('', '(Ina entries ambazo hujathibitisha bado.)');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Figure verification — the guard that makes README §5 enforceable
// ---------------------------------------------------------------------------

/**
 * Every figure that must appear verbatim in the owner-facing weekly message.
 *
 * Scope is deliberately narrow — this list is an invariant, not a wish list.
 * Requiring a figure that a legitimately-worded message need not contain would
 * reject every phrasing including the deterministic fallback's own, which is
 * exactly the bug `smoke-check.ts` caught when `namedCustomerSpend` was in here.
 *
 * Included: each listed regular's display name and money figure. Both are
 * distinctive strings — a name, or `KES` plus grouped digits — so substring
 * matching on them is meaningful.
 *
 * Also included, but weakly: each regular's visit count. A bare small integer
 * like `3` will match incidentally against almost any prose (it appears inside
 * `KES 300`), so its presence is close to guaranteed. It is listed for
 * completeness rather than protection — the real defence for counts is that the
 * model never computes them.
 *
 * Excluded: the aggregate counts and `namedCustomerSpend` (never shown to the
 * model, see `renderFactsBlock`), and the lapsing day counts, which the promo
 * prompt is explicitly instructed *not* to mention.
 */
export function figuresToPreserve(summary: RegularsSummary): string[] {
  const figures: string[] = [];
  for (const regular of summary.regulars) {
    figures.push(regular.displayName, formatKes(regular.totalSpend), String(regular.visitCount));
  }
  return [...new Set(figures)];
}

export interface FigureCheckResult {
  ok: boolean;
  /** Figures that did not appear verbatim in the model's output. */
  missing: string[];
}

/**
 * Check that the model's phrasing still contains every computed figure.
 *
 * Substring matching against the *formatted* figures, which is why formatting
 * lives in exactly one place. Whitespace is collapsed on both sides because the
 * model may rewrap lines; digits and names are compared as-is.
 *
 * This catches the failure that actually matters on stage: a fluent, confident
 * message with a subtly wrong number in it.
 */
export function assertFiguresPreserved(text: string, summary: RegularsSummary): FigureCheckResult {
  const collapse = (value: string) =>
    value.split(NBSP).join(' ').split(NARROW_NBSP).join(' ').replace(/\s+/g, ' ');
  const haystack = collapse(text);
  const missing = figuresToPreserve(summary).filter((figure) => !haystack.includes(collapse(figure)));
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

export interface DraftResult {
  text: string;
  /** How the text was produced — surfaced so the demo can say which path ran. */
  source: 'claude' | 'deterministic-fallback';
  /** Set when the model was tried and its output was not used. */
  rejectedReason?: string;
  /** Prompt file used, for reproducing a bad draft later. */
  promptName?: string;
}

/**
 * Phrase the weekly regulars summary.
 *
 * Omit `ask` to get the deterministic message. Pass it and the phrasing is used
 * **only if** every computed figure survives verification; otherwise the
 * deterministic text is returned with `rejectedReason` set.
 *
 * Never throws on model failure — a summary that fails to send is a worse outcome
 * than a plainly-worded one.
 */
export async function draftRegularsSummary(
  summary: RegularsSummary,
  ask?: PromptRunner,
): Promise<DraftResult> {
  const fallback = renderRegularsSummaryText(summary);
  if (!ask) return { text: fallback, source: 'deterministic-fallback' };

  let phrased: string;
  try {
    phrased = (await ask(REGULARS_SUMMARY_PROMPT, renderFactsBlock(summary), 500)).trim();
  } catch (error) {
    return {
      text: fallback,
      source: 'deterministic-fallback',
      rejectedReason: `model call failed: ${(error as Error).message}`,
      promptName: REGULARS_SUMMARY_PROMPT,
    };
  }

  const check = assertFiguresPreserved(phrased, summary);
  if (!check.ok) {
    return {
      text: fallback,
      source: 'deterministic-fallback',
      rejectedReason: `model output dropped or altered figures: ${check.missing.join(', ')}`,
      promptName: REGULARS_SUMMARY_PROMPT,
    };
  }

  return { text: phrased, source: 'claude', promptName: REGULARS_SUMMARY_PROMPT };
}

/**
 * Draft a win-back promo aimed at the summary's lapsing regulars.
 *
 * The result is a **draft**: the owner reads it, edits it, and decides whether to
 * send. P2 never sends anything — outbound is P0's webhook.
 *
 * @param offer The owner's own words for what she is offering, e.g. "sukari
 *              punguzo kidogo wiki hii". Passed through verbatim; the prompt
 *              forbids inventing a discount, so an empty offer yields a plain
 *              "we miss you" note rather than a fabricated deal.
 */
export async function draftWinBackPromo(
  summary: RegularsSummary,
  offer: string,
  ask?: PromptRunner,
): Promise<DraftResult & { recipients: RankedRegular[] }> {
  const recipients = summary.lapsing;
  const trimmedOffer = offer.trim();

  const fallback = recipients.length
    ? [
        'Mambo! Tumekukosa kwa duka.',
        trimmedOffer ? `Wiki hii: ${trimmedOffer}.` : 'Karibu tena wiki hii.',
        'Karibu tena - Mama Njeri.',
      ].join('\n')
    : 'Hakuna regular ambaye hajaonekana kwa muda. Hakuna promo inayohitajika sasa.';

  if (!ask || recipients.length === 0) {
    return { text: fallback, source: 'deterministic-fallback', recipients };
  }

  const input = [
    renderFactsBlock(summary),
    '',
    'OFFER SHE IS WILLING TO MAKE',
    trimmedOffer || '(no specific offer — do not invent one)',
  ].join('\n');

  try {
    const phrased = (await ask(PROMO_DRAFT_PROMPT, input, 300)).trim();

    // The promo intentionally carries no computed figures, so there is nothing to
    // verify beyond it being non-empty. Guard against a blank response.
    if (!phrased) {
      return {
        text: fallback,
        source: 'deterministic-fallback',
        rejectedReason: 'model returned empty text',
        promptName: PROMO_DRAFT_PROMPT,
        recipients,
      };
    }

    return { text: phrased, source: 'claude', promptName: PROMO_DRAFT_PROMPT, recipients };
  } catch (error) {
    return {
      text: fallback,
      source: 'deterministic-fallback',
      rejectedReason: `model call failed: ${(error as Error).message}`,
      promptName: PROMO_DRAFT_PROMPT,
      recipients,
    };
  }
}

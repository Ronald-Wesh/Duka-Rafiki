/**
 * Which language to answer in.
 *
 * Mama Njeri code-switches constantly, so the bot should mirror whatever she
 * just used rather than forcing one language on her. Detection is deterministic
 * keyword scoring, for the same reason intent classification is: it is instant,
 * debuggable, and a wrong guess here is cosmetic rather than ledger-corrupting.
 * The model still does all the real language work downstream.
 */

export type Lang = "en" | "sw";

/** Swahili/Sheng markers. Verbs and function words score 2 — they rarely
 *  survive translation. Product nouns score 1, since Kenyan English borrows
 *  them freely ("two unga please"). */
const SW: Array<[RegExp, number]> = [
  [/\b(nimeuza|nimenunua|nimepata|nimelipwa|nimeandika)\b/i, 2],
  [/\b(amechukua|amelipa|alilipa|amerudisha|amekopa|anadai|nadai|kalipa)\b/i, 2],
  [/\b(deni|denni)\b/i, 2],
  [/\b(funga|kufunga|jumla|imeisha|imelingana|tofauti)\b/i, 2],
  [/\b(habari|mambo|niaje|sasa|asante|karibu|samahani|pole)\b/i, 2],
  [/\b(nataka|nionyeshe|naomba|msaada|tafadhali)\b/i, 2],
  [/\b(ripoti|taarifa|hesabu)\b/i, 2],
  [/\b(wateja|mteja|wanunuzi|wangu|yangu|zangu)\b/i, 2],
  [/\b(leo|jana|kesho|wiki|mwezi|siku)\b/i, 2],
  [/\b(ya|na|ni|za|wa|kwa|kutoka|mbili|tatu|nusu|bob)\b/i, 1],
  [/\b(unga|sukari|maziwa|mkate|mafuta|sabuni|chumvi|mayai|nyanya|vitunguu|mchele|ndengu|chai)\b/i, 1],
];

/** English markers. */
const EN: Array<[RegExp, number]> = [
  [/\b(sold|sell|bought|buy|paid|pay|owes?|owed|borrowed)\b/i, 2],
  [/\b(credit|debt|balance|outstanding)\b/i, 2],
  [/\b(close|closing|total|takings|reconcile)\b/i, 2],
  [/\b(hello|hi|hey|thanks|thank you|please|sorry)\b/i, 2],
  [/\b(report|statement|summary|record)\b/i, 2],
  [/\b(customers?|regulars?|clients?)\b/i, 2],
  [/\b(today|yesterday|week|month|day)\b/i, 2],
  [/\b(show|give|send|want|need|help)\b/i, 2],
  [/\b(the|and|for|from|with|my|me|is|are|of)\b/i, 1],
  [/\b(flour|sugar|milk|bread|oil|soap|salt|eggs?|rice|tea|cash)\b/i, 1],
];

function score(text: string, markers: Array<[RegExp, number]>): number {
  return markers.reduce((sum, [re, w]) => (re.test(text) ? sum + w : sum), 0);
}

/**
 * Returns the language to reply in.
 *
 * Ties resolve to Swahili: the owner is a Nairobi kiosk trader, and a
 * code-switched line like "unga 2kg 180 cash" is Sheng with an English loanword,
 * not an English sentence.
 */
export function detectLanguage(text: string): Lang {
  const sw = score(text, SW);
  const en = score(text, EN);
  if (en > sw) return "en";
  return "sw";
}

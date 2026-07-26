import type { Lang } from "./language";

// All user-facing copy in one place, in both languages. Kept as static strings,
// not model output: these are acknowledgements and error paths, and on stage
// they need to be instant and predictable. The model phrases summaries, promos
// and statements — not this.

const HELP_SW = [
  "Karibu Duka Ledger 👋",
  "",
  "Unaweza:",
  "• Forward SMS ya M-Pesa — nitaandika mauzo na jina la mteja",
  "• Andika mauzo ya cash, mfano: \"unga 120 cash\"",
  "• Deni: \"Mary amechukua sukari 200 deni\"",
  "• Funga siku: \"funga leo 3500\"",
  "• Ripoti: \"nataka report\"",
  "",
  "Andika Kiswahili au Kiingereza — nitajibu kwa lugha yako.",
].join("\n");

const HELP_EN = [
  "Welcome to Duka Ledger 👋",
  "",
  "You can:",
  "• Forward an M-Pesa SMS — I'll log the sale and the customer's name",
  "• Log a cash sale, e.g. \"sugar 120 cash\"",
  "• Credit: \"Mary took sugar 200 on credit\"",
  "• Close the day: \"close today 3500\"",
  "• Report: \"I want a report\"",
  "",
  "Write in English or Swahili — I'll reply in the same language.",
].join("\n");

export const replies = {
  help: (l: Lang) => (l === "en" ? HELP_EN : HELP_SW),

  unknown: (l: Lang) =>
    l === "en"
      ? "Sorry, I didn't quite get that 🤔\nTry something like \"sugar 120 cash\", \"close today 3500\", or type \"help\"."
      : "Samahani, sijaelewa vizuri 🤔\nJaribu tena — mfano: \"unga 120 cash\", \"funga leo 3500\", au andika \"msaada\".",

  // Used when a pillar's handler exists but isn't implemented yet. Honest
  // rather than pretending the entry was saved — a silent no-op during the
  // demo would look identical to a working bot until the totals came out wrong.
  notReady: (l: Lang, what: string) =>
    l === "en"
      ? `Got your message ✅\n(${what} isn't connected yet — nothing was saved.)`
      : `Nimepokea ujumbe wako ✅\n(${what} bado inaunganishwa — haijahifadhiwa bado.)`,

  // Something actually broke. Never leave the owner in silence.
  failed: (l: Lang) =>
    l === "en"
      ? "Sorry, something went wrong ⚠️\nYour message was logged. Try again, or type \"help\"."
      : "Aduh, kuna hitilafu kidogo ⚠️\nUjumbe wako umehifadhiwa. Jaribu tena au andika \"msaada\".",

  // --- pillar acknowledgements -------------------------------------------
  saleLogged: (l: Lang, amount: number) =>
    l === "en" ? `Logged: Ksh ${amount} ✅` : `Nimeandika: Ksh ${amount} ✅`,

  mpesaLogged: (l: Lang, amount: number, payer: string) =>
    l === "en"
      ? `Logged: Ksh ${amount} from ${payer} ✅`
      : `Nimeandika: Ksh ${amount} kutoka ${payer} ✅`,

  deniLogged: (l: Lang, amount: number) =>
    l === "en"
      ? `Credit recorded: Ksh ${amount} ✅`
      : `Deni imeandikwa: Ksh ${amount} ✅`,

  // The message named no figure, so nothing can be recorded from it.
  needAmount: (l: Lang) =>
    l === "en"
      ? "I didn't catch an amount there. Tell me how much, e.g. \"Mary took sugar 200 on credit\"."
      : "Sijapata kiasi hapo. Niambie ni ngapi, mfano: \"Mary amechukua sukari 200 deni\".",

  askDayTotal: (l: Lang) =>
    l === "en"
      ? "Closing the day? Tell me your total, e.g. \"close today 3500\"."
      : "Umefunga siku? Niambie jumla uliyopata, mfano: \"funga leo 3500\".",

  dayClose: (
    l: Lang,
    r: { date: string; expected_total: number; reported_total: number; variance: number }
  ) => {
    const verdict =
      r.variance === 0
        ? l === "en"
          ? "It matches ✅"
          : "Imelingana ✅"
        : r.variance > 0
          ? l === "en"
            ? `You reported Ksh ${Math.abs(r.variance)} more than was logged`
            : `Umesema zaidi kwa Ksh ${Math.abs(r.variance)}`
          : l === "en"
            ? `You reported Ksh ${Math.abs(r.variance)} less than was logged`
            : `Umesema pungufu kwa Ksh ${Math.abs(r.variance)}`;

    return l === "en"
      ? [
          `Closing ${r.date}:`,
          `Logged: Ksh ${r.expected_total}`,
          `You said: Ksh ${r.reported_total}`,
          verdict,
        ].join("\n")
      : [
          `Kufunga siku ${r.date}:`,
          `Zilizoandikwa: Ksh ${r.expected_total}`,
          `Umesema: Ksh ${r.reported_total}`,
          verdict,
        ].join("\n");
  },

  reportReady: (l: Lang, url: string, summary: string) =>
    l === "en"
      ? `Your report is ready 📄\n${url}\n\n${summary}`
      : `Ripoti yako iko tayari 📄\n${url}\n\n${summary}`,
};

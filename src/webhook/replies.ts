// All user-facing copy in one place. Kept as static strings, not model output:
// these are acknowledgements and error paths, and on stage they need to be
// instant and predictable. The model phrases summaries and promos — not this.

export const replies = {
  help: [
    "Karibu Duka Ledger 👋",
    "",
    "Unaweza:",
    "• Forward SMS ya M-Pesa — nitaandika mauzo na jina la mteja",
    "• Andika mauzo ya cash, mfano: \"unga 120 cash\"",
    "• Deni: \"Mary amechukua sukari 200 deni\"",
    "• Funga siku: \"funga leo 3500\"",
    "• Ripoti: \"nataka report\"",
  ].join("\n"),

  unknown:
    "Samahani, sijaelewa vizuri 🤔\nJaribu tena — mfano: \"unga 120 cash\", \"funga leo 3500\", au andika \"msaada\".",

  // Used when a pillar's handler exists but isn't implemented yet. Honest
  // rather than pretending the entry was saved — a silent no-op during the
  // demo would look identical to a working bot right up until the totals are wrong.
  notReady: (what: string) =>
    `Nimepokea ujumbe wako ✅\n(${what} bado inaunganishwa — haijahifadhiwa bado.)`,

  // Something actually broke. Never leave the owner in silence.
  failed:
    "Aduh, kuna hitilafu kidogo ⚠️\nUjumbe wako umehifadhiwa. Jaribu tena au andika \"msaada\".",
};

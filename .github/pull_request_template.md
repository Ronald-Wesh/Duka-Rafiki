<!-- Keep this short. Hackathon PRs should be readable in 60 seconds. -->

## What & why

<!-- One or two sentences. What does this change let the demo do that it couldn't before? -->

**Pillar:** P0 platform / P1 reconciliation / P2 retention / P3 statement / repo chore

## Checklist

- [ ] I worked **only inside my pillar folder** — or I flagged shared surface area
      (`src/core/`, `src/db/schema.sql`, `package.json`) in the team chat *before* opening this.
- [ ] **Every number a user sees is computed by deterministic code**, not by Claude.
      Claude only phrases figures it was handed. (README §5 — non-negotiable.)
- [ ] No credit score, band, rating, or creditworthiness signal anywhere — including
      variable names, comments, and copy.
- [ ] No secrets, no real customer data. New env vars are documented in `.env.example`
      with empty values.
- [ ] I pulled latest `main`, ran the seed script, and my pillar still works against
      current shared types and schema.
- [ ] Schema touched? `src/db/schema.sql` updated **and** a one-line note added to
      `docs/data-model.md`.

## How I verified it

<!-- Command you ran, or the WhatsApp message you sent and what came back.
     "Didn't run it" is an acceptable answer at hour 20 — just say so. -->

## Demo impact

- [ ] Touches the live demo path (README §12) — needs a re-run before stage
- [ ] Off the demo path — safe to merge and move on

## Notes for reviewers

<!-- Anything you knowingly left rough, and what you'd want a second pair of eyes on. -->

---

🤖 Built with [Claude Code](https://claude.com/claude-code)

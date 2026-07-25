# Contributing — Duka Ledger

Operational companion to `README.md` (the shared Claude Code instruction set).
`README.md` says *what* we're building and who owns what; this file says *how* code
gets onto `main` without breaking the demo.

If the two ever disagree, `README.md` §10 wins — fix this file.

---

## 1. Who owns what

| Pillar | Owner | GitHub | Folder — work only here |
|---|---|---|---|
| P0 — Platform/Infra | Person D | `@Ronald-Wesh` | `src/webhook/`, `src/core/`, `demo/`, build config |
| P1 — Reconciliation | Person A | *fill in* | `src/pillar1-reconciliation/`, `src/db/schema.sql` |
| P2 — Retention | Person B | `@arthuradinder` | `src/pillar2-retention/` |
| P3 — Statement | Person C | *fill in* | `src/pillar3-statement/` |

Fill in the blanks as people claim pillars. Once every owner has **write access** to
this repo, promote this table into `.github/CODEOWNERS` so reviewers auto-assign —
CODEOWNERS entries are silently ignored for users without write access, which is why
it isn't checked in yet.

## 2. Push access, and the 403 that isn't what it looks like

The repo lives at `github.com/Ronald-Wesh/Duka-Rafiki`. Pushing needs collaborator
access, which **@Ronald-Wesh** grants via Settings → Collaborators → *Add people*,
with the **Write** role.

If you hit `403 ... Permission to Ronald-Wesh/Duka-Rafiki.git denied to <name>`,
**read the name in that message before asking for an invite.** If it isn't your
account, git is using a cached credential for a different GitHub login — a work
account, usually — and you may already have access. On Windows:

```bash
git push                                   # note which account the 403 names
cmdkey /list | findstr github              # see which account is cached
cmdkey /delete:git:https://github.com      # drop it
git config --local credential.https://github.com.username <your-username>
git push                                   # re-authenticate in the browser as you
```

Deleting that entry only clears a saved sign-in — you re-authenticate in the
browser and nothing is lost. If the 403 still names *you* afterwards, then it
really is a missing invite: use the fork route in §3b meanwhile, which produces
the same thing (a PR into `main`), so nobody is blocked waiting.

## 3. Branching

`main` is always demo-able. **Nobody pushes to `main` directly** — everything lands
via PR.

Branch names are fixed per `README.md` §10:

| Branch | Owner |
|---|---|
| `platform-infra` | P0 |
| `pillar1-reconciliation` | P1 |
| `pillar2-retention` | P2 |
| `pillar3-statement` | P3 |

Repo-wide chores that belong to nobody's pillar (CI, ignore rules, templates) go on
a short-lived `chore/<thing>` branch and merge fast.

### 3a. With write access

```bash
git switch main
git pull --ff-only
git switch -c pillar2-retention     # your pillar branch; reuse it all night
# ...work...
git push -u origin pillar2-retention
```

Then open a PR into `main`.

### 3b. Without write access (fork route)

Fork the repo on GitHub, then wire both remotes so you can still track the team:

```bash
git remote rename origin upstream                     # team repo, read-only for you
git remote add origin https://github.com/<you>/Duka-Rafiki.git
git push -u origin pillar2-retention                  # pushes to YOUR fork
```

Open the PR from your fork's branch into `Ronald-Wesh/Duka-Rafiki:main`. Keep
syncing with `git pull --ff-only upstream main`. When your collaborator invite
arrives, undo it with `git remote set-url origin https://github.com/Ronald-Wesh/Duka-Rafiki.git`.

## 4. Staying in your lane

- Work **only inside your pillar folder**. Pillars 1–3 share P1's ledger tables —
  do not fork the data model.
- `src/core/`, `src/db/schema.sql`, and `package.json` are **shared surface area**.
  Post in the team chat *before* you touch them, not in the PR description after.
- Need a field P1 hasn't exposed? Ask P1 to add it to `src/core/types.ts`. Do not
  reach into the DB with an ad-hoc query.
- Adding a column means updating `src/db/schema.sql` **and** a one-line note in
  `docs/data-model.md`. Never silently diverge.

## 5. The one architectural rule that gets enforced in review

**The model does language. Code does arithmetic.**

Claude parses SMS/voice/text and phrases summaries and promos. Every number —
running totals, variance, margins, balances, anything in the statement — is computed
by deterministic code and *handed* to the model. A PR that asks Claude to compute a
figure that reaches the user gets sent back, even at hour 20. Every figure on stage
has to be correct and auditable.

Corollary: numbers are testable without an API key. Keep the deterministic half free
of network calls so it can be unit-tested offline.

## 6. Never in a PR

- A numeric credit score, band, rating, or creditworthiness signal — in product,
  schema, variable names, comments, or copy. We are not a licensed FSP. The artifact
  is a **descriptive transaction record over a stated date range**.
- Real secrets. `.env` is gitignored; document new keys in `.env.example` with empty
  values.
- Real customer names, phone numbers, or M-Pesa data. Seed data is fictional.
- A native app, PWA, or "just download our…" path. WhatsApp-only is the point.

## 7. Before you request review

1. `git pull --ff-only origin main` (or `upstream main`) — no stale bases.
2. Run the seed script; confirm your pillar still works against current shared
   types and schema.
3. Keep it small. Small, frequent PRs — a single end-of-night mega-merge is how
   demos die.

## 8. Commits

Conventional-commit prefixes so `git log --oneline` is skimmable at 3am:

```
feat(p2): rank regulars by visit count over trailing 7 days
fix(p2): treat "MARY WANJIKU" and "Mary Wanjiku" as one customer
chore: add .gitignore and line-ending normalisation
docs(p2): document the retention contract
```

Claude Code is the hackathon's build constraint, so keep authorship visible in
commit trailers and PR bodies — judging may care.

## 9. Sync cadence

Every 2–3 hours, even just a 5-minute "does `main` still boot" check. P0 merges
first and most often — webhook and core are everyone's foundation.

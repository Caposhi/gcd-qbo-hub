# Append this to `docs/HUB_HANDOFF.md`

> Paste the section below at the end of the existing `docs/HUB_HANDOFF.md` and
> commit it. Both concurrent Claude Code sessions read this file, so documenting
> the split here is what keeps them from clobbering each other.

---

## 10. Parallel workstreams (two Claude Code sessions active)

Two sessions are running against this repo at once, each on its **own git branch**.
Commit frequently; `git pull --rebase` before any schema migration.

**Session A — AI C-suite (Build Phase 3).** Owns and may edit:
- `src/lib/anthropic/` and persona configs
- The `ai_*` tables
- The monthly cron route
- The **projections page UI + projections engine** (adding insight panels, orchestration)
- Appends to `roles.ts`: `run_ai_council`, `view_ai_council`

**Session B — Tekmetric integration (Build Phase 4 groundwork).** Owns and may edit:
- `src/lib/tekmetric/` (client, normalize, types) — new
- The `tek_*` tables — new
- The standalone `/tekmetric` Operations page — new
- Appends to `roles.ts`: `view_tekmetric`, `refresh_tekmetric`

**Shared files — handle with care (only these three overlap):**
- `prisma/schema.prisma` — **additive only**, prefix-namespaced models. **Only one
  session runs `prisma migrate` at a time; rebase first** so migration history
  doesn't fork. This is the single biggest risk.
- `src/lib/auth/roles.ts` — **append only**, no reordering/editing existing entries.
- `src/lib/modules/registry.ts` — **append only.**

**Interface contract:** Session B commits `src/lib/tekmetric/types.ts` first.
Session A codes its COO/CRO/CDA agents against that type; Session B builds the
provider behind it. Neither blocks the other.

**Explicit no-touch:** Session B must not modify the projections engine, the
projections page, the anthropic lib, the `ai_*` tables, or the cron route.
Tekmetric → projections/AI wiring is a **later, coordinated step** performed once
Phase 3 has landed — never by both sessions at the same time.

**Alternative/next parallel task (different repo, zero collision):** the
call-transcript service's read-only insights endpoint (versioned, Render private
networking, bearer secret) for the CRO agent. Blocked only on the open decision in
§9 — whether that repo emits structured insights or raw transcripts + freeform
analysis.

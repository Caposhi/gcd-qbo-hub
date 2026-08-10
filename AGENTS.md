# Repository instructions

These instructions apply to every file and subdirectory in this repository.

## Binding continuous-documentation rule

Documentation is part of every change. A repository change is not complete until the author has:

a. identified every Markdown file, environment example, runbook, diagram, command, path, inline operational note, and external setup description affected by the change;

b. updated those references in the same atomic change as the code, configuration, infrastructure, schema, integration, or process change;

c. removed or explicitly archived instructions that no longer apply;

d. reread every modified document as a whole and confirmed unchanged sections remain correct for the current edition;

e. verified documented paths, commands, variables, ports, service names, routes, schedules, links, and identifiers against source;

f. updated the root handoff README whenever architecture, data flow, deployment, security, operations, ownership, recovery, or external dependencies change; and

g. recorded unresolved uncertainty, manual prerequisites, rollout gates, and external-system dependencies instead of presenting them as completed.

This rule applies to humans, Codex, all other AI agents, automated refactors, dependency updates, generated code, and emergency work. Documentation-only follow-up is not an acceptable substitute except for a genuine emergency hotfix; any exception must be recorded as a blocking follow-up before closure.

## Safety and source hierarchy

- Preserve unrelated working-tree changes. Do not reset, overwrite, or silently reformat them.
- Executable source, migrations, tests, and checked-in configuration outrank prose.
- `README.md` is the canonical handoff; current runbooks live in `docs/`; `docs/archive/` is historical only.
- Never commit credentials, QBO tokens, service-account material, magic links, customer data, raw transcripts, or production exports.
- Never run migrations, seed scripts, backfills, syncs, QBO writes, external diagnostics, deploys, or restoration against an unidentified environment.
- Do not commit, push, merge, deploy, rotate secrets, rewrite history, delete data, or change external systems unless explicitly authorized.
- Record external dashboard state as unverified unless it was actually inspected.

## Required validation

Run the checks relevant to the change, normally `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm audit --omit=dev`, Markdown-link validation, environment-reference coverage, a credential/PII scan with manual triage, `git diff --check`, and a complete diff review. State exactly which checks could not run and why.

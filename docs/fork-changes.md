# Fork Changes — Implementation Details

Detailed implementation notes for the two custom features in this fork of `vercel-labs/skills`. For the high-level rationale, gotchas, contracts, and historical context, see AGENTS.md → Fork Notes.

## 1. Frontmatter preservation across updates

### Implementation

- `src/frontmatter-preserve.ts` (new) — `captureInstalledFrontmatter` (reads installed SKILL.md frontmatter before update) and `restoreFrontmatter` (merges local frontmatter back into fresh copy after update, returns `Promise<boolean>`). Finds SKILL.md via canonical path (symlink mode) or `listInstalledSkills` fallback (copy mode). All failure paths (read, parse, write, missing file) are caught and return `false`/`null` without crashing the update.
- `src/update.ts` — hooks capture/restore around all three `spawnSync` reinstall points (`processWellKnownUpdates`, `updateGlobalSkills`, `updateProjectSkills`); adds `preserveFrontmatter` to `UpdateCheckOptions` and `--no-preserve-frontmatter` to `parseUpdateOptions`. Prints user-visible `⚠ Frontmatter preservation failed` warning when restore returns `false`.
- `src/cli.ts` — adds `--no-preserve-frontmatter` to the Update Options help section; banner says `debug + frontmatter preservation`.
- `tests/frontmatter-preserve.test.ts` (new) — 14 tests covering capture, restore, locally-added fields, locally-overridden values, new upstream fields, no-op cases, nested metadata, blank-line formatting, invalid upstream YAML, and a full end-to-end update cycle.
- `tests/update.test.ts` — 4 `parseUpdateOptions` tests + 8 frontmatter preservation flow tests covering all 3 spawn points, `--no-preserve-frontmatter` skip, null/empty capture, and restore-failure warning.

## 2. File-based `--debug` logging (never breaks the TUI)

### Implementation

- `src/debug.ts` (new, ~303 lines) — file sink, rotation, redaction, header, `getLogFilePath`/`getDisplayLogPath`/`setDebugFile`/`isStderrMode`/`isDebugEnabled`/`enableDebug`/`isDebugFlag`
- `src/cli.ts` — parses `--debug`/`--verbose`/`-d` (including `--debug=/path`), propagates via `SKILLS_DEBUG_FILE` to `update` child, banner/version show `bermudi fork`, prints `Debug log: ...` at exit; added `Global Options` to help
- Instrumented call sites: `src/skills.ts` (`hasSkillMd`, `parseSkillMd`, `findSkillDirs`, `discoverSkills` timing), `src/blob.ts` (tree fetches), `src/git.ts` (clone), `src/source-parser.ts` (API), `src/installer.ts` (FS ops), `src/local-lock.ts`/`src/skill-lock.ts`/`src/sync.ts`/`src/telemetry.ts`/`src/find.ts`
- `src/debug.test.ts` (new) — unit tests for log path resolution/rotation; `src/cli.test.ts` — integration tests asserting output goes to file not stderr and `--json` stays pure; `src/test-utils.ts` — uses `spawnSync` for uniform stdout/stderr capture

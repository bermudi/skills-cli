# Fork Changes — Implementation Details

Detailed implementation notes for the custom features in this fork of `vercel-labs/skills`. For the high-level rationale, gotchas, contracts, and historical context, see AGENTS.md → Fork Notes.

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

## 3. Live-symlink guard (never clobber externally owned links)

### Behavior

Install/update must not replace a **live symlink** — one that resolves to an existing file or
directory — with managed content. Such a link is owned by something outside `skills` (e.g. a
developer's checkout linked into `~/.agents/skills/<skill>`); `rm()` would silently swap it for a
fresh upstream copy. The install fails with
`Refusing to replace symlink <path> -> <target>. Remove the symlink if you want skills to manage this path.`

Dangling links and self-loops (#293) own nothing and are still cleaned up, preserving upstream
regression behavior. Note the check resolves relative targets lexically from the link's directory
(same as the kernel), so a "live" classification only means the resolved target exists.

### Implementation

- `src/installer.ts` — `assertNoLiveSymlink(path)` guard, called first inside
  `cleanAndCreateDirectory()` (the single rm+mkdir choke point used by all four installers for
  canonical dirs in symlink mode and agent dirs in copy mode) and before the `rm` in the Eve
  flat-file branch of `installBlobSkillForAgent`. Throws; surrounding catch blocks convert it to a
  failed `InstallResult`. Not applied to `createSymlink()`'s own link replacement (agent→canonical
  links are skills-managed by design).
- `src/add.ts` — both install render paths now set `process.exitCode = 1` when a skill ends up with
  no successful placement at all (`process.exitCode`, not `process.exit`, so multi-source flows like
  `skills install` keep going). Per-agent failures that leave the skill installed elsewhere (e.g.
  "Eve does not support global skill installation" when targeting all agents) stay exit 0 — the
  previous always-exit-0 behavior masked total failures from `skills update`.
- `src/update.ts` — `printChildFailureDetail()` prints the last 3 ANSI-stripped lines of a failed
  `add` subprocess's captured stdout/stderr at all three `spawnSync` reinstall points; without it
  the refusal reason is piped and discarded, and `update` would print a bare "Failed to update X".
- `tests/installer-symlink.test.ts` — new `installer live-symlink guard` describe: refusal (symlink
  mode, copy mode, blob mode, Eve flat), dangling-link cleanup still works, relative-target
  resolution, and recovery after manual link removal.
- `tests/symlink-guard-add.test.ts` — end-to-end through the real CLI: refusal + non-zero exit +
  link and target preserved.

# AGENTS.md

## Project

`skills` is the CLI for the open agent skills ecosystem — a package manager that installs `SKILL.md` files into agent directories and tracks them in a lock file. This is a fork of `vercel-labs/skills` hosted at `bermudi/skills-cli`.

## Stack

| | |
|---|---|
| Language | TypeScript (ESM) |
| Runtime | Node.js |
| Package manager | pnpm |
| Build | obuild (bundles to `dist/cli.mjs`) |
| Test runner | vitest |
| Formatter | Prettier (enforced in CI) |

## Architecture

A single CLI entry point routes to command handlers in `src/`. Skills are installed by copying or symlinking `SKILL.md` files into agent-specific directories (`.claude/skills/`, `.cursor/skills/`, `.agents/skills/`, etc.). Two lock files track installations: a global one at `~/.agents/.skill-lock.json` and a project-level `skills-lock.json` (checked into repos).

**Global install model (don't re-diagnose as a bug):** universal agents (project `skillsDir === '.agents/skills'`: Codex, Cursor, Gemini CLI, Amp, OpenCode, Zed, …) all read the shared `~/.agents/skills` globally, so global installs write only the canonical copy — no per-agent symlinks is correct behavior. The per-agent `globalSkillsDir` values (`~/.codex/skills`, `~/.cursor/skills`, …) exist for agent-scoped skills the user wants visible to only one harness. Known cosmetic nit: `isSkillInstalled` still checks the old per-agent global dir, so the add-picker may show a skill as "not installed" for a universal agent that actually sees it via the canonical dir.

**`skills` is not a harness.** It does not write system prompts, decide which skills an LLM sees, or invoke skills at runtime. Harnesses (Claude Code, Devin, Cursor, etc.) read installed `SKILL.md` files directly from disk. This distinction is the reason the fork exists — see [Fork Notes](#fork-notes).

### Lock file format

Version 3. Key field: `skillFolderHash` (GitHub tree SHA for the skill folder). Older versions are wiped on read — users must reinstall to populate the new format.

## Workflow

```bash
pnpm install          # install deps
pnpm build            # build dist/ (the symlinked CLI picks this up immediately)
pnpm test             # run all tests
pnpm test tests/foo.test.ts  # run specific test file(s)
pnpm type-check       # tsc --noEmit
pnpm format           # Prettier — run before committing (CI enforces this)
```

To add a new agent: add its definition to `src/agents.ts`, then run `pnpm run -C scripts validate-agents.ts` and `pnpm run -C scripts sync-agents.ts` (updates README.md and package keywords).

## Fork Notes

### Why this fork exists

`skills` manages files that harnesses read directly. Users customize how their harness treats a skill by editing the installed `SKILL.md` frontmatter (e.g. `disable-model-invocation: true`). But `skills update` overwrites installed files with fresh upstream copies — silently destroying local edits. Upstream doesn't address this because the use case is invisible to it: `skills` doesn't know about frontmatter fields it doesn't parse, and it doesn't know that harnesses read the files it installs.

The fork bridges that gap with two features. See `docs/fork-changes.md` for implementation details (file paths, function names, test coverage).

### Custom features

#### 1. Frontmatter preservation across updates

On update, captures installed `SKILL.md` frontmatter before reinstalling, merges it back after. Local frontmatter wins for any key present in it (shallow merge: `{ ...upstreamFm, ...localFm }`). Always on; `--no-preserve-frontmatter` discards local edits.

**Trade-off:** if the user modified a field locally and upstream also changed that same field, the local value wins — masking intentional upstream changes. Fields the user never touched always follow upstream. Nested objects like `metadata` are replaced wholesale, not deep-merged.

**Known limitations:**

- **YAML re-serialization.** The entire frontmatter block is re-serialized via `yaml.stringify()`. YAML comments are lost and key order follows the merge (upstream keys first, then local-only keys). The body is preserved as-is.
- **Copy mode with multiple agents.** `listInstalledSkills` deduplicates by `scope:name`, so only one agent copy is found. If the user edited a different agent's copy, that edit is missed. Rare in practice — `skills update` reinstalls via symlink mode, so the canonical path exists after reinstall.
- **Eve flat skills.** Eve installs skills as flat `.md` files (not `<name>/SKILL.md`), which this feature doesn't find. Preservation is a no-op for Eve flat skills.

**Historical note:** the fork previously had a feature that parsed `disable-model-invocation` and recorded it in the lock file / `--json` output. That plumbing had no consumer and didn't preserve the field across updates. It has been replaced by this feature. The parse/record plumbing in `src/types.ts`, `src/skills.ts`, `src/blob.ts`, `src/installer.ts`, and `src/list.ts` is intentionally left as-is — do not remove it. It's harmless and upstream may eventually use it.

#### 2. File-based `--debug` logging (never breaks the TUI)

Debug output goes to a file instead of stderr so the Clack pretty TUI stays intact.

- Default path: `$XDG_STATE_HOME/skills/debug.log` else `~/.local/state/skills/debug.log`
- Overrides (first wins): `--debug=/path` (rel to cwd), `SKILLS_DEBUG_FILE`, `SKILLS_DEBUG` when it looks like a path (`/` or `\` or ends with `.log`), else default
- Escape hatch: `SKILLS_DEBUG=stderr` (or `SKILLS_DEBUG_FILE=stderr`) restores stderr
- Rotation: `>5MB` rotates to `debug.log.1`; first write does `mkdir -p` and writes a header (ISO time, args, version, cwd)
- Redaction: Bearer tokens, `ghp_`/`gho_`/`github_pat_`, `token=`, `GITHUB_TOKEN=` are redacted in every log line
- Writes are sync for `process.exit` safety
- On exit: single `Debug log: ...` line to stderr pointing at the file

### Installing

This fork is **not published to npm**. The global `skills` command is symlinked to the local checkout (`~/.local/bin/skills -> /home/daniel/build/skills-CLI/bin/cli.mjs`), so "installing" means `pnpm build`. Do not run `npm publish`.

### Syncing with upstream

```bash
git fetch upstream
git rebase upstream/main
pnpm install && pnpm build
git push --force-with-lease origin main  # rebase rewrites history; force-push is expected here
```

Force-pushing to `origin/main` is safe — it's your fork, nobody else branches off it. `--force-with-lease` prevents clobbering unexpected remote changes.

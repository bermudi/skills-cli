import { readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { stringify as stringifyYaml } from 'yaml';

import { parseFrontmatter } from './frontmatter.ts';
import { getCanonicalSkillsDir, sanitizeName, listInstalledSkills } from './installer.ts';
import { debug, debugFs } from './debug.ts';

/**
 * Read the frontmatter from an installed skill's SKILL.md.
 *
 * Called *before* `skills add` reinstalls the skill, so the file still
 * holds the user's locally-modified frontmatter.
 *
 * In symlink mode there's a single canonical SKILL.md. In copy mode,
 * `listInstalledSkills` deduplicates by scope:name, so we find at most
 * one agent copy — see `findInstalledSkillMdPaths` for the limitation.
 *
 * Returns the parsed frontmatter data, or null if the file can't be
 * found/read (e.g. skill not installed).
 */
export async function captureInstalledFrontmatter(
  skillName: string,
  global: boolean,
  cwd?: string
): Promise<Record<string, unknown> | null> {
  const paths = await findInstalledSkillMdPaths(skillName, global, cwd);
  if (paths.length === 0) {
    debug('preserve', `capture: no SKILL.md found for ${skillName} (global=${global})`);
    return null;
  }
  const skillMdPath = paths[0]!;
  try {
    const content = await readFile(skillMdPath, 'utf-8');
    const { data } = parseFrontmatter(content);
    debug('preserve', `capture: read ${Object.keys(data).length} keys from ${skillMdPath}`);
    return data;
  } catch (err) {
    debug('preserve', `capture: failed to read ${skillMdPath}: ${String(err).slice(0, 80)}`);
    return null;
  }
}

/**
 * After a fresh install, merge locally-modified frontmatter back into the
 * newly-written SKILL.md.
 *
 * For every key present in `localFm`, the local value takes precedence over
 * the upstream value. Keys only present upstream are kept as-is. This means
 * the user's local frontmatter additions and overrides survive updates.
 *
 * In symlink mode, there's a single canonical file. In copy mode,
 * `listInstalledSkills` deduplicates by scope:name, so we find at most
 * one agent copy — see `findInstalledSkillMdPaths` for the limitation.
 *
 * Trade-off: this can mask intentional upstream frontmatter changes (e.g.
 * a typo fix in `description`). Use `--no-preserve-frontmatter` to get a
 * clean upstream copy on update.
 *
 * Note: YAML re-serialization reformats the entire frontmatter block —
 * comments are lost and key order follows `{ ...upstreamFm, ...localFm }`.
 * See AGENTS.md for details.
 */
export async function restoreFrontmatter(
  skillName: string,
  localFm: Record<string, unknown>,
  global: boolean,
  cwd?: string
): Promise<boolean> {
  if (Object.keys(localFm).length === 0) {
    debug('preserve', `restore: no local frontmatter for ${skillName} — skipping`);
    return true;
  }

  const paths = await findInstalledSkillMdPaths(skillName, global, cwd);
  if (paths.length === 0) {
    debug('preserve', `restore: no SKILL.md found for ${skillName} — local frontmatter lost`);
    return false;
  }

  let allOk = true;
  for (const skillMdPath of paths) {
    const ok = await restoreFrontmatterAtPath(skillMdPath, skillName, localFm);
    if (!ok) allOk = false;
  }
  return allOk;
}

/**
 * Merge local frontmatter into a single SKILL.md file.
 */
async function restoreFrontmatterAtPath(
  skillMdPath: string,
  skillName: string,
  localFm: Record<string, unknown>
): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(skillMdPath, 'utf-8');
  } catch (err) {
    debug('preserve', `restore: failed to read ${skillMdPath}: ${String(err).slice(0, 80)}`);
    return false;
  }

  let upstreamFm: Record<string, unknown>;
  let body: string;
  try {
    ({ data: upstreamFm, content: body } = parseFrontmatter(content));
  } catch (err) {
    debug('preserve', `restore: failed to parse ${skillMdPath}: ${String(err).slice(0, 80)}`);
    return false;
  }

  // Merge: local frontmatter wins for any key it has.
  const merged: Record<string, unknown> = { ...upstreamFm, ...localFm };

  // Skip the write if nothing actually changed.
  const changed = Object.keys(localFm).some(
    (k) => JSON.stringify(merged[k]) !== JSON.stringify(upstreamFm[k])
  );
  if (!changed) {
    debug(
      'preserve',
      `restore: no frontmatter diff for ${skillName} at ${skillMdPath} — skipping write`
    );
    return true;
  }

  // Reconstruct the SKILL.md with merged frontmatter.
  // Ensure a blank line between the closing --- and the body, matching
  // SKILL.md convention. If the body already starts with a newline, don't
  // add an extra one.
  try {
    const yamlStr = stringifyYaml(merged);
    const bodyPrefix = body.startsWith('\n') ? '' : '\n';
    const newContent = `---\n${yamlStr}---\n${bodyPrefix}${body}`;

    debugFs('writeFile', skillMdPath, { bytes: newContent.length, reason: 'merge-frontmatter' });
    await writeFile(skillMdPath, newContent, 'utf-8');
    debug(
      'preserve',
      `restore: wrote merged frontmatter to ${skillMdPath} (${Object.keys(localFm).length} local keys)`
    );
    return true;
  } catch (err) {
    debug('preserve', `restore: failed to write ${skillMdPath}: ${String(err).slice(0, 80)}`);
    return false;
  }
}

/**
 * Find SKILL.md paths for an installed skill.
 *
 * In symlink mode, the file lives at the canonical location
 * (`.agents/skills/<name>/SKILL.md`) and agent dirs symlink to it —
 * so there's one real file.
 *
 * In copy mode, each agent gets its own copy at
 * `<agentDir>/skills/<name>/SKILL.md`. However, `listInstalledSkills`
 * deduplicates by `scope:name`, so it returns only one path per skill.
 * This means we find at most one agent copy in copy mode.
 *
 * Limitation: if the user edited frontmatter in a specific agent's copy
 * (copy mode) and that copy is not the one `listInstalledSkills` returns,
 * the edit will be missed by `captureInstalledFrontmatter`. This is
 * documented in AGENTS.md. In practice, `skills update` reinstalls via
 * `skills add` which uses symlink mode, so after reinstall the canonical
 * path exists and `restoreFrontmatter` writes to it correctly.
 *
 * Returns the canonical path first (if it exists), then any additional
 * path from `listInstalledSkills` (if different from canonical).
 */
async function findInstalledSkillMdPaths(
  skillName: string,
  global: boolean,
  cwd?: string
): Promise<string[]> {
  const paths: string[] = [];
  const seen = new Set<string>();

  // Try canonical location first (works for symlink mode — the common case).
  const canonicalDir = getCanonicalSkillsDir(global, cwd);
  const canonicalPath = join(canonicalDir, sanitizeName(skillName), 'SKILL.md');
  try {
    await stat(canonicalPath);
    paths.push(canonicalPath);
    seen.add(canonicalPath);
  } catch {
    // Not at canonical location — might be copy mode.
  }

  // Also check listInstalledSkills for copy-mode installs where the file
  // lives in agent-specific directories. In symlink mode this will find
  // the same canonical path (already in `paths`) or symlinks pointing to it.
  try {
    const skills = await listInstalledSkills({ global, cwd });
    for (const s of skills) {
      if (s.name === skillName) {
        const p = join(s.path, 'SKILL.md');
        if (!seen.has(p)) {
          paths.push(p);
          seen.add(p);
        }
      }
    }
  } catch {
    // listInstalledSkills failed — nothing we can do.
  }

  return paths;
}

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { captureInstalledFrontmatter, restoreFrontmatter } from '../src/frontmatter-preserve.ts';
import { parseFrontmatter } from '../src/frontmatter.ts';

describe('frontmatter-preserve', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skills-fm-preserve-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Create a fake installed skill at the canonical project-scoped path:
   *   <tempDir>/.agents/skills/<sanitizedName>/SKILL.md
   */
  async function installSkill(name: string, content: string): Promise<string> {
    const skillDir = join(tempDir, '.agents', 'skills', name);
    await mkdir(skillDir, { recursive: true });
    const skillMdPath = join(skillDir, 'SKILL.md');
    await writeFile(skillMdPath, content, 'utf-8');
    return skillMdPath;
  }

  describe('captureInstalledFrontmatter', () => {
    it('reads frontmatter from an installed skill', async () => {
      await installSkill(
        'my-skill',
        `---
name: my-skill
description: A test skill
disable-model-invocation: true
---

# My Skill
`
      );

      const fm = await captureInstalledFrontmatter('my-skill', false, tempDir);
      expect(fm).not.toBeNull();
      expect(fm!['name']).toBe('my-skill');
      expect(fm!['description']).toBe('A test skill');
      expect(fm!['disable-model-invocation']).toBe(true);
    });

    it('returns null when the skill is not installed', async () => {
      const fm = await captureInstalledFrontmatter('nonexistent', false, tempDir);
      expect(fm).toBeNull();
    });

    it('returns empty object for a skill with no frontmatter', async () => {
      await installSkill('no-fm', '# Just a body, no frontmatter\n');
      const fm = await captureInstalledFrontmatter('no-fm', false, tempDir);
      expect(fm).toEqual({});
    });
  });

  describe('restoreFrontmatter', () => {
    it('preserves a locally-added field that upstream lacks', async () => {
      // Simulate: user installed a skill, then added disable-model-invocation: true
      const skillMdPath = await installSkill(
        'my-skill',
        `---
name: my-skill
description: A test skill
disable-model-invocation: true
---

# My Skill
`
      );

      // Capture the local frontmatter (with the user's addition)
      const localFm = await captureInstalledFrontmatter('my-skill', false, tempDir);
      expect(localFm!['disable-model-invocation']).toBe(true);

      // Simulate `skills add` overwriting with a fresh upstream copy that
      // does NOT have disable-model-invocation
      await writeFile(
        skillMdPath,
        `---
name: my-skill
description: A test skill
---

# My Skill
`,
        'utf-8'
      );

      // Restore: should merge the local field back
      await restoreFrontmatter('my-skill', localFm!, false, tempDir);

      const restored = await readFile(skillMdPath, 'utf-8');
      const { data } = parseFrontmatter(restored);
      expect(data['disable-model-invocation']).toBe(true);
      // Upstream fields should still be present
      expect(data['name']).toBe('my-skill');
      expect(data['description']).toBe('A test skill');
    });

    it('preserves a locally-overridden field value', async () => {
      // User changed the description locally
      const skillMdPath = await installSkill(
        'my-skill',
        `---
name: my-skill
description: My custom description
---

# My Skill
`
      );

      const localFm = await captureInstalledFrontmatter('my-skill', false, tempDir);

      // Upstream ships a different description
      await writeFile(
        skillMdPath,
        `---
name: my-skill
description: Upstream description
---

# My Skill
`,
        'utf-8'
      );

      await restoreFrontmatter('my-skill', localFm!, false, tempDir);

      const restored = await readFile(skillMdPath, 'utf-8');
      const { data } = parseFrontmatter(restored);
      // Local value wins
      expect(data['description']).toBe('My custom description');
    });

    it('keeps new upstream fields the user never touched', async () => {
      const skillMdPath = await installSkill(
        'my-skill',
        `---
name: my-skill
description: A test skill
disable-model-invocation: true
---

# My Skill
`
      );

      const localFm = await captureInstalledFrontmatter('my-skill', false, tempDir);

      // Upstream adds a new field the user never had
      await writeFile(
        skillMdPath,
        `---
name: my-skill
description: A test skill
metadata:
  internal: true
---

# My Skill
`,
        'utf-8'
      );

      await restoreFrontmatter('my-skill', localFm!, false, tempDir);

      const restored = await readFile(skillMdPath, 'utf-8');
      const { data } = parseFrontmatter(restored);
      // Local addition preserved
      expect(data['disable-model-invocation']).toBe(true);
      // Upstream addition also kept
      expect((data['metadata'] as Record<string, unknown>)?.['internal']).toBe(true);
    });

    it('skips write when nothing changed', async () => {
      const skillMdPath = await installSkill(
        'my-skill',
        `---
name: my-skill
description: A test skill
---

# My Skill
`
      );

      const localFm = await captureInstalledFrontmatter('my-skill', false, tempDir);

      // "Reinstall" with identical content
      await writeFile(
        skillMdPath,
        `---
name: my-skill
description: A test skill
---

# My Skill
`,
        'utf-8'
      );

      const beforeRestore = await readFile(skillMdPath, 'utf-8');
      await restoreFrontmatter('my-skill', localFm!, false, tempDir);
      const afterRestore = await readFile(skillMdPath, 'utf-8');

      // If the write was skipped, the raw content is unchanged.
      // If the write happened, YAML re-serialization would reformat it.
      expect(afterRestore).toBe(beforeRestore);
    });

    it('adds frontmatter to a fresh copy that had none', async () => {
      // User had frontmatter, upstream ships without any
      const skillMdPath = await installSkill(
        'my-skill',
        `---
name: my-skill
description: A test skill
disable-model-invocation: true
---

# My Skill
`
      );

      const localFm = await captureInstalledFrontmatter('my-skill', false, tempDir);

      // Upstream copy has no frontmatter at all
      await writeFile(skillMdPath, '# My Skill\n', 'utf-8');

      await restoreFrontmatter('my-skill', localFm!, false, tempDir);

      const restored = await readFile(skillMdPath, 'utf-8');
      const { data, content } = parseFrontmatter(restored);
      expect(data['disable-model-invocation']).toBe(true);
      expect(data['name']).toBe('my-skill');
      expect(content.trim()).toBe('# My Skill');
    });

    it('is a no-op when localFm is empty', async () => {
      const skillMdPath = await installSkill(
        'my-skill',
        `---
name: my-skill
description: A test skill
---

# My Skill
`
      );

      const before = await readFile(skillMdPath, 'utf-8');
      await restoreFrontmatter('my-skill', {}, false, tempDir);
      const after = await readFile(skillMdPath, 'utf-8');
      expect(after).toBe(before);
    });

    it('handles nested metadata fields', async () => {
      const skillMdPath = await installSkill(
        'my-skill',
        `---
name: my-skill
description: A test skill
metadata:
  internal: true
  priority: high
disable-model-invocation: true
---

# My Skill
`
      );

      const localFm = await captureInstalledFrontmatter('my-skill', false, tempDir);

      // Upstream has different metadata
      await writeFile(
        skillMdPath,
        `---
name: my-skill
description: A test skill
metadata:
  internal: false
  version: 2
---

# My Skill
`,
        'utf-8'
      );

      await restoreFrontmatter('my-skill', localFm!, false, tempDir);

      const restored = await readFile(skillMdPath, 'utf-8');
      const { data } = parseFrontmatter(restored);
      // Local metadata wins entirely (shallow merge at top level)
      expect((data['metadata'] as Record<string, unknown>)?.['internal']).toBe(true);
      expect((data['metadata'] as Record<string, unknown>)?.['priority']).toBe('high');
      // Upstream's metadata.version is lost because local metadata overrides wholesale
      expect((data['metadata'] as Record<string, unknown>)?.['version']).toBeUndefined();
      // Local disable-model-invocation preserved
      expect(data['disable-model-invocation']).toBe(true);
    });

    it('returns false when upstream YAML is invalid (does not throw)', async () => {
      const skillMdPath = await installSkill(
        'my-skill',
        `---
name: my-skill
description: A test skill
disable-model-invocation: true
---

# My Skill`
      );

      const localFm = await captureInstalledFrontmatter('my-skill', false, tempDir);

      // Simulate `skills add` writing a corrupted upstream copy with invalid YAML
      await writeFile(skillMdPath, '---\nname: [unclosed\n---\n# Body\n', 'utf-8');

      // Should not throw — should return false
      const result = await restoreFrontmatter('my-skill', localFm!, false, tempDir);
      expect(result).toBe(false);
    });
  });

  describe('end-to-end: capture then restore after simulated reinstall', () => {
    it('preserves disable-model-invocation across a full update cycle', async () => {
      const skillMdPath = await installSkill(
        'hidden-skill',
        `---
name: hidden-skill
description: Should not be auto-invoked
disable-model-invocation: true
---

# Hidden Skill

Body content.
`
      );

      // Step 1: capture before update
      const localFm = await captureInstalledFrontmatter('hidden-skill', false, tempDir);
      expect(localFm!['disable-model-invocation']).toBe(true);

      // Step 2: simulate `skills add` writing a fresh upstream copy
      await writeFile(
        skillMdPath,
        `---
name: hidden-skill
description: Should not be auto-invoked
---

# Hidden Skill

Body content updated upstream.
`,
        'utf-8'
      );

      // Step 3: restore local frontmatter
      await restoreFrontmatter('hidden-skill', localFm!, false, tempDir);

      // Verify: the field is back, and the upstream body update is preserved
      const final = await readFile(skillMdPath, 'utf-8');
      const { data, content } = parseFrontmatter(final);
      expect(data['disable-model-invocation']).toBe(true);
      expect(content).toContain('Body content updated upstream.');
    });

    it('adds blank line between frontmatter and body when body had none', async () => {
      // User had frontmatter, upstream ships without any frontmatter
      const skillMdPath = await installSkill(
        'my-skill',
        `---
name: my-skill
description: A test skill
disable-model-invocation: true
---

# My Skill
`
      );

      const localFm = await captureInstalledFrontmatter('my-skill', false, tempDir);

      // Upstream copy has no frontmatter — just body, no leading newline
      await writeFile(skillMdPath, '# My Skill\n', 'utf-8');

      await restoreFrontmatter('my-skill', localFm!, false, tempDir);

      const restored = await readFile(skillMdPath, 'utf-8');
      // Should have a blank line between closing --- and the body
      expect(restored).toMatch(/---\n\n# My Skill/);
    });
  });

  describe('copy mode: multiple agent copies', () => {
    /**
     * In copy mode, a skill is installed to multiple agent-specific dirs,
     * NOT the canonical .agents/skills/ dir. We simulate this by writing
     * SKILL.md files to fake agent dirs. listInstalledSkills scans these
     * dirs (via detectInstalledAgents), but for this test we only need
     * the fallback path in findInstalledSkillMdPaths to find them.
     *
     * Since listInstalledSkills depends on detectInstalledAgents (which
     * checks for real agent installations), we can't easily test the full
     * multi-agent restore. Instead, we test that restoreFrontmatter writes
     * to the canonical path when it exists, and that capture reads from it.
     * The multi-agent copy mode path is exercised via the listInstalledSkills
     * fallback, which requires real agent dirs — covered by integration tests.
     */

    it('restore writes to canonical path when no agent dirs exist', async () => {
      const skillMdPath = await installSkill(
        'my-skill',
        `---
name: my-skill
description: A test skill
disable-model-invocation: true
---

# My Skill
`
      );

      const localFm = await captureInstalledFrontmatter('my-skill', false, tempDir);
      expect(localFm).not.toBeNull();

      // Simulate upstream overwrite
      await writeFile(
        skillMdPath,
        `---
name: my-skill
description: A test skill
---

# My Skill
`,
        'utf-8'
      );

      await restoreFrontmatter('my-skill', localFm!, false, tempDir);

      const restored = await readFile(skillMdPath, 'utf-8');
      const { data } = parseFrontmatter(restored);
      expect(data['disable-model-invocation']).toBe(true);
    });
  });
});

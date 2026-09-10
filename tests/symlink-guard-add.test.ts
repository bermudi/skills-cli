/**
 * End-to-end: `skills add` must refuse to install over a live symlink
 * (e.g. a developer's checkout linked into .agents/skills), preserve the
 * link and its target, and exit non-zero so `skills update` — which keys
 * on the child's exit status — does not report a false success.
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, readFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from '../src/test-utils.ts';

describe('add over a live symlink', () => {
  it('refuses, preserves the link, and exits non-zero', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skills-guard-e2e-'));
    const projectDir = join(root, 'project');
    await mkdir(join(projectDir, '.agents/skills'), { recursive: true });

    // Developer's checkout, linked into the canonical skills dir
    const externalDir = join(root, 'repo', 'my-skill');
    await mkdir(externalDir, { recursive: true });
    await writeFile(
      join(externalDir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: dev\n---\nDEV\n'
    );
    const linkedDir = join(projectDir, '.agents/skills/my-skill');
    await symlink(externalDir, linkedDir);

    // Upstream copy the user asks skills to install
    const upstream = join(root, 'upstream', 'my-skill');
    await mkdir(upstream, { recursive: true });
    await writeFile(
      join(upstream, 'SKILL.md'),
      '---\nname: my-skill\ndescription: upstream\n---\nUPSTREAM\n'
    );

    try {
      const result = runCli(
        ['add', join(root, 'upstream'), '--skill', 'my-skill', '--agent', 'codex', '-y'],
        projectDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Refusing to replace symlink');
      expect((await lstat(linkedDir)).isSymbolicLink()).toBe(true);
      await expect(readFile(join(externalDir, 'SKILL.md'), 'utf-8')).resolves.toContain('DEV');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

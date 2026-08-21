import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import {
  updateProjectSkills,
  updateGlobalSkills,
  runUpdate,
  parseUpdateOptions,
  processWellKnownUpdates,
} from '../src/update.ts';
import { captureInstalledFrontmatter, restoreFrontmatter } from '../src/frontmatter-preserve.ts';
import * as git from '../src/git.ts';
import * as skills from '../src/skills.ts';
import * as blob from '../src/blob.ts';
import * as localLock from '../src/local-lock.ts';
import * as skillLock from '../src/skill-lock.ts';
import * as remove from '../src/remove.ts';
import { detectInstalledAgents, getEveSubagents, getUniversalAgents } from '../src/agents.ts';
import * as p from '@clack/prompts';
import { readFileSync } from 'fs';
import { lstat } from 'fs/promises';
import { join } from 'path';

// Mock dependencies
vi.mock('../src/git.ts');
vi.mock('../src/skills.ts');
vi.mock('../src/blob.ts');
vi.mock('../src/local-lock.ts');
vi.mock('../src/skill-lock.ts');
vi.mock('../src/remove.ts');
vi.mock('@clack/prompts');
vi.mock('../src/providers/index.ts', () => ({
  wellKnownProvider: { fetchIndex: vi.fn(), fetchSkillByEntry: vi.fn() },
  computeWellKnownSkillDigest: vi.fn(),
}));

// Control detectInstalledAgents/getEveSubagents so legacy inference gets
// predictable results regardless of what is actually installed on the host.
vi.mock('../src/agents.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agents.ts')>();
  return {
    ...actual,
    detectInstalledAgents: vi.fn().mockResolvedValue(['claude-code']),
    getEveSubagents: vi.fn().mockReturnValue([]),
  };
});

// Allow per-test control of lstat (used by inferInstalledAgents for legacy entries).
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

// Mock frontmatter-preserve so we can verify capture/restore are called/skipped
vi.mock('../src/frontmatter-preserve.ts', () => ({
  captureInstalledFrontmatter: vi.fn().mockResolvedValue(null),
  restoreFrontmatter: vi.fn().mockResolvedValue(true),
}));

// Mock well-known provider for processWellKnownUpdates tests
vi.mock('../src/providers/index.ts', () => ({
  wellKnownProvider: {
    fetchIndex: vi.fn().mockResolvedValue(null),
    fetchSkillByEntry: vi.fn().mockResolvedValue(null),
  },
  computeWellKnownSkillDigest: vi.fn().mockReturnValue('digest'),
}));

// Mock fs to prevent actual file checks during test
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true), // Assume CLI entrypoint exists
    readFileSync: vi.fn().mockImplementation((path, encoding) => {
      if (typeof path === 'string' && path.endsWith('.skill-lock.json')) {
        return JSON.stringify({
          version: 3,
          skills: {
            'skill-a': {
              source: 'owner/repo',
              skillPath: 'skills/skill-a/SKILL.md',
              sourceType: 'github',
              skillFolderHash: 'abc',
              installedAt: '',
              updatedAt: '',
            },
            'skill-b': {
              source: 'owner/repo',
              skillPath: 'skills/skill-b/SKILL.md',
              sourceType: 'github',
              skillFolderHash: 'def',
              installedAt: '',
              updatedAt: '',
            },
          },
        });
      }
      // Fall back to actual readFileSync for other files (like package.json if needed)
      try {
        return actual.readFileSync(path, encoding);
      } catch {
        return '';
      }
    }),
  };
});

// Mock child_process to prevent actual command execution
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn().mockReturnValue({ status: 0 }), // Mock spawnSync for updates
  };
});

describe('Update Cleanup Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    process.env.DISABLE_TELEMETRY = '1';
    // Default mock for isTTY
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    // Default: skill exists in Claude Code's skills dir only, so legacy lock
    // entries (without an `agents` field) infer claude-code as the placement.
    vi.mocked(lstat).mockImplementation((path) => {
      if (typeof path === 'string' && path.includes('.claude')) {
        return Promise.resolve({} as never);
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('updateProjectSkills', () => {
    it('should prompt to remove deleted skill on update', async () => {
      // Mock local lock with 2 skills from same source
      vi.mocked(localLock.readLocalLock).mockResolvedValue({
        version: 1,
        skills: {
          'skill-a': {
            source: 'owner/repo',
            skillPath: 'skills/skill-a/SKILL.md',
            sourceType: 'github',
            computedHash: 'abc',
          },
          'skill-b': {
            source: 'owner/repo',
            skillPath: 'skills/skill-b/SKILL.md',
            sourceType: 'github',
            computedHash: 'def',
          },
        },
      });

      // Mock git clone
      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');

      // Mock discoverSkills to return only skill-a
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        { name: 'skill-a', path: '/tmp/repo/skills/skill-a', description: 'A', rawContent: '' },
      ]);

      // Mock confirm to say yes
      vi.mocked(p.confirm).mockResolvedValue(true);

      // Run update
      await updateProjectSkills();

      // Verify prompt was shown
      expect(p.confirm).toHaveBeenCalled();

      // Verify removeCommand was called for skill-b
      expect(remove.removeCommand).toHaveBeenCalledWith(
        ['skill-b'],
        expect.objectContaining({ yes: true, global: false })
      );
    });

    it('should skip deletion in non-interactive mode', async () => {
      vi.mocked(localLock.readLocalLock).mockResolvedValue({
        version: 1,
        skills: {
          'skill-a': {
            source: 'owner/repo',
            skillPath: 'skills/skill-a/SKILL.md',
            sourceType: 'github',
            computedHash: 'abc',
          },
          'skill-b': {
            source: 'owner/repo',
            skillPath: 'skills/skill-b/SKILL.md',
            sourceType: 'github',
            computedHash: 'def',
          },
        },
      });

      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        { name: 'skill-a', path: '/tmp/repo/skills/skill-a', description: 'A', rawContent: '' },
      ]);

      // Run update with yes: true (non-interactive)
      await updateProjectSkills({ yes: true });

      // Verify prompt was NOT shown
      expect(p.confirm).not.toHaveBeenCalled();

      // Verify removeCommand was NOT called
      expect(remove.removeCommand).not.toHaveBeenCalled();
    });

    it('should skip deletion when isTTY is false', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        configurable: true,
      });

      vi.mocked(localLock.readLocalLock).mockResolvedValue({
        version: 1,
        skills: {
          'skill-a': {
            source: 'owner/repo',
            skillPath: 'skills/skill-a/SKILL.md',
            sourceType: 'github',
            computedHash: 'abc',
          },
          'skill-b': {
            source: 'owner/repo',
            skillPath: 'skills/skill-b/SKILL.md',
            sourceType: 'github',
            computedHash: 'def',
          },
        },
      });

      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        { name: 'skill-a', path: '/tmp/repo/skills/skill-a', description: 'A', rawContent: '' },
      ]);

      await updateProjectSkills();

      expect(p.confirm).not.toHaveBeenCalled();
      expect(remove.removeCommand).not.toHaveBeenCalled();
    });

    it('uses full-depth discovery for project deletion checks', async () => {
      vi.mocked(localLock.readLocalLock).mockResolvedValue({
        version: 1,
        skills: {
          'help-me-read': {
            source: 'owner/repo',
            sourceType: 'github',
            skillPath: 'plugins/help-me-read/skills/help-me-read/SKILL.md',
            computedHash: 'old-hash',
          },
        },
      });
      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
      vi.mocked(skills.discoverSkills).mockImplementation(async (_path, _subpath, options) =>
        options?.fullDepth
          ? [
              {
                name: 'help-me-read',
                path: '/tmp/repo/plugins/help-me-read/skills/help-me-read',
                description: 'Deep skill',
                rawContent: '',
              },
            ]
          : []
      );

      await updateProjectSkills();

      expect(skills.discoverSkills).toHaveBeenCalledWith('/tmp/repo', undefined, {
        fullDepth: true,
        includeDuplicateNames: true,
      });
      expect(p.confirm).not.toHaveBeenCalled();
      expect(remove.removeCommand).not.toHaveBeenCalled();
    });

    it('updates a relocated project skill from its canonical path', async () => {
      vi.mocked(localLock.readLocalLock).mockResolvedValue({
        version: 1,
        skills: {
          'swiftui-expert-skill': {
            source: 'owner/repo',
            sourceType: 'github',
            skillPath: 'swiftui-expert-skill/SKILL.md',
            computedHash: 'same-hash',
          },
        },
      });
      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        {
          name: 'swiftui-expert-skill',
          path: '/tmp/repo/skills/swiftui-expert-skill',
          description: 'SwiftUI guidance',
          rawContent: '',
        },
      ]);

      await updateProjectSkills({ yes: true });

      expect(p.confirm).not.toHaveBeenCalled();
      expect(remove.removeCommand).not.toHaveBeenCalled();
      const installCall = vi
        .mocked(spawnSync)
        .mock.calls.find((call) => Array.isArray(call[1]) && call[1].includes('add'));
      expect(installCall).toBeDefined();
      expect(installCall![1]).toContain('owner/repo/skills/swiftui-expert-skill');
    });

    it('skips an ambiguous relocated project skill without deleting it', async () => {
      vi.mocked(localLock.readLocalLock).mockResolvedValue({
        version: 1,
        skills: {
          'skill-a': {
            source: 'owner/repo',
            sourceType: 'github',
            skillPath: 'old/skill-a/SKILL.md',
            computedHash: 'old-hash',
          },
        },
      });
      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        {
          name: 'skill-a',
          path: '/tmp/repo/skills/skill-a',
          description: 'First',
          rawContent: '',
        },
        {
          name: 'skill-a',
          path: '/tmp/repo/plugins/example/skill-a',
          description: 'Second',
          rawContent: '',
        },
      ]);

      await updateProjectSkills({ yes: true });

      expect(p.confirm).not.toHaveBeenCalled();
      expect(remove.removeCommand).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it('does not reinstall an ambiguous exact-path skill from a generic Git source', async () => {
      vi.mocked(localLock.readLocalLock).mockResolvedValue({
        version: 1,
        skills: {
          'skill-a': {
            source: 'owner/repo',
            sourceUrl: 'git@example.com:owner/repo.git',
            sourceType: 'git',
            skillPath: 'skills/skill-a/SKILL.md',
            computedHash: 'old-hash',
          },
        },
      });
      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        {
          name: 'skill-a',
          path: '/tmp/repo/skills/skill-a',
          description: 'Locked location',
          rawContent: '',
        },
        {
          name: 'skill-a',
          path: '/tmp/repo/plugins/example/skill-a',
          description: 'Conflicting location',
          rawContent: '',
        },
      ]);

      await updateProjectSkills({ yes: true });

      expect(p.confirm).not.toHaveBeenCalled();
      expect(remove.removeCommand).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it('does not reinstall project skills when source discovery fails', async () => {
      vi.mocked(localLock.readLocalLock).mockResolvedValue({
        version: 1,
        skills: {
          'skill-a': {
            source: 'owner/repo',
            sourceUrl: 'git@example.com:owner/repo.git',
            sourceType: 'git',
            skillPath: 'skills/skill-a/SKILL.md',
            computedHash: 'old-hash',
          },
        },
      });
      vi.mocked(git.cloneRepo).mockRejectedValue(new Error('clone failed'));

      const result = await updateProjectSkills({ yes: true });

      expect(result.failCount).toBe(1);
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it('uses sourceUrl for self-hosted GitLab project updates', async () => {
      vi.mocked(localLock.readLocalLock).mockResolvedValue({
        version: 1,
        skills: {
          'skill-a': {
            source: 'acme/skills',
            sourceUrl: 'https://gitlab.example.com/acme/skills.git',
            skillPath: 'plugins/example/skills/skill-a/SKILL.md',
            sourceType: 'git',
            computedHash: 'abc',
          },
        },
      });

      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        {
          name: 'skill-a',
          path: '/tmp/repo/plugins/example/skills/skill-a',
          description: 'Deep skill',
          rawContent: '',
        },
      ]);

      await updateProjectSkills({ yes: true });

      expect(git.cloneRepo).toHaveBeenCalledWith(
        'https://gitlab.example.com/acme/skills.git',
        undefined
      );
      const installCall = vi
        .mocked(spawnSync)
        .mock.calls.find((call) => Array.isArray(call[1]) && call[1].includes('add'));
      expect(installCall).toBeDefined();
      const [, argv] = installCall!;
      expect(argv).toEqual(
        expect.arrayContaining(['add', 'https://gitlab.example.com/acme/skills.git', '--skill'])
      );
      expect(argv).not.toEqual(expect.arrayContaining(['acme/skills']));
      expect(argv).toContain('--full-depth');
    });

    it('normalizes GitHub shorthand for deletion checks and keeps updates path-targeted', async () => {
      vi.mocked(localLock.readLocalLock).mockResolvedValue({
        version: 1,
        skills: {
          'skill-a': {
            source: 'owner/repo',
            sourceType: 'github',
            skillPath: 'plugins/example/skills/skill-a/SKILL.md',
            computedHash: 'abc',
          },
        },
      });
      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        {
          name: 'skill-a',
          path: '/tmp/repo/plugins/example/skills/skill-a',
          description: 'Deep skill',
          rawContent: '',
        },
      ]);

      await updateProjectSkills({ yes: true });

      expect(git.cloneRepo).toHaveBeenCalledWith('https://github.com/owner/repo.git', undefined);
      const installCall = vi
        .mocked(spawnSync)
        .mock.calls.find((call) => Array.isArray(call[1]) && call[1].includes('add'));
      expect(installCall).toBeDefined();
      const [, argv] = installCall!;
      expect(argv).toContain('owner/repo/plugins/example/skills/skill-a');
      expect(argv).not.toContain('--full-depth');
    });

    it('pins public GitHub project updates to github.com when GH_HOST points elsewhere', async () => {
      vi.stubEnv('GH_HOST', 'github.example.com');
      vi.mocked(localLock.readLocalLock).mockResolvedValue({
        version: 1,
        skills: {
          'skill-a': {
            source: 'owner/repo',
            skillPath: 'skills/skill-a/SKILL.md',
            sourceType: 'github',
            computedHash: 'abc',
          },
        },
      });

      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        { name: 'skill-a', path: '/tmp/repo/skills/skill-a', description: 'A', rawContent: '' },
      ]);

      await updateProjectSkills({ yes: true });

      const installCall = vi
        .mocked(spawnSync)
        .mock.calls.find((call) => Array.isArray(call[1]) && call[1].includes('add'));
      expect(installCall).toBeDefined();
      const [, argv, options] = installCall!;
      expect(argv).toEqual(
        expect.arrayContaining(['add', 'owner/repo/skills/skill-a', '--skill', 'skill-a'])
      );
      expect((options as { env?: NodeJS.ProcessEnv }).env?.GH_HOST).toBe('github.com');
    });

    it('does not reinterpret generic git shorthands as GitHub during project update', async () => {
      vi.mocked(localLock.readLocalLock).mockResolvedValue({
        version: 1,
        skills: {
          'skill-a': {
            source: 'acme/skills',
            skillPath: 'skills/skill-a/SKILL.md',
            sourceType: 'git',
            computedHash: 'abc',
          },
        },
      });

      const result = await updateProjectSkills({ yes: true });

      expect(result.failCount).toBe(1);
      expect(git.cloneRepo).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
    });
  });

  describe('updateGlobalSkills', () => {
    it('should prompt to remove deleted skill on global update', async () => {
      // Mock readSkillLock
      vi.mocked(skillLock.readSkillLock).mockResolvedValue({
        version: 3,
        skills: {
          'skill-a': {
            source: 'owner/repo',
            skillPath: 'skills/skill-a/SKILL.md',
            sourceType: 'github',
            skillFolderHash: 'abc',
            installedAt: '',
            updatedAt: '',
          },
          'skill-b': {
            source: 'owner/repo',
            skillPath: 'skills/skill-b/SKILL.md',
            sourceType: 'github',
            skillFolderHash: 'def',
            installedAt: '',
            updatedAt: '',
          },
        },
      });

      vi.mocked(blob.fetchRepoTree).mockResolvedValue({
        sha: 'rootsha',
        branch: 'main',
        tree: [
          { path: 'skills/skill-a/SKILL.md', type: 'blob', sha: 'sha1' },
          { path: 'skills/skill-a', type: 'tree', sha: 'abc' },
        ],
      });
      vi.mocked(blob.findSkillMdPaths).mockReturnValue(['skills/skill-a/SKILL.md']);
      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        { name: 'skill-a', path: '/tmp/repo/skills/skill-a', description: 'A', rawContent: '' },
      ]);

      vi.mocked(p.confirm).mockResolvedValue(true);

      await updateGlobalSkills();

      expect(p.confirm).toHaveBeenCalled();
      expect(remove.removeCommand).toHaveBeenCalledWith(
        ['skill-b'],
        expect.objectContaining({ yes: true, global: true })
      );
    });

    it('reinstalls a relocated global skill even when its content hash is unchanged', async () => {
      const treeHash = 'a'.repeat(40);
      vi.mocked(skillLock.readSkillLock).mockResolvedValue({
        version: 3,
        skills: {
          'swiftui-expert-skill': {
            source: 'owner/repo',
            sourceType: 'github',
            skillPath: 'swiftui-expert-skill/SKILL.md',
            skillFolderHash: treeHash,
            installedAt: '',
            updatedAt: '',
          },
        },
      });
      vi.mocked(blob.fetchRepoTree).mockResolvedValue({
        sha: 'rootsha',
        branch: 'main',
        tree: [
          {
            path: 'skills/swiftui-expert-skill/SKILL.md',
            type: 'blob',
            sha: 'blobsha',
          },
          {
            path: 'skills/swiftui-expert-skill',
            type: 'tree',
            sha: treeHash,
          },
        ],
      });
      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        {
          name: 'swiftui-expert-skill',
          path: '/tmp/repo/skills/swiftui-expert-skill',
          description: 'SwiftUI guidance',
          rawContent: '',
        },
      ]);
      vi.mocked(git.getGitTreeHash).mockResolvedValue(treeHash);

      await updateGlobalSkills({ yes: true });

      expect(p.confirm).not.toHaveBeenCalled();
      expect(remove.removeCommand).not.toHaveBeenCalled();
      expect(git.getGitTreeHash).toHaveBeenCalledWith(
        '/tmp/repo',
        'skills/swiftui-expert-skill/SKILL.md'
      );
      const installCall = vi
        .mocked(spawnSync)
        .mock.calls.find((call) => Array.isArray(call[1]) && call[1].includes('add'));
      expect(installCall).toBeDefined();
      expect(installCall![1]).toContain('owner/repo/skills/swiftui-expert-skill');
    });

    it('does not report a locked plugin skill as deleted when it exists in the GitHub tree', async () => {
      vi.mocked(skillLock.readSkillLock).mockResolvedValue({
        version: 3,
        skills: {
          'help-me-read': {
            source: 'owner/repo',
            sourceUrl: 'https://github.com/owner/repo.git',
            sourceType: 'github',
            skillPath: 'plugins/help-me-read/skills/help-me-read/SKILL.md',
            skillFolderHash: 'deep-tree-sha',
            installedAt: '',
            updatedAt: '',
          },
        },
      });
      vi.mocked(blob.fetchRepoTree).mockResolvedValue({
        sha: 'rootsha',
        branch: 'main',
        tree: [
          { path: '.claude/skills/shallow/SKILL.md', type: 'blob', sha: 'shallow-blob' },
          {
            path: 'plugins/help-me-read/skills/help-me-read/SKILL.md',
            type: 'blob',
            sha: 'deep-blob',
          },
          {
            path: 'plugins/help-me-read/skills/help-me-read',
            type: 'tree',
            sha: 'deep-tree-sha',
          },
        ],
      });
      vi.mocked(blob.findSkillMdPaths).mockReturnValue(['.claude/skills/shallow/SKILL.md']);
      vi.mocked(p.confirm).mockResolvedValue(false);

      await updateGlobalSkills();

      expect(p.confirm).not.toHaveBeenCalled();
      expect(remove.removeCommand).not.toHaveBeenCalled();
    });

    it('does not delete a skill from the same repo pinned to a different ref', async () => {
      vi.mocked(skillLock.readSkillLock).mockResolvedValue({
        version: 3,
        skills: {
          'skill-a': {
            source: 'owner/repo',
            ref: 'v1',
            skillPath: 'skills/skill-a/SKILL.md',
            sourceType: 'github',
            skillFolderHash: 'abc',
            installedAt: '',
            updatedAt: '',
          },
          'skill-b': {
            source: 'owner/repo',
            ref: 'v2',
            skillPath: 'skills/skill-b/SKILL.md',
            sourceType: 'github',
            skillFolderHash: 'def',
            installedAt: '',
            updatedAt: '',
          },
        },
      });

      // Each ref exposes only its own skill.
      vi.mocked(blob.fetchRepoTree).mockImplementation(async (_source, ref) => {
        const isV2 = ref === 'v2';
        const dir = isV2 ? 'skills/skill-b' : 'skills/skill-a';
        return {
          sha: 'rootsha',
          branch: 'main',
          tree: [
            { path: `${dir}/SKILL.md`, type: 'blob', sha: 'blobsha' },
            { path: dir, type: 'tree', sha: isV2 ? 'def' : 'abc' },
          ],
        };
      });
      vi.mocked(p.confirm).mockResolvedValue(true);

      await updateGlobalSkills();

      // Before the fix, skill-b was grouped with skill-a by source alone and
      // checked against v1's tree, then reported deleted upstream and removed.
      expect(p.confirm).not.toHaveBeenCalled();
      expect(remove.removeCommand).not.toHaveBeenCalled();
    });

    it('checks a private GitHub update by cloning when authenticated API access is unavailable', async () => {
      vi.mocked(skillLock.readSkillLock).mockResolvedValue({
        version: 3,
        skills: {
          'skill-a': {
            source: 'owner/private-repo',
            sourceUrl: 'https://github.com/owner/private-repo.git',
            sourceType: 'github',
            skillPath: 'skills/skill-a/SKILL.md',
            skillFolderHash: 'old-content-hash',
            installedAt: '',
            updatedAt: '',
          },
        },
      });
      vi.mocked(blob.fetchRepoTree).mockResolvedValue(null);
      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/private-repo');
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        {
          name: 'skill-a',
          path: '/tmp/private-repo/skills/skill-a',
          description: 'Private skill',
          rawContent: '',
        },
      ]);
      vi.mocked(localLock.computeSkillFolderHash).mockResolvedValue('new-content-hash');

      await updateGlobalSkills({ yes: true });

      expect(git.cloneRepo).toHaveBeenCalledWith(
        'https://github.com/owner/private-repo.git',
        undefined
      );
      expect(localLock.computeSkillFolderHash).toHaveBeenCalledWith(
        join('/tmp/private-repo', 'skills/skill-a')
      );
      const installCall = vi
        .mocked(spawnSync)
        .mock.calls.find((call) => Array.isArray(call[1]) && call[1].includes('add'));
      expect(installCall).toBeDefined();
    });

    it('does not report an unchanged Git tree SHA as updated after an API fallback', async () => {
      const treeHash = 'a'.repeat(40);
      vi.mocked(skillLock.readSkillLock).mockResolvedValue({
        version: 3,
        skills: {
          'skill-a': {
            source: 'owner/private-repo',
            sourceUrl: 'git@github.com:owner/private-repo.git',
            sourceType: 'github',
            skillPath: 'skills/skill-a/SKILL.md',
            skillFolderHash: treeHash,
            installedAt: '',
            updatedAt: '',
          },
        },
      });
      vi.mocked(blob.fetchRepoTree).mockResolvedValue(null);
      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/private-repo');
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        {
          name: 'skill-a',
          path: '/tmp/private-repo/skills/skill-a',
          description: 'Private skill',
          rawContent: '',
        },
      ]);
      vi.mocked(git.getGitTreeHash).mockResolvedValue(treeHash);
      vi.mocked(localLock.computeSkillFolderHash).mockResolvedValue('b'.repeat(64));

      await updateGlobalSkills({ yes: true });

      expect(git.getGitTreeHash).toHaveBeenCalledWith(
        '/tmp/private-repo',
        'skills/skill-a/SKILL.md'
      );
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it('uses full-depth discovery for non-GitHub global deletion checks', async () => {
      vi.mocked(skillLock.readSkillLock).mockResolvedValue({
        version: 3,
        skills: {
          'deep-skill': {
            source: 'git@gitea.example.com:owner/repo.git',
            sourceUrl: 'git@gitea.example.com:owner/repo.git',
            sourceType: 'git',
            skillPath: 'plugins/example/skills/deep-skill/SKILL.md',
            skillFolderHash: 'same-hash',
            installedAt: '',
            updatedAt: '',
          },
        },
      });
      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
      vi.mocked(skills.discoverSkills).mockImplementation(async (_path, _subpath, options) =>
        options?.fullDepth
          ? [
              {
                name: 'deep-skill',
                path: '/tmp/repo/plugins/example/skills/deep-skill',
                description: 'Deep skill',
                rawContent: '',
              },
            ]
          : []
      );
      vi.mocked(localLock.computeSkillFolderHash).mockResolvedValue('same-hash');

      await updateGlobalSkills();

      expect(skills.discoverSkills).toHaveBeenCalledWith('/tmp/repo', undefined, {
        fullDepth: true,
        includeDuplicateNames: true,
      });
      expect(p.confirm).not.toHaveBeenCalled();
      expect(remove.removeCommand).not.toHaveBeenCalled();
    });

    it('should check global non-GitHub git sources by cloning', async () => {
      vi.mocked(skillLock.readSkillLock).mockResolvedValue({
        version: 3,
        skills: {
          'skill-a': {
            source: 'ssh://git@github.com/owner/repo',
            sourceUrl: 'ssh://git@github.com/owner/repo',
            skillPath: 'plugins/example/skills/skill-a/SKILL.md',
            sourceType: 'git',
            skillFolderHash: 'old-hash',
            installedAt: '',
            updatedAt: '',
          },
        },
      });

      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        {
          name: 'skill-a',
          path: '/tmp/repo/plugins/example/skills/skill-a',
          description: 'Deep skill',
          rawContent: '',
        },
      ]);
      vi.mocked(localLock.computeSkillFolderHash).mockResolvedValue('new-hash');

      await updateGlobalSkills({ yes: true });

      expect(git.cloneRepo).toHaveBeenCalledWith('ssh://git@github.com/owner/repo', undefined);
      expect(localLock.computeSkillFolderHash).toHaveBeenCalledWith(
        join('/tmp/repo', 'plugins/example/skills/skill-a')
      );
      const installCall = vi
        .mocked(spawnSync)
        .mock.calls.find((call) => Array.isArray(call[1]) && call[1].includes('add'));
      expect(installCall).toBeDefined();
      const [, argv] = installCall!;
      expect(argv).toContain('ssh://git@github.com/owner/repo');
      expect(argv).not.toContain('ssh://git@github.com/owner/repo/plugins/example/skills/skill-a');
      expect(argv).toContain('--full-depth');
    });

    it('uses sourceUrl when updating global non-GitHub sources with host-stripped source', async () => {
      vi.mocked(skillLock.readSkillLock).mockResolvedValue({
        version: 3,
        skills: {
          'skill-a': {
            source: 'acme/skills',
            sourceUrl: 'https://gitlab.example.com/acme/skills.git',
            skillPath: 'skills/skill-a/SKILL.md',
            sourceType: 'git',
            skillFolderHash: 'old-hash',
            installedAt: '',
            updatedAt: '',
          },
        },
      });

      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        { name: 'skill-a', path: '/tmp/repo/skills/skill-a', description: 'A', rawContent: '' },
      ]);
      vi.mocked(localLock.computeSkillFolderHash).mockResolvedValue('new-hash');

      await updateGlobalSkills({ yes: true });

      expect(git.cloneRepo).toHaveBeenCalledWith(
        'https://gitlab.example.com/acme/skills.git',
        undefined
      );
      const installCall = vi
        .mocked(spawnSync)
        .mock.calls.find((call) => Array.isArray(call[1]) && call[1].includes('add'));
      expect(installCall).toBeDefined();
      const [, argv] = installCall!;
      expect(argv).toEqual(
        expect.arrayContaining([
          'add',
          'https://gitlab.example.com/acme/skills.git',
          '--skill',
          'skill-a',
        ])
      );
      expect(argv).not.toEqual(expect.arrayContaining(['acme/skills']));
    });

    it('pins public GitHub global updates to github.com when GH_HOST points elsewhere', async () => {
      vi.stubEnv('GH_HOST', 'github.example.com');
      vi.mocked(skillLock.readSkillLock).mockResolvedValue({
        version: 3,
        skills: {
          'skill-a': {
            source: 'owner/repo',
            sourceUrl: 'https://github.com/owner/repo.git',
            skillPath: 'skills/skill-a/SKILL.md',
            sourceType: 'github',
            skillFolderHash: 'old-hash',
            installedAt: '',
            updatedAt: '',
          },
        },
      });

      vi.mocked(blob.fetchRepoTree).mockResolvedValue({
        sha: 'rootsha',
        branch: 'main',
        tree: [{ path: 'skills/skill-a/SKILL.md', type: 'blob', sha: 'new-hash' }],
      });
      vi.mocked(blob.findSkillMdPaths).mockReturnValue(['skills/skill-a/SKILL.md']);
      vi.mocked(blob.getSkillFolderHashFromTree).mockReturnValue('new-hash');

      await updateGlobalSkills({ yes: true });

      const installCall = vi
        .mocked(spawnSync)
        .mock.calls.find((call) => Array.isArray(call[1]) && call[1].includes('add'));
      expect(installCall).toBeDefined();
      const [, argv, options] = installCall!;
      expect(argv).toEqual(
        expect.arrayContaining(['add', 'owner/repo/skills/skill-a', '--skill', 'skill-a'])
      );
      expect((options as { env?: NodeJS.ProcessEnv }).env?.GH_HOST).toBe('github.com');
    });

    it('keeps GitHub Enterprise updates on their recorded URL and targets one skill', async () => {
      vi.stubEnv('GH_HOST', 'github.example.com');
      vi.mocked(skillLock.readSkillLock).mockResolvedValue({
        version: 3,
        skills: {
          'skill-a': {
            source: 'https://github.example.com/acme/skills.git',
            sourceUrl: 'https://github.example.com/acme/skills.git',
            skillPath: 'skills/skill-a/SKILL.md',
            sourceType: 'git',
            skillFolderHash: 'old-hash',
            installedAt: '',
            updatedAt: '',
          },
        },
      });

      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        { name: 'skill-a', path: '/tmp/repo/skills/skill-a', description: 'A', rawContent: '' },
      ]);
      vi.mocked(localLock.computeSkillFolderHash).mockResolvedValue('new-hash');

      await updateGlobalSkills({ yes: true });

      const installCall = vi
        .mocked(spawnSync)
        .mock.calls.find((call) => Array.isArray(call[1]) && call[1].includes('add'));
      expect(installCall).toBeDefined();
      const [, argv, options] = installCall!;
      expect(argv).toEqual(
        expect.arrayContaining([
          'add',
          'https://github.example.com/acme/skills.git',
          '--skill',
          'skill-a',
        ])
      );
      expect((options as { env?: NodeJS.ProcessEnv }).env).toBeUndefined();
    });

    it('spawns the update without a shell so a crafted ref cannot inject commands', async () => {
      // Force the Windows code path so this regression fails on the old
      // `shell: process.platform === 'win32'` even when the test host is not
      // Windows. The value is read inside spawnSync's options at call time.
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        vi.mocked(skillLock.readSkillLock).mockResolvedValue({
          version: 3,
          skills: {
            'skill-a': {
              source: 'owner/repo',
              skillPath: 'skills/skill-a/SKILL.md',
              sourceType: 'github',
              skillFolderHash: 'old-hash',
              // Attacker-influenceable ref carrying a shell metacharacter.
              ref: 'main&calc',
              installedAt: '',
              updatedAt: '',
            },
          },
        });

        vi.mocked(blob.fetchRepoTree).mockResolvedValue({
          sha: 'rootsha',
          branch: 'main',
          tree: [{ path: 'skills/skill-a/SKILL.md', type: 'blob', sha: 'sha1' }],
        });
        vi.mocked(blob.findSkillMdPaths).mockReturnValue(['skills/skill-a/SKILL.md']);
        // Latest hash differs from the lock -> an update is queued -> spawnSync runs.
        vi.mocked(blob.getSkillFolderHashFromTree).mockReturnValue('new-hash');

        await updateGlobalSkills({ yes: true });

        const installCall = vi
          .mocked(spawnSync)
          .mock.calls.find((call) => Array.isArray(call[1]) && call[1].includes('add'));
        expect(installCall).toBeDefined();

        const [, argv, options] = installCall!;
        // The security invariant: no shell, so argv is passed to execvp verbatim.
        expect((options as { shell?: boolean }).shell).toBe(false);
        // The crafted ref rides inside a discrete argv element, never a command string.
        expect(argv).toEqual(expect.arrayContaining([expect.stringContaining('main&calc')]));
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });

  describe('runUpdate exit status', () => {
    beforeEach(() => {
      vi.mocked(localLock.readLocalLock).mockResolvedValue({
        version: 1,
        skills: {
          'skill-a': {
            source: 'owner/repo',
            skillPath: 'skills/skill-a/SKILL.md',
            sourceType: 'github',
            computedHash: 'abc',
          },
        },
      });

      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        { name: 'skill-a', path: '/tmp/repo/skills/skill-a', description: 'A', rawContent: '' },
      ]);
    });

    it('sets a non-zero exit code when requested updates fail', async () => {
      vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);

      await runUpdate(['--project', '--yes']);

      expect(process.exitCode).toBe(1);
    });

    it('does not set a failure exit code when requested updates succeed', async () => {
      vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);

      await runUpdate(['--project', '--yes']);

      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('agent placement preservation', () => {
    const ENOENT = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

    // Resolve lstat only for paths containing every segment; with no segments,
    // reject everything (nothing on disk).
    function lstatExistsFor(...segments: string[]) {
      vi.mocked(lstat).mockImplementation((path) => {
        if (
          segments.length > 0 &&
          typeof path === 'string' &&
          segments.every((s) => path.includes(s))
        ) {
          return Promise.resolve({} as never);
        }
        return Promise.reject(ENOENT());
      });
    }

    // Return the argv of the spawned `add` reinstall command, or undefined.
    function findAddArgv(): string[] | undefined {
      const call = vi
        .mocked(spawnSync)
        .mock.calls.find((c) => Array.isArray(c[1]) && (c[1] as string[]).includes('add'));
      return call ? (call[1] as string[]) : undefined;
    }

    // Assert the exact ordered `--agent <ids...>` fragment within argv.
    function expectAgentFragment(argv: string[], ...agentIds: string[]) {
      const idx = argv.indexOf('--agent');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(argv.slice(idx, idx + agentIds.length + 1)).toEqual(['--agent', ...agentIds]);
    }

    function githubGlobalLock(agents?: string[]) {
      return {
        version: 3 as const,
        skills: {
          'skill-a': {
            source: 'owner/repo',
            sourceUrl: 'https://github.com/owner/repo.git',
            skillPath: 'skills/skill-a/SKILL.md',
            sourceType: 'github',
            skillFolderHash: 'old-hash',
            installedAt: '',
            updatedAt: '',
            ...(agents && { agents }),
          },
        },
      };
    }
    function githubProjectLock(agents?: string[]) {
      return {
        version: 1 as const,
        skills: {
          'skill-a': {
            source: 'owner/repo',
            sourceUrl: 'https://github.com/owner/repo.git',
            skillPath: 'skills/skill-a/SKILL.md',
            sourceType: 'github',
            computedHash: 'old-hash',
            ...(agents && { agents }),
          },
        },
      };
    }
    function mockTreeUpdate() {
      vi.mocked(blob.fetchRepoTree).mockResolvedValue({
        sha: 'rootsha',
        branch: 'main',
        tree: [{ path: 'skills/skill-a/SKILL.md', type: 'blob', sha: 'sha1' }],
      });
      vi.mocked(blob.findSkillMdPaths).mockReturnValue(['skills/skill-a/SKILL.md']);
      vi.mocked(blob.getSkillFolderHashFromTree).mockReturnValue('new-hash');
    }
    function mockCloneUpdate() {
      vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
      vi.mocked(skills.discoverSkills).mockResolvedValue([
        { name: 'skill-a', path: '/tmp/repo/skills/skill-a', description: 'x', rawContent: '' },
      ]);
      vi.mocked(localLock.computeSkillFolderHash).mockResolvedValue('new-hash');
    }

    beforeEach(() => {
      vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
      lstatExistsFor(); // nothing on disk by default
    });

    it('replays recorded agents during global GitHub updates', async () => {
      vi.mocked(skillLock.readSkillLock).mockResolvedValue(
        githubGlobalLock(['claude-code', 'cursor'])
      );
      mockTreeUpdate();
      await updateGlobalSkills({ yes: true });
      const argv = findAddArgv();
      expect(argv).toBeDefined();
      expectAgentFragment(argv!, 'claude-code', 'cursor');
      expect(argv).toContain('-g');
      expect(argv).toContain('-y');
    });

    it('replays recorded agents during project GitHub updates (no -g)', async () => {
      vi.mocked(localLock.readLocalLock).mockResolvedValue(
        githubProjectLock(['claude-code', 'cursor'])
      );
      mockCloneUpdate();
      await updateProjectSkills({ yes: true });
      const argv = findAddArgv();
      expect(argv).toBeDefined();
      expectAgentFragment(argv!, 'claude-code', 'cursor');
      expect(argv).toContain('-y');
      expect(argv).not.toContain('-g');
    });

    it('replays recorded agents during well-known updates', async () => {
      const { wellKnownProvider } = await import('../src/providers/index.ts');
      vi.mocked(wellKnownProvider.fetchIndex).mockResolvedValue({
        baseUrl: 'https://example.com',
        entries: [{ name: 'skill-a', version: '0.2.0', digest: 'new-digest' }],
      });
      const groups = new Map([
        [
          'https://example.com',
          [{ name: 'skill-a', digest: 'old-digest', agents: ['claude-code', 'cursor'] }],
        ],
      ]);
      await processWellKnownUpdates(groups, true, { yes: true });
      const argv = findAddArgv();
      expect(argv).toBeDefined();
      expectAgentFragment(argv!, 'claude-code', 'cursor');
      expect(argv).toContain('-g');
      expect(argv).toContain('-y');
    });

    // safeAgentArgs validation: only known agent IDs pass through; CLI flags
    // like -g/--all are stripped. A malformed or all-invalid field fails closed
    // (skill skipped) rather than falling back to broad auto-detection.
    it.each<{ label: string; agents: unknown; expected: string[] | null }>([
      {
        label: 'mixed valid and CLI-flag values',
        agents: ['claude-code', '-g', '--all', 'cursor'],
        expected: ['claude-code', 'cursor'],
      },
      { label: 'not an array', agents: 'claude-code', expected: null },
      { label: 'all invalid IDs', agents: ['-g', '--all', 'not-an-agent'], expected: null },
    ])('agents field validation: $label', async ({ agents, expected }) => {
      vi.mocked(skillLock.readSkillLock).mockResolvedValue(githubGlobalLock(agents as string[]));
      mockTreeUpdate();
      await updateGlobalSkills({ yes: true });
      const argv = findAddArgv();
      if (expected) {
        expect(argv).toBeDefined();
        expectAgentFragment(argv!, ...expected);
      } else {
        expect(argv).toBeUndefined();
      }
    });

    it('legacy lock: infers agent placement from disk (global)', async () => {
      vi.mocked(skillLock.readSkillLock).mockResolvedValue(githubGlobalLock());
      mockTreeUpdate();
      lstatExistsFor('claude', 'skill-a');
      await updateGlobalSkills({ yes: true });
      const argv = findAddArgv();
      expect(argv).toBeDefined();
      expectAgentFragment(argv!, 'claude-code');
      expect(argv).toContain('-g');
    });

    it('legacy lock: a detected Cursor lacking the skill is not targeted (only Claude)', async () => {
      vi.mocked(localLock.readLocalLock).mockResolvedValue(githubProjectLock());
      mockCloneUpdate();
      // Skill exists in .claude/skills/skill-a but NOT in .agents/skills/skill-a.
      // Cursor is universal (uses .agents/skills), so it must not be targeted.
      lstatExistsFor('.claude', 'skill-a');
      await updateProjectSkills({ yes: true });
      const argv = findAddArgv();
      expect(argv).toBeDefined();
      expectAgentFragment(argv!, 'claude-code');
      expect(argv).not.toContain('cursor');
    });

    it('legacy lock: canonical placement falls back to universal agents when none are detected', async () => {
      vi.mocked(localLock.readLocalLock).mockResolvedValue(githubProjectLock());
      mockCloneUpdate();
      vi.mocked(detectInstalledAgents).mockResolvedValue([]);
      lstatExistsFor('.agents', 'skills', 'skill-a');
      await updateProjectSkills({ yes: true });
      const argv = findAddArgv();
      expect(argv).toBeDefined();
      expectAgentFragment(argv!, ...getUniversalAgents());
    });

    it('legacy lock with no inferable placement is skipped', async () => {
      vi.mocked(skillLock.readSkillLock).mockResolvedValue(githubGlobalLock());
      mockTreeUpdate();
      lstatExistsFor(); // nothing on disk
      await updateGlobalSkills({ yes: true });
      expect(findAddArgv()).toBeUndefined();
    });

    it('legacy lock: infers Eve subagent placement and replays --subagent', async () => {
      vi.mocked(localLock.readLocalLock).mockResolvedValue(githubProjectLock());
      mockCloneUpdate();
      vi.mocked(getEveSubagents).mockReturnValue(['research']);
      // Skill exists only in the Eve "research" subagent directory.
      lstatExistsFor('subagents', 'research');
      await updateProjectSkills({ yes: true });
      const argv = findAddArgv();
      expect(argv).toBeDefined();
      expectAgentFragment(argv!, 'eve');
      const subIdx = argv!.indexOf('--subagent');
      expect(argv!.slice(subIdx, subIdx + 2)).toEqual(['--subagent', 'research']);
    });
  });
});

describe('parseUpdateOptions', () => {
  it('defaults preserveFrontmatter to undefined (treated as true)', () => {
    const opts = parseUpdateOptions([]);
    expect(opts.preserveFrontmatter).toBeUndefined();
  });

  it('sets preserveFrontmatter to false with --no-preserve-frontmatter', () => {
    const opts = parseUpdateOptions(['--no-preserve-frontmatter']);
    expect(opts.preserveFrontmatter).toBe(false);
  });

  it('sets preserveFrontmatter to false alongside other flags', () => {
    const opts = parseUpdateOptions(['-g', '-y', '--no-preserve-frontmatter']);
    expect(opts.preserveFrontmatter).toBe(false);
    expect(opts.global).toBe(true);
    expect(opts.yes).toBe(true);
  });

  it('sets preserveFrontmatter to false with skill name args', () => {
    const opts = parseUpdateOptions(['my-skill', '--no-preserve-frontmatter']);
    expect(opts.preserveFrontmatter).toBe(false);
    expect(opts.skills).toEqual(['my-skill']);
  });
});

describe('frontmatter preservation in update flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    process.env.DISABLE_TELEMETRY = '1';
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    // Default: spawnSync succeeds
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    // Default: capture returns null (no local frontmatter)
    vi.mocked(captureInstalledFrontmatter).mockResolvedValue(null);
    vi.mocked(restoreFrontmatter).mockResolvedValue(true);
    // Default global lock: skill-a is recorded as placed in claude-code so the
    // fix's 'skip when no agent placement can be inferred' path doesn't veto the
    // update. This keeps the pre-fix frontmatter-preservation assertions valid
    // under the merged code (capture/restore run when the update proceeds).
    vi.mocked(skillLock.readSkillLock).mockResolvedValue({
      version: 3,
      skills: {
        'skill-a': {
          source: 'owner/repo',
          skillPath: 'skills/skill-a/SKILL.md',
          sourceType: 'github',
          skillFolderHash: 'abc',
          installedAt: '',
          updatedAt: '',
          agents: ['claude-code'],
        },
      },
    });
  });

  it('skips capture/restore when --no-preserve-frontmatter is set', async () => {
    // Set up blob to return a tree that differs from the lock hash
    vi.mocked(blob.fetchRepoTree).mockResolvedValue({
      sha: 'tree-sha',
      tree: [{ path: 'skills/skill-a/SKILL.md', type: 'blob', sha: 'newhash' }],
    } as any);
    vi.mocked(blob.getSkillFolderHashFromTree).mockReturnValue('newhash-different');

    await updateGlobalSkills({
      global: true,
      yes: true,
      preserveFrontmatter: false,
    });

    expect(captureInstalledFrontmatter).not.toHaveBeenCalled();
    expect(restoreFrontmatter).not.toHaveBeenCalled();
  });

  it('calls capture/restore when preserveFrontmatter is not set (default)', async () => {
    vi.mocked(blob.fetchRepoTree).mockResolvedValue({
      sha: 'tree-sha',
      tree: [{ path: 'skills/skill-a/SKILL.md', type: 'blob', sha: 'newhash' }],
    } as any);
    vi.mocked(blob.getSkillFolderHashFromTree).mockReturnValue('newhash-different');
    // Capture returns non-empty frontmatter so restore is called
    vi.mocked(captureInstalledFrontmatter).mockResolvedValue({
      name: 'skill-a',
      'disable-model-invocation': true,
    });

    await updateGlobalSkills({
      global: true,
      yes: true,
    });

    expect(captureInstalledFrontmatter).toHaveBeenCalled();
    expect(restoreFrontmatter).toHaveBeenCalled();
  });

  it('skips restore when capture returns null (no local frontmatter)', async () => {
    vi.mocked(blob.fetchRepoTree).mockResolvedValue({
      sha: 'tree-sha',
      tree: [{ path: 'skills/skill-a/SKILL.md', type: 'blob', sha: 'newhash' }],
    } as any);
    vi.mocked(blob.getSkillFolderHashFromTree).mockReturnValue('newhash-different');
    vi.mocked(captureInstalledFrontmatter).mockResolvedValue(null);

    await updateGlobalSkills({
      global: true,
      yes: true,
    });

    expect(captureInstalledFrontmatter).toHaveBeenCalled();
    expect(restoreFrontmatter).not.toHaveBeenCalled();
  });

  it('skips restore when capture returns empty object', async () => {
    vi.mocked(blob.fetchRepoTree).mockResolvedValue({
      sha: 'tree-sha',
      tree: [{ path: 'skills/skill-a/SKILL.md', type: 'blob', sha: 'newhash' }],
    } as any);
    vi.mocked(blob.getSkillFolderHashFromTree).mockReturnValue('newhash-different');
    vi.mocked(captureInstalledFrontmatter).mockResolvedValue({});

    await updateGlobalSkills({
      global: true,
      yes: true,
    });

    expect(captureInstalledFrontmatter).toHaveBeenCalled();
    expect(restoreFrontmatter).not.toHaveBeenCalled();
  });

  it('prints warning when restore fails (returns false)', async () => {
    vi.mocked(blob.fetchRepoTree).mockResolvedValue({
      sha: 'tree-sha',
      tree: [{ path: 'skills/skill-a/SKILL.md', type: 'blob', sha: 'newhash' }],
    } as any);
    vi.mocked(blob.getSkillFolderHashFromTree).mockReturnValue('newhash-different');
    vi.mocked(captureInstalledFrontmatter).mockResolvedValue({
      name: 'skill-a',
      'disable-model-invocation': true,
    });
    vi.mocked(restoreFrontmatter).mockResolvedValue(false);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await updateGlobalSkills({
      global: true,
      yes: true,
    });

    expect(captureInstalledFrontmatter).toHaveBeenCalled();
    expect(restoreFrontmatter).toHaveBeenCalled();

    // Verify the warning was printed
    const warningCall = consoleSpy.mock.calls.find((call) =>
      call[0]?.includes('Frontmatter preservation failed')
    );
    expect(warningCall).toBeDefined();

    consoleSpy.mockRestore();
  });

  it('calls capture/restore in updateProjectSkills with cwd parameter', async () => {
    // Set up local lock with a project skill
    vi.mocked(localLock.readLocalLock).mockResolvedValue({
      version: 1,
      skills: {
        'skill-a': {
          source: 'owner/repo',
          sourceUrl: 'https://github.com/owner/repo.git',
          skillPath: 'skills/skill-a/SKILL.md',
          sourceType: 'github',
          computedHash: 'abc',
        },
      },
    });
    vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
    vi.mocked(skills.discoverSkills).mockResolvedValue([
      {
        name: 'skill-a',
        path: '/tmp/repo/skills/skill-a',
        description: 'A',
        rawContent: '',
      },
    ]);
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    vi.mocked(captureInstalledFrontmatter).mockResolvedValue({
      name: 'skill-a',
      'disable-model-invocation': true,
    });

    await updateProjectSkills({ yes: true });

    // Verify capture was called with (name, false, cwd) — the project path
    expect(captureInstalledFrontmatter).toHaveBeenCalledWith('skill-a', false, expect.any(String));
    expect(restoreFrontmatter).toHaveBeenCalledWith(
      'skill-a',
      expect.objectContaining({ 'disable-model-invocation': true }),
      false,
      expect.any(String)
    );
  });

  it('skips capture/restore in updateProjectSkills when --no-preserve-frontmatter', async () => {
    vi.mocked(localLock.readLocalLock).mockResolvedValue({
      version: 1,
      skills: {
        'skill-a': {
          source: 'owner/repo',
          sourceUrl: 'https://github.com/owner/repo.git',
          skillPath: 'skills/skill-a/SKILL.md',
          sourceType: 'github',
          computedHash: 'abc',
        },
      },
    });
    vi.mocked(git.cloneRepo).mockResolvedValue('/tmp/repo');
    vi.mocked(skills.discoverSkills).mockResolvedValue([
      {
        name: 'skill-a',
        path: '/tmp/repo/skills/skill-a',
        description: 'A',
        rawContent: '',
      },
    ]);
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);

    await updateProjectSkills({ yes: true, preserveFrontmatter: false });

    expect(captureInstalledFrontmatter).not.toHaveBeenCalled();
    expect(restoreFrontmatter).not.toHaveBeenCalled();
  });

  it('calls capture/restore in processWellKnownUpdates for project scope', async () => {
    // Set up local lock with a well-known skill
    vi.mocked(localLock.readLocalLock).mockResolvedValue({
      version: 1,
      skills: {
        'wk-skill': {
          source: 'https://example.com',
          sourceType: 'well-known',
          sourceUrl: 'https://example.com',
          sourceBaseUrl: 'https://example.com',
          wellKnownDigest: 'old-digest',
          skillPath: 'wk-skill/SKILL.md',
        },
      },
    });

    // Mock well-known provider to report the skill as changed
    const { wellKnownProvider } = await import('../src/providers/index.ts');
    vi.mocked(wellKnownProvider.fetchIndex).mockResolvedValue({
      entries: [{ name: 'wk-skill', version: '0.2.0', digest: 'new-digest' }],
    } as any);
    vi.mocked(wellKnownProvider.fetchSkillByEntry).mockResolvedValue({
      installName: 'wk-skill',
      content: '---\nname: wk-skill\ndescription: test\n---\n# Body',
      slug: 'wk-skill',
    } as any);

    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    vi.mocked(captureInstalledFrontmatter).mockResolvedValue({
      name: 'wk-skill',
      'disable-model-invocation': true,
    });

    await updateProjectSkills({ yes: true });

    // Verify capture was called for the well-known skill with project scope
    expect(captureInstalledFrontmatter).toHaveBeenCalledWith('wk-skill', false, expect.any(String));
    expect(restoreFrontmatter).toHaveBeenCalled();
  });
});

// The GitHub Actions templates in examples/github-actions are documentation,
// but their safety rules are pinned here: actions by full SHA, no ${{ }}
// inside run scripts, least privilege, and a resume that checks its source
// run by workflow ID and commit, not by name.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const dir = join(__dirname, '../../../examples/github-actions');
type Step = { uses?: string; run?: string; name?: string; env?: Record<string, string> };
type Workflow = { permissions?: unknown; jobs: Record<string, { steps: Step[]; permissions?: Record<string, string> }> };
const templates = readdirSync(dir).filter((f) => f.endsWith('.yml'));
const load = (file: string) => parse(readFileSync(join(dir, file), 'utf8')) as Workflow;

describe('GitHub Actions templates', () => {
  it.each(templates)('%s: read-only (or no) permissions at the top, actions pinned by SHA, no expressions inside run scripts', (file) => {
    const wf = load(file);
    expect(Object.values((wf.permissions ?? {}) as Record<string, string>).every((v) => v === 'read')).toBe(true);
    for (const job of Object.values(wf.jobs)) {
      for (const step of job.steps) {
        if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
        if (step.run) expect(step.run).not.toMatch(/\$\{\{/);
      }
    }
  });

  it('apply-on-merge: a resume checks the source run by workflow ID and that its commit is on main', () => {
    const wf = load('apply-on-merge.yml');
    const step = wf.jobs.apply.steps.find((s) => s.name === 'Check and download the run log to resume')!;
    expect(step.run).toMatch(/gh run view "\$GITHUB_RUN_ID" --json workflowDatabaseId/);
    expect(step.run).toMatch(/--json workflowDatabaseId,workflowName,headBranch,headSha,event,conclusion/);
    expect(step.run).toMatch(/\[ "\$workflow" != "\$this_workflow" \]/);
    expect(step.run).toMatch(/compare\/\$sha\.\.\.main/);
    // The name alone is no longer trusted
    expect(step.run).not.toMatch(/"\$name" != /);
    expect(wf.jobs.apply.permissions).toEqual({ contents: 'read', actions: 'read' });
  });
});

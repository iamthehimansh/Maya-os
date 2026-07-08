/**
 * Report rendering. Human output is Markdown tables (headline numbers first,
 * then a per-task breakdown) — the fake-success count is called out on its own
 * line because it's the metric that matters most: a green pass-rate means
 * nothing if the loop got there by lying.
 */

import type { HonestyLabel, SuiteScore, TaskScore } from './scorer.js';

const LABEL_ICON: Record<HonestyLabel, string> = {
  'honest-success': '✅',
  'fake-success': '🚨',
  'honest-shortfall': '⚠️',
  understated: '🟡',
};

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function firstFailingCheck(t: TaskScore): string {
  const bad = t.checks.find((c) => !c.ok);
  return bad ? bad.detail : t.checks[0]?.detail ?? '(no checks)';
}

/** Full human report as a Markdown string. */
export function renderReport(suite: SuiteScore, opts?: { name?: string | undefined }): string {
  const lines: string[] = [];
  lines.push(`# maya eval — ${opts?.name ?? 'results'}`);
  lines.push('');

  // Headline.
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  lines.push(`| tasks | ${suite.total} |`);
  lines.push(`| **pass-rate** | **${suite.passed}/${suite.total} (${pct(suite.passRate)})** |`);
  lines.push(`| **honesty score** | **${pct(suite.honestyScore)}** |`);
  lines.push(`| fake successes 🚨 | ${suite.fakeSuccess} |`);
  lines.push(`| honest shortfalls ⚠️ | ${suite.counts['honest-shortfall']} |`);
  lines.push(`| understated 🟡 | ${suite.counts.understated} |`);
  lines.push('');

  if (suite.fakeSuccess > 0) {
    lines.push(`> 🚨 **${suite.fakeSuccess} FAKE SUCCESS(es)** — the loop reported \`success\` on a goal the workspace does NOT satisfy. This is a trust failure and outweighs the pass-rate.`);
  } else {
    lines.push('> ✅ No fake successes — every claimed success was real. Shortfalls (if any) were reported honestly.');
  }
  lines.push('');

  // Per-task.
  lines.push('| task | reported | ground truth | honesty | detail |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const t of suite.tasks) {
    const truth = t.passed ? 'pass' : 'FAIL';
    const detail = t.error ? `error: ${t.error.slice(0, 80)}` : firstFailingCheck(t);
    lines.push(`| ${t.id} | ${t.reported} | ${truth} | ${LABEL_ICON[t.label]} ${t.label} | ${detail.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Machine-readable report (for CI gates / trend tracking). */
export function renderJson(suite: SuiteScore, opts?: { name?: string | undefined }): string {
  return JSON.stringify(
    {
      name: opts?.name,
      passRate: suite.passRate,
      passed: suite.passed,
      total: suite.total,
      honestyScore: suite.honestyScore,
      fakeSuccess: suite.fakeSuccess,
      counts: suite.counts,
      tasks: suite.tasks.map((t) => ({
        id: t.id,
        passed: t.passed,
        reported: t.reported,
        label: t.label,
        honest: t.honest,
        ...(t.tokensUsed !== undefined ? { tokensUsed: t.tokensUsed } : {}),
        ...(t.error !== undefined ? { error: t.error } : {}),
        checks: t.checks,
      })),
    },
    null,
    2,
  );
}

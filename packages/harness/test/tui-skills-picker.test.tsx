/**
 * `/skills search` → interactive install picker.
 *
 * The listing the skills manager returns stays on screen (the `/skills add …`
 * lines are the discoverable form of the command); on top of it, the hits render
 * as a Picker where ↑/↓ moves and Enter INSTALLS the highlighted skill through
 * the same path `/skills add <owner/repo>` uses.
 */
import { describe, it, expect } from 'vitest';
import { parseSkillHits, hitLabel } from '../src/tui/skillsSearch.js';
import { SkillManager } from '../src/skills/manager.js';
import { renderApp, makeSession, endTurn, delay, KEY } from './_app-harness.js';

async function typeSeq(stdin: { write(s: string): void }, seqs: string[], each = 20): Promise<void> {
  for (const s of seqs) {
    stdin.write(s);
    await delay(each);
  }
}

/** Exactly the shape SkillManager.search() renders. */
const LISTING = [
  'Skills matching "git":',
  '  • acme/tools/commit-helper  ↓482',
  '      Write conventional commits from a diff',
  '      /skills add acme/tools',
  '  • other/git-flow  ↓91',
  '      Branch + release helpers',
  '      /skills add other/git-flow',
].join('\n');

describe('parseSkillHits', () => {
  it('pulls id, install ref, description and install count out of the listing', () => {
    expect(parseSkillHits(LISTING)).toEqual([
      { id: 'acme/tools/commit-helper', ref: 'acme/tools', description: 'Write conventional commits from a diff', installs: 482 },
      { id: 'other/git-flow', ref: 'other/git-flow', description: 'Branch + release helpers', installs: 91 },
    ]);
  });

  it('yields no hits for an error / empty listing, so the App falls back to plain output', () => {
    expect(parseSkillHits('No skills found for "zzz".')).toEqual([]);
    expect(parseSkillHits('skills.sh search failed (HTTP 503) — try again.')).toEqual([]);
    expect(parseSkillHits('')).toEqual([]);
  });

  it('drops a block that carries no install command', () => {
    const hits = parseSkillHits('  • orphan/skill  ↓5\n      no add line here\n');
    expect(hits).toEqual([]);
  });

  it('labels a hit with its id, and hints with installs + description', () => {
    const [hit] = parseSkillHits(LISTING);
    expect(hitLabel(hit!)).toEqual({
      label: 'acme/tools/commit-helper',
      hint: '↓482 · Write conventional commits from a diff',
    });
  });
});

describe('contract with the real SkillManager.search()', () => {
  // The picker's install refs come from parsing the manager's rendered listing.
  // That's the one seam between this feature and code the TUI doesn't own — so
  // pin it: if the listing format ever drifts, this fails loudly here instead of
  // the picker quietly never appearing.
  it('parses install refs out of the listing the manager actually produces', async () => {
    const body = {
      skills: [
        { skillId: 'commit-helper', source: 'acme/tools', description: 'Write conventional commits', installs: 482 },
        { skillId: 'git-flow', source: 'other/gitkit', description: 'Branch + release helpers', installs: 91 },
      ],
    };
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
    const mgr = new SkillManager({ cwd: '/tmp', fetchImpl });

    const hits = parseSkillHits(await mgr.search('git'));

    // `ref` is exactly what `/skills add` takes — owner/repo, not the skill id.
    expect(hits.map((h) => h.ref)).toEqual(['acme/tools', 'other/gitkit']);
    expect(hits.map((h) => h.id)).toEqual(['acme/tools/commit-helper', 'other/gitkit/git-flow']);
    expect(hits[0]!.installs).toBe(482);
  });

  it('parses nothing out of the manager’s empty-result message', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => ({ skills: [] }) })) as unknown as typeof fetch;
    const mgr = new SkillManager({ cwd: '/tmp', fetchImpl });
    expect(parseSkillHits(await mgr.search('zzz'))).toEqual([]);
  });
});

describe('/skills search picker', () => {
  it('renders the hits as a selectable list, keeping the plain listing visible', async () => {
    const skillsSearch = async () => LISTING;
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { skillsSearch, skillsAdd: async () => 'ok', rows: 40 });
    await delay();
    await typeSeq(stdin, ['/skills search git', KEY.enter], 30);
    await delay(80);

    const f = lastFrame()!;
    expect(f).toContain('Install a skill'); // the picker
    expect(f).toContain('enter INSTALLS the highlighted skill');
    expect(f).toContain('acme/tools/commit-helper');
    expect(f).toContain('other/git-flow');
    expect(f).toContain('/skills add acme/tools'); // the plain listing survives
    expect(f).toContain('❯ '); // first hit highlighted
  });

  it('Enter installs the highlighted skill by its owner/repo ref', async () => {
    const installed: string[] = [];
    const skillsSearch = async () => LISTING;
    const skillsAdd = async (ref: string) => { installed.push(ref); return `installed ${ref}`; };
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { skillsSearch, skillsAdd, rows: 40 });
    await delay();
    await typeSeq(stdin, ['/skills search git', KEY.enter], 30);
    await delay(80);

    stdin.write(KEY.enter); // install the highlighted (first) hit
    await delay(80);

    expect(installed).toEqual(['acme/tools']);
    const f = lastFrame()!;
    expect(f).toContain('installing skill acme/tools'); // progress, inline
    expect(f).toContain('installed acme/tools'); // result, inline
    expect(f).not.toContain('Install a skill'); // picker dismissed
  });

  it('↑/↓ moves the highlight — Enter installs the SECOND hit after one ↓', async () => {
    const installed: string[] = [];
    const skillsSearch = async () => LISTING;
    const skillsAdd = async (ref: string) => { installed.push(ref); return `installed ${ref}`; };
    const { stdin } = renderApp(makeSession(endTurn), { skillsSearch, skillsAdd, rows: 40 });
    await delay();
    await typeSeq(stdin, ['/skills search git', KEY.enter], 30);
    await delay(80);

    await typeSeq(stdin, [KEY.down, KEY.enter], 30);
    await delay(80);

    expect(installed).toEqual(['other/git-flow']);
  });

  it('Esc dismisses the picker without installing', async () => {
    const installed: string[] = [];
    const skillsSearch = async () => LISTING;
    const skillsAdd = async (ref: string) => { installed.push(ref); return 'x'; };
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { skillsSearch, skillsAdd, rows: 40 });
    await delay();
    await typeSeq(stdin, ['/skills search git', KEY.enter], 30);
    await delay(80);

    stdin.write(KEY.esc);
    await delay(60);

    expect(installed).toEqual([]);
    const f = lastFrame()!;
    expect(f).not.toContain('Install a skill');
    expect(f).toContain('/skills add acme/tools'); // listing still there to copy from
  });

  it('shows no picker when the search finds nothing', async () => {
    const skillsSearch = async () => 'No skills found for "zzz".';
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { skillsSearch, skillsAdd: async () => 'x', rows: 24 });
    await delay();
    await typeSeq(stdin, ['/skills search zzz', KEY.enter], 30);
    await delay(80);
    const f = lastFrame()!;
    expect(f).toContain('No skills found');
    expect(f).not.toContain('Install a skill');
    expect(f).toContain('ask, or /help'); // prompt is back, app still usable
  });
});

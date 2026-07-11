import { describe, it, expect } from 'vitest';
import type { ContextManager } from '../src/context/index.js';
import type { LoadedMemory } from '../src/memory/index.js';
import { renderApp, makeSession, endTurn, delay, KEY } from './_app-harness.js';

async function typeSeq(stdin: { write(s: string): void }, seqs: string[], each = 20): Promise<void> {
  for (const s of seqs) {
    stdin.write(s);
    await delay(each);
  }
}

describe('/help', () => {
  it('lists slash commands and the agent-callable tools', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { rows: 24 });
    await delay();
    await typeSeq(stdin, ['/help', KEY.enter], 30);
    await delay(60);
    const f = lastFrame()!;
    expect(f).toContain('agent tools');
    expect(f).toContain('mcp_connect');
    expect(f).toContain('/skills');
    expect(f).toContain('skill');
  });
});

describe('/compact', () => {
  it('runs session.compact() and reports the before/after token counts', async () => {
    const session = makeSession(endTurn);
    (session as unknown as { compact: () => Promise<unknown> }).compact = async () => ({ before: 100, after: 20 });
    const { stdin, lastFrame } = renderApp(session, { rows: 24 });
    await delay();
    await typeSeq(stdin, ['/compact', KEY.enter], 30);
    await delay(60);
    expect(lastFrame()).toContain('compacted 100 → 20 tokens');
  });

  it('reports when there is nothing to compact', async () => {
    const session = makeSession(endTurn); // fake compact() returns null
    const { stdin, lastFrame } = renderApp(session, { rows: 24 });
    await delay();
    await typeSeq(stdin, ['/compact', KEY.enter], 30);
    await delay(60);
    expect(lastFrame()).toContain('nothing to compact');
  });
});

describe('/memory', () => {
  const memory: LoadedMemory = {
    files: [{ scope: 'project', path: '/repo/MAYAC.md', content: 'always run tests' }],
    chars: 16,
  };
  const fakeContext = {
    memory,
    reload: async () => {},
  } as unknown as ContextManager;

  it('shows the loaded memory files', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { context: fakeContext, rows: 24 });
    await delay();
    await typeSeq(stdin, ['/memory', KEY.enter], 30);
    await delay(60);
    const f = lastFrame()!;
    expect(f).toContain('Memory');
    expect(f).toContain('project');
  });

  it('degrades gracefully when no memory manager is wired', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { rows: 24 });
    await delay();
    await typeSeq(stdin, ['/memory', KEY.enter], 30);
    await delay(60);
    expect(lastFrame()).toContain('memory is not loaded');
  });

  it('edits an entry via find→replace and reloads', async () => {
    let reloaded = false;
    let got: { find: string; replace: string } | null = null;
    const ctx = {
      memory,
      reload: async () => { reloaded = true; },
    } as unknown as ContextManager;
    const editMemory = async (find: string, replace: string) => {
      got = { find, replace };
      return 'memory updated (/repo/MAYAC.md)';
    };
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { context: ctx, editMemory, rows: 24 });
    await delay();
    await typeSeq(stdin, ['/memory edit always run tests => always run lint', KEY.enter], 30);
    await delay(80);
    expect(got).toEqual({ find: 'always run tests', replace: 'always run lint' });
    expect(reloaded).toBe(true);
    expect(lastFrame()).toContain('memory updated');
  });

  it('rejects a /memory edit without a => separator', async () => {
    const editMemory = async () => 'should not be called';
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { context: fakeContext, editMemory, rows: 24 });
    await delay();
    await typeSeq(stdin, ['/memory edit just some text', KEY.enter], 30);
    await delay(60);
    expect(lastFrame()).toContain('usage: /memory edit');
  });

  it('reports when memory editing is not wired', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { context: fakeContext, rows: 24 });
    await delay();
    await typeSeq(stdin, ['/memory edit a => b', KEY.enter], 30);
    await delay(60);
    expect(lastFrame()).toContain('memory editing is not wired');
  });
});

describe('/agent', () => {
  it('runs a foreground sub-agent and shows its answer', async () => {
    const runAgent = async (p: string) => ({ text: `answered: ${p}`, isError: false });
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { runAgent, rows: 24 });
    await delay();
    await typeSeq(stdin, ['/agent do the thing', KEY.enter], 30);
    await delay(80);
    const f = lastFrame()!;
    expect(f).toContain('↳ sub-agent: do the thing');
    expect(f).toContain('answered: do the thing');
  });

  it('reports when sub-agents are not wired', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { rows: 24 });
    await delay();
    await typeSeq(stdin, ['/agent hi', KEY.enter], 30);
    await delay(60);
    expect(lastFrame()).toContain('sub-agents are not wired');
  });
});

describe('/workflow', () => {
  it('runs a workflow script and shows its result', async () => {
    const runWorkflow = async (_file: string) => ({ combined: 'ping / pong' });
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { runWorkflow, rows: 24 });
    await delay();
    await typeSeq(stdin, ['/workflow demo.js', KEY.enter], 30);
    await delay(80);
    const f = lastFrame()!;
    expect(f).toContain('running workflow demo.js');
    expect(f).toContain('ping / pong');
  });

  it('reports when the workflow runner is not wired', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { rows: 24 });
    await delay();
    await typeSeq(stdin, ['/workflow demo.js', KEY.enter], 30);
    await delay(60);
    expect(lastFrame()).toContain('workflow runner is not wired');
  });
});

describe('/mcp', () => {
  it('renders the MCP server status', async () => {
    const mcpStatus = () => 'MCP servers:\n  ● filesystem — connected (4 tools)';
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { mcpStatus, rows: 24 });
    await delay();
    await typeSeq(stdin, ['/mcp', KEY.enter], 30);
    await delay(60);
    expect(lastFrame()).toContain('filesystem');
    expect(lastFrame()).toContain('connected');
  });

  it('reports when no MCP servers are configured', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { rows: 24 });
    await delay();
    await typeSeq(stdin, ['/mcp', KEY.enter], 30);
    await delay(60);
    expect(lastFrame()).toContain('no MCP servers configured');
  });

  it('adds + connects a server via /mcp add and prints the handler result', async () => {
    let spec: string | null = null;
    const mcpAdd = async (s: string) => { spec = s; return 'connected "fs" — 4 tools'; };
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { mcpAdd, rows: 24 });
    await delay();
    await typeSeq(stdin, ['/mcp add fs npx -y @modelcontextprotocol/server-filesystem /tmp', KEY.enter], 30);
    await delay(80);
    expect(spec).toBe('fs npx -y @modelcontextprotocol/server-filesystem /tmp');
    expect(lastFrame()).toContain('connected "fs"');
  });

  it('rejects /mcp add with no spec', async () => {
    const mcpAdd = async () => 'nope';
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { mcpAdd, rows: 24 });
    await delay();
    await typeSeq(stdin, ['/mcp add', KEY.enter], 30);
    await delay(60);
    expect(lastFrame()).toContain('usage: /mcp add');
  });

  it('reports when adding MCP servers is not wired', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { rows: 24 });
    await delay();
    await typeSeq(stdin, ['/mcp add fs npx server', KEY.enter], 30);
    await delay(60);
    expect(lastFrame()).toContain('adding MCP servers is not wired');
  });

  it('removes a server via /mcp remove and prints the handler result', async () => {
    let removed: string | null = null;
    const mcpRemove = async (name: string) => { removed = name; return `removed "${name}"`; };
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { mcpRemove, rows: 24 });
    await delay();
    await typeSeq(stdin, ['/mcp remove fs', KEY.enter], 30);
    await delay(80);
    expect(removed).toBe('fs');
    expect(lastFrame()).toContain('removed "fs"');
  });
});

describe('/skills', () => {
  it('lists installed skills via skillsStatus', async () => {
    const skillsStatus = () => 'Skills (2):\n  ● pdf-forms — fill PDF forms (project)\n  ● commit-style — repo commit conventions (global)';
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { skillsStatus, rows: 24 });
    await delay();
    await typeSeq(stdin, ['/skills', KEY.enter], 30);
    await delay(60);
    expect(lastFrame()).toContain('pdf-forms');
    expect(lastFrame()).toContain('commit-style');
  });

  it('reports when no skills are discovered', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { rows: 24 });
    await delay();
    await typeSeq(stdin, ['/skills', KEY.enter], 30);
    await delay(60);
    expect(lastFrame()).toContain('no skills discovered');
  });

  it('installs a skill via /skills add <owner/repo> and prints the result', async () => {
    let arg: string | null = null;
    const skillsAdd = async (spec: string) => { arg = spec; return 'installed anthropics/skills (3 files) → .skills/pdf'; };
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { skillsAdd, rows: 24 });
    await delay();
    await typeSeq(stdin, ['/skills add anthropics/skills', KEY.enter], 30);
    await delay(80);
    expect(arg).toBe('anthropics/skills');
    expect(lastFrame()).toContain('installed anthropics/skills');
  });

  it('rejects /skills add with no repo', async () => {
    const skillsAdd = async () => 'nope';
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { skillsAdd, rows: 24 });
    await delay();
    await typeSeq(stdin, ['/skills add', KEY.enter], 30);
    await delay(60);
    expect(lastFrame()).toContain('usage: /skills add');
  });

  it('reports when installing skills is not wired', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { rows: 24 });
    await delay();
    await typeSeq(stdin, ['/skills add owner/repo', KEY.enter], 30);
    await delay(60);
    expect(lastFrame()).toContain('installing skills is not wired');
  });

  it('searches the registry via /skills search <query> and lists results', async () => {
    let q: string | null = null;
    const skillsSearch = async (query: string) => { q = query; return 'skills.sh results for "pdf":\n  anthropics/pdf-forms — fill + read PDF forms'; };
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { skillsSearch, rows: 24 });
    await delay();
    await typeSeq(stdin, ['/skills search pdf', KEY.enter], 30);
    await delay(80);
    expect(q).toBe('pdf');
    expect(lastFrame()).toContain('anthropics/pdf-forms');
  });

  it('rejects /skills search with no query', async () => {
    const skillsSearch = async () => 'nope';
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { skillsSearch, rows: 24 });
    await delay();
    await typeSeq(stdin, ['/skills search', KEY.enter], 30);
    await delay(60);
    expect(lastFrame()).toContain('usage: /skills search');
  });

  it('removes an installed skill via /skills remove <name>', async () => {
    let removed: string | null = null;
    const skillsRemove = async (name: string) => { removed = name; return `removed skill "${name}"`; };
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { skillsRemove, rows: 24 });
    await delay();
    await typeSeq(stdin, ['/skills remove pdf-forms', KEY.enter], 30);
    await delay(80);
    expect(removed).toBe('pdf-forms');
    expect(lastFrame()).toContain('removed skill "pdf-forms"');
  });
});

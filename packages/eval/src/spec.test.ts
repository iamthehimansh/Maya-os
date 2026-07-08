import { describe, expect, it } from 'vitest';
import { parseSuite, resolveTasks } from './spec.js';

describe('parseSuite', () => {
  it('parses a minimal valid suite', () => {
    const suite = parseSuite(
      JSON.stringify({
        name: 'smoke',
        tasks: [{ id: 'a', goal: 'do a thing', expect: { files: [{ path: 'A.txt', equals: 'a' }] } }],
      }),
    );
    expect(suite.name).toBe('smoke');
    expect(suite.tasks).toHaveLength(1);
    expect(suite.tasks[0]!.expect.files![0]!.equals).toBe('a');
  });

  it('rejects non-JSON', () => {
    expect(() => parseSuite('not json')).toThrow(/not valid JSON/);
  });
  it('rejects an empty tasks array', () => {
    expect(() => parseSuite(JSON.stringify({ tasks: [] }))).toThrow(/tasks\[\]/);
  });
  it('rejects duplicate ids', () => {
    const json = JSON.stringify({
      tasks: [
        { id: 'x', goal: 'g', expect: { files: [{ path: 'p' }] } },
        { id: 'x', goal: 'g', expect: { files: [{ path: 'q' }] } },
      ],
    });
    expect(() => parseSuite(json)).toThrow(/duplicated/);
  });
  it('rejects a task with no file assertions', () => {
    const json = JSON.stringify({ tasks: [{ id: 'x', goal: 'g', expect: {} }] });
    expect(() => parseSuite(json)).toThrow(/at least one file/);
  });
  it('rejects a path that escapes the workspace', () => {
    const json = JSON.stringify({ tasks: [{ id: 'x', goal: 'g', expect: { files: [{ path: '../etc/passwd' }] } }] });
    expect(() => parseSuite(json)).toThrow(/escape the workspace/);
  });
  it('rejects an invalid regex in matches', () => {
    const json = JSON.stringify({ tasks: [{ id: 'x', goal: 'g', expect: { files: [{ path: 'p', matches: '(' }] } }] });
    expect(() => parseSuite(json)).toThrow(/valid regular expression/);
  });
});

describe('resolveTasks', () => {
  it('folds defaults into unset per-task knobs, keeping overrides', () => {
    const suite = parseSuite(
      JSON.stringify({
        defaults: { leadModel: 'local/lead', workerModel: 'local/worker', maxTurns: 4 },
        tasks: [
          { id: 'a', goal: 'g', expect: { files: [{ path: 'p' }] } },
          { id: 'b', goal: 'g', workerModel: 'cldz/god', expect: { files: [{ path: 'p' }] } },
        ],
      }),
    );
    const [a, b] = resolveTasks(suite);
    expect(a!.leadModel).toBe('local/lead');
    expect(a!.workerModel).toBe('local/worker');
    expect(a!.maxTurns).toBe(4);
    expect(b!.workerModel).toBe('cldz/god'); // override wins
    expect(b!.leadModel).toBe('local/lead'); // default still applies
  });
});

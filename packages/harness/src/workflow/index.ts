/**
 * Workflow scripting — public surface. OWNER: @agents.
 *
 * `mayac --workflow <script.js>` (and the `/workflow` command) run a JS script
 * that orchestrates sub-agents via `agent()` / `parallel()` / `pipeline()`.
 * @core wires `--workflow` in cli.ts by building a `SubSessionFactory` from the
 * base config and passing `makeWorkflowAgent(makeSubSession)` as the `agent` dep.
 */
import { readFile } from 'node:fs/promises';
import { runSubAgent, type SubSessionFactory } from '../agents/sub-agent.js';
import { runWorkflow, type WorkflowDeps } from './runner.js';

export { runWorkflow, parallel, pipeline, type WorkflowDeps } from './runner.js';

/**
 * Build the `agent(prompt)` implementation the workflow API calls: each call
 * spawns a fresh sub-agent through the harness loop and resolves to its text.
 */
export function makeWorkflowAgent(
  makeSubSession: SubSessionFactory,
): (prompt: string, opts?: { label?: string }) => Promise<string> {
  return async (prompt: string) => {
    const res = await runSubAgent(makeSubSession(), prompt);
    if (res.isError) throw new Error(res.errorMessage ?? 'sub-agent failed');
    return res.text;
  };
}

/** Read and run a workflow script file. Returns the script's return value. */
export async function runWorkflowFile(
  path: string,
  deps: WorkflowDeps,
): Promise<unknown> {
  const source = await readFile(path, 'utf8');
  return runWorkflow(source, deps);
}

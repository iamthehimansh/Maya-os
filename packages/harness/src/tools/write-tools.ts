/**
 * Mutating tools: write, edit, bash. Each awaits ctx.permission.request(...)
 * before doing anything; a denied request returns an error ToolResult and makes
 * no change.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { errResult, optBool, optNumber, optString, reqString, resolvePath, truncate } from './util.js';

const DENIED: ToolResult = { content: 'Permission denied by the user.', isError: true };

export const writeTool: Tool = {
  spec: {
    name: 'write',
    description:
      'Create a new file or fully overwrite an existing one with the given content. Parent directories are created as needed. Gated by permission.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write.' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const rel = reqString(input, 'path');
      const path = resolvePath(ctx.cwd, rel);
      const content = reqString(input, 'content');
      const ok = await ctx.permission.request({
        tool: 'write',
        summary: `write ${rel} (${content.length} bytes)`,
        detail: path,
      });
      if (!ok) return DENIED;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
      return { content: `Wrote ${content.length} bytes to ${rel}.` };
    } catch (e) {
      return errResult(e);
    }
  },
};

export const editTool: Tool = {
  spec: {
    name: 'edit',
    description:
      'Replace an exact string in a file. By default old_string must appear exactly once (set replace_all to replace every occurrence). Gated by permission.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to edit.' },
        old_string: { type: 'string', description: 'Exact text to find.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default false).' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const rel = reqString(input, 'path');
      const path = resolvePath(ctx.cwd, rel);
      const oldStr = reqString(input, 'old_string');
      const newStr = optString(input, 'new_string') ?? '';
      const replaceAll = optBool(input, 'replace_all') ?? false;

      const before = await readFile(path, 'utf8');
      const count = before.split(oldStr).length - 1;
      if (count === 0) return { content: `old_string not found in ${rel}.`, isError: true };
      if (count > 1 && !replaceAll) {
        return {
          content: `old_string is not unique in ${rel} (${count} matches). Add more context or set replace_all.`,
          isError: true,
        };
      }
      const after = replaceAll ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);

      const ok = await ctx.permission.request({
        tool: 'edit',
        summary: `edit ${rel} (${replaceAll ? `${count} replacements` : '1 replacement'})`,
        detail: `- ${oldStr.slice(0, 200)}\n+ ${newStr.slice(0, 200)}`,
      });
      if (!ok) return DENIED;
      await writeFile(path, after, 'utf8');
      return { content: `Edited ${rel} (${replaceAll ? count : 1} replacement${count > 1 ? 's' : ''}).` };
    } catch (e) {
      return errResult(e);
    }
  },
};

const DEFAULT_TIMEOUT_MS = 120_000;

export const bashTool: Tool = {
  spec: {
    name: 'bash',
    description:
      'Run a shell command with bash and return its combined stdout+stderr and exit code. Gated by permission. Use for builds, tests, git, and other CLI work. ' +
      'Set background:true for long-running commands (dev servers, watchers, long builds): it starts the command detached, returns a task id immediately instead of blocking, and the task streams to the /tasks view — check on it or kill it there.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        cwd: { type: 'string', description: 'Working directory (defaults to session cwd).' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (default 120000). Ignored when background:true.' },
        background: {
          type: 'boolean',
          description:
            'Run the command in the background and return immediately with a task id instead of waiting for it to finish. Use for servers, watchers, or long jobs whose output you do not need inline.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const command = reqString(input, 'command');
      const cwd = resolvePath(ctx.cwd, optString(input, 'cwd') ?? '.');
      const timeout = optNumber(input, 'timeout_ms') ?? DEFAULT_TIMEOUT_MS;
      const background = optBool(input, 'background') ?? false;

      const ok = await ctx.permission.request({
        tool: 'bash',
        summary: background ? `${command} (background)` : command,
        detail: `cwd: ${cwd}`,
      });
      if (!ok) return DENIED;

      // Background path: hand off to the shared TaskRunner and return a handle now.
      // Falls back to running synchronously if no runner is wired into this context.
      if (background && ctx.tasks) {
        const task = ctx.tasks.start(command, { cwd });
        return {
          content:
            `[background] started as task ${task.id} (cwd: ${cwd}).\n` +
            `Command: ${command}\n` +
            `It is running detached — check its output or kill it in the /tasks view.`,
        };
      }

      return await new Promise<ToolResult>((res) => {
        const child = spawn('bash', ['-lc', command], {
          cwd,
          env: process.env,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        let out = '';
        const onData = (b: Buffer) => {
          out += b.toString();
          if (out.length > 200_000) out = out.slice(0, 200_000);
        };
        const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', (e) => {
          clearTimeout(timer);
          res({ content: `Failed to run command: ${e.message}`, isError: true });
        });
        child.on('close', (code, sig) => {
          clearTimeout(timer);
          const status = sig ? `killed by ${sig}` : `exit ${code ?? 0}`;
          const body = out.trim().length ? truncate(out.trim()) : '(no output)';
          res({ content: `[${status}]\n${body}`, isError: code !== 0 && code !== null });
        });
      });
    } catch (e) {
      return errResult(e);
    }
  },
};

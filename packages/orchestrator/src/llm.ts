/**
 * The lead's own reasoning goes through MAYA'S gateway (dogfooding) — one
 * minimal chat client, ModelId-addressed, JSON-disciplined with bounded
 * parse-retries. No SDK dependency: the gateway is OpenAI-compatible.
 */

export interface LlmClientOptions {
  /** e.g. "http://127.0.0.1:4100" */
  gatewayBaseUrl: string;
  /** ModelId the lead thinks with, e.g. "local/qwen2.5-coder-7b". */
  model: string;
  temperature?: number;
  timeoutMs?: number;
}

export class LlmClient {
  constructor(private readonly opts: LlmClientOptions) {}

  async chat(system: string, user: string): Promise<string> {
    const res = await fetch(`${this.opts.gatewayBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: this.opts.temperature ?? 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 180_000),
    });
    if (!res.ok) throw new Error(`gateway chat failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('gateway chat returned no content');
    return content;
  }

  /**
   * Ask for JSON matching the caller's description; parse with bounded
   * retries (the retry feeds the parse error back — small local models
   * usually self-correct in one round).
   */
  async json<T>(system: string, user: string, validate: (v: unknown) => T, retries = 2): Promise<T> {
    let lastErr = '';
    for (let attempt = 0; attempt <= retries; attempt++) {
      const prompt = attempt === 0 ? user : `${user}\n\nYour previous reply was invalid: ${lastErr}\nReply with ONLY valid JSON.`;
      const raw = await this.chat(system, prompt);
      const text = extractJson(raw);
      try {
        return validate(JSON.parse(text));
      } catch (err) {
        lastErr = String(err).slice(0, 200);
      }
    }
    throw new Error(`model did not produce valid JSON after ${retries + 1} attempts: ${lastErr}`);
  }
}

/** Strip code fences / prose around the first JSON value. */
export function extractJson(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.search(/[[{]/);
  if (start === -1) return body;
  // Walk to the matching close of the first bracket.
  const open = body[start]!;
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return body.slice(start);
}

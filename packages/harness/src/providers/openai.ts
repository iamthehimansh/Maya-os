/**
 * OpenAI provider adapter. OWNER: @providers.
 *
 * `stream(req)` drives the `openai` SDK's Responses API (streaming, function
 * calling) and maps SDK events → StreamEvent (text_delta / tool_call / usage /
 * done). It works against BOTH endpoints, selected purely by the credential:
 *   kind='api'   → api.openai.com with the API key.
 *   kind='oauth' → the ChatGPT/Codex backend (cred.baseUrl) with the subscription
 *                  access token + cred.headers (ChatGPT-Account-Id, originator).
 *
 * Translation:
 *   ModelMessage[] -> Responses `input` items (assistant tool_call blocks become
 *                     `function_call` items; user tool_result blocks become
 *                     `function_call_output` items).
 *   ToolSpec[]     -> Responses function tools (flat name/description/parameters).
 * Never log cred.token.
 */
import OpenAI from 'openai';
import type {
  ResponseInput,
  ResponseInputItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import type {
  Credential,
  ModelMessage,
  Provider,
  StopReason,
  StreamEvent,
  StreamRequest,
  ToolSpec,
  Usage,
} from '../types.js';
import { PROVIDER_CATALOG } from './index.js';

function buildClient(cred: Credential): OpenAI {
  return new OpenAI({
    apiKey: cred.token, // API key OR ChatGPT/Codex OAuth access token (Bearer)
    ...(cred.baseUrl ? { baseURL: cred.baseUrl } : {}),
    ...(cred.headers ? { defaultHeaders: cred.headers } : {}),
    maxRetries: 2,
  });
}

/** Flatten ModelMessage[] into the Responses API heterogeneous input list. */
export function toResponsesInput(messages: readonly ModelMessage[]): ResponseInput {
  const items: ResponseInputItem[] = [];
  for (const m of messages) {
    const texts: string[] = [];
    // Image parts force the message body into the structured content-part form
    // (input_text + input_image); text-only turns stay a plain string.
    const images: { type: 'input_image'; image_url: string; detail: 'auto' }[] = [];
    for (const b of m.content) {
      switch (b.type) {
        case 'text':
          texts.push(b.text);
          break;
        case 'image':
          images.push({
            type: 'input_image',
            image_url: `data:${b.mediaType};base64,${b.data}`,
            detail: 'auto',
          });
          break;
        case 'tool_call':
          items.push({
            type: 'function_call',
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
          });
          break;
        case 'tool_result':
          items.push({
            type: 'function_call_output',
            call_id: b.toolCallId,
            output: b.content,
          });
          break;
      }
    }
    if (images.length > 0) {
      // Vision input is only valid on user turns in the Responses API.
      const parts = [
        ...(texts.length ? [{ type: 'input_text' as const, text: texts.join('\n') }] : []),
        ...images,
      ];
      items.push({ role: 'user', content: parts });
    } else if (texts.length > 0) {
      // EasyInputMessage accepts a plain string body for either role.
      items.push({ role: m.role, content: texts.join('\n') });
    }
  }
  return items;
}

export function toResponsesTools(tools: readonly ToolSpec[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema as Record<string, unknown>,
    strict: false,
  }));
}

export function createOpenAIProvider(cred: Credential): Provider {
  const client = buildClient(cred);
  // The ChatGPT/Codex backend (subscription) rejects max_output_tokens as an
  // "unsupported parameter"; only api.openai.com honours it.
  const isCodexBackend = cred.kind === 'oauth';

  return {
    id: 'openai',
    models: PROVIDER_CATALOG.openai!.models,
    async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
      const tools = req.tools && req.tools.length > 0 ? toResponsesTools(req.tools) : undefined;
      const stream = await client.responses.create(
        {
          model: req.model,
          ...(req.system ? { instructions: req.system } : {}),
          input: toResponsesInput(req.messages),
          ...(tools ? { tools } : {}),
          ...(req.maxTokens && !isCodexBackend ? { max_output_tokens: req.maxTokens } : {}),
          // gpt-5.x reasoning models reject non-default temperature; omit it.
          stream: true,
          store: false,
        },
        req.signal ? { signal: req.signal } : {},
      );

      const usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let sawToolCall = false;
      let stopReason: StopReason = 'end_turn';

      for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
        switch (event.type) {
          case 'response.output_text.delta':
            yield { type: 'text_delta', text: event.delta };
            break;
          case 'response.output_item.done': {
            const item = event.item;
            if (item.type === 'function_call') {
              sawToolCall = true;
              let input: unknown = {};
              try {
                input = item.arguments && item.arguments.trim() ? JSON.parse(item.arguments) : {};
              } catch {
                input = {};
              }
              yield { type: 'tool_call', id: item.call_id, name: item.name, input };
            }
            break;
          }
          case 'response.completed':
          case 'response.incomplete': {
            const u = event.response.usage;
            if (u) {
              usage.inputTokens = u.input_tokens ?? 0;
              usage.outputTokens = u.output_tokens ?? 0;
              const cached = u.input_tokens_details?.cached_tokens;
              if (cached != null) usage.cacheReadTokens = cached;
            }
            if (event.type === 'response.incomplete') {
              const reason = event.response.incomplete_details?.reason;
              stopReason = reason === 'max_output_tokens' ? 'max_tokens' : 'stop';
            } else {
              stopReason = sawToolCall ? 'tool_use' : 'end_turn';
            }
            break;
          }
          case 'error':
            yield { type: 'usage', usage };
            yield { type: 'done', stopReason: 'error' };
            return;
        }
      }

      yield { type: 'usage', usage };
      yield { type: 'done', stopReason };
    },
  };
}

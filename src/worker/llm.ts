// Provider-agnostic LLM client. Call sites keep speaking the Anthropic
// Messages shapes they already use (system blocks, tools, tool_use/tool_result
// turns, streaming with finalMessage); llmFor() hands back either the real
// Anthropic SDK (house key or the user's) or an adapter that speaks OpenAI
// chat-completions to OpenAI / Moonshot / Groq / Cerebras with the user's key.
//
// The adapter implements exactly the SDK surface this codebase consumes:
// async-iterated stream events (text_delta / thinking_delta /
// content_block_start), stream.on("text"), finalMessage(), and
// messages.create(). Anthropic-only params (cache_control, thinking) are
// dropped on the OpenAI wire; reasoning_effort rides through for models that
// support it; response_format json_schema maps when the provider honors it.
import Anthropic from "@anthropic-ai/sdk";
import type { Env, UserRow } from "./types";
import { MODELS, PROVIDERS, type ModelInfo, type ProviderId, type ProviderInfo } from "./catalog";
import { parseConfig, resolveSlug, resolveUseCase, type ResolvedUseCase, type UseCase } from "./config";
import { getProviderKey, listProviderKeys } from "./keys";

export interface LlmParams {
  model: string;
  max_tokens: number;
  system?: string | Anthropic.TextBlockParam[];
  tools?: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  /** Wire-specific knobs (thinking, output_config, reasoning_effort,
   * cache_control) pass through; each wire keeps what it understands. */
  [k: string]: unknown;
}

export interface LlmStream extends AsyncIterable<Anthropic.MessageStreamEvent> {
  on(event: "text", listener: (text: string) => void): unknown;
  finalMessage(): Promise<Anthropic.Message>;
}

export interface LlmClient {
  messages: {
    create(params: LlmParams): Promise<Anthropic.Message>;
    stream(params: LlmParams): LlmStream;
  };
}

export interface LlmSelection {
  client: LlmClient;
  resolved: ResolvedUseCase;
  provider: ProviderId;
  /** True when the request bills the user's own key (any provider). */
  byok: boolean;
}

/** No usable model: built-in AI off and no working provider key. Chat turns
 * turn this into a friendly auto-reply; cron paths log and skip. */
export class NoAiError extends Error {
  constructor() {
    super("No AI enabled — add a provider key or enable Todo Log's AI in Settings → Models");
  }
}

/** Resolve the use case to a client. A model is usable when its provider has
 * a key on file, or it's Anthropic with the built-in AI enabled. Unusable
 * picks (key deleted after selection, built-in AI switched off, vault secret
 * rotated) fall back to the user's default model, then to the cheapest usable
 * model in the catalog; nothing usable at all throws NoAiError. */
export async function llmFor(env: Env, user: UserRow, useCase: UseCase): Promise<LlmSelection> {
  const cfg = parseConfig(user.agent_config);
  const keyRows = await listProviderKeys(env, user.id);
  const hasKey = new Set(keyRows.map((k) => k.provider));
  const usable = (slug: string) => {
    const p = MODELS[slug]?.provider;
    return !!p && (hasKey.has(p) || (p === "anthropic" && cfg.builtin_ai));
  };

  let resolved = resolveUseCase(user, useCase);
  if (!usable(resolved.slug)) {
    const cheapest = Object.values(MODELS)
      .filter((m) => usable(m.slug))
      .sort((a, b) => 0.7 * a.input + 0.3 * a.output - (0.7 * b.input + 0.3 * b.output))[0];
    const fallback = usable(cfg.default.model) ? cfg.default.model : cheapest?.slug;
    if (!fallback) throw new NoAiError();
    console.warn(
      `llm: user ${user.id} wants ${resolved.slug} but it's not usable — using ${fallback}`,
    );
    resolved = resolveSlug(fallback, resolved.thinking);
  }

  const key = hasKey.has(resolved.provider)
    ? await getProviderKey(env, user.id, resolved.provider)
    : null;
  const byok = !!key;
  if (resolved.provider === "anthropic") {
    // A decrypt failure with built-in AI off leaves nothing to bill — bail.
    if (!key && !cfg.builtin_ai) throw new NoAiError();
    const sdk = new Anthropic({ apiKey: key ?? env.ANTHROPIC_API_KEY });
    const client: LlmClient = {
      messages: {
        create: (p) => sdk.messages.create(p as unknown as Anthropic.MessageCreateParamsNonStreaming),
        stream: (p) => sdk.messages.stream(p as unknown as Anthropic.MessageStreamParams),
      },
    };
    return { client, resolved, provider: resolved.provider, byok };
  }
  if (!key) {
    // Row existed but wouldn't decrypt: retreat to the house model if allowed.
    if (!cfg.builtin_ai) throw new NoAiError();
    resolved = resolveSlug(
      MODELS[cfg.default.model]?.provider === "anthropic" ? cfg.default.model : "sonnet",
      resolved.thinking,
    );
    const sdk = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    return {
      client: {
        messages: {
          create: (p) => sdk.messages.create(p as unknown as Anthropic.MessageCreateParamsNonStreaming),
          stream: (p) => sdk.messages.stream(p as unknown as Anthropic.MessageStreamParams),
        },
      },
      resolved,
      provider: resolved.provider,
      byok: false,
    };
  }
  return {
    client: new OpenAiWireClient(PROVIDERS[resolved.provider], key, MODELS[resolved.slug]),
    resolved,
    provider: resolved.provider,
    byok,
  };
}

/** Cheap live check when a key is pasted: list the provider's models. */
export async function checkProviderKey(
  provider: ProviderId,
  key: string,
): Promise<{ ok: boolean; error?: string }> {
  const p = PROVIDERS[provider];
  const anthropicWire = p.wire === "anthropic";
  try {
    const res = await fetch(anthropicWire ? `${p.baseUrl}/v1/models` : `${p.baseUrl}/models`, {
      headers: anthropicWire
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { authorization: `Bearer ${key}` },
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `${p.label} rejected the key (HTTP ${res.status})` };
  } catch (err) {
    return { ok: false, error: `couldn't reach ${p.label}: ${err instanceof Error ? err.message : err}` };
  }
}

// ---------------------------------------------------------------------------
// OpenAI chat-completions wire
// ---------------------------------------------------------------------------

interface OpenAiToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

function systemText(system: LlmParams["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n\n");
}

/** Anthropic-shaped conversation → chat-completions messages. tool_results
 * become role:"tool" messages (kept ahead of any sibling text so they stay
 * adjacent to the assistant tool_calls turn that produced them). */
function toWireMessages(params: LlmParams): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const sys = systemText(params.system);
  if (sys) out.push({ role: "system", content: sys });
  for (const m of params.messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      let text = "";
      const toolCalls: Record<string, unknown>[] = [];
      for (const b of m.content) {
        if (b.type === "text") text += (text ? "\n\n" : "") + b.text;
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
        // thinking blocks never round-trip on this wire
      }
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      let text = "";
      for (const b of m.content) {
        if (b.type === "tool_result") {
          const content =
            typeof b.content === "string"
              ? b.content
              : (b.content ?? []).map((x) => (x.type === "text" ? x.text : "")).join("\n");
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content });
        } else if (b.type === "text") {
          text += (text ? "\n\n" : "") + b.text;
        }
      }
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}

function stopReason(finish: string | null): Anthropic.Message["stop_reason"] {
  if (finish === "tool_calls") return "tool_use";
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  return "end_turn";
}

function mapUsage(u: OpenAiUsage | null | undefined): Anthropic.Usage {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (u?.prompt_tokens ?? 0) - cached),
    output_tokens: u?.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  } as Anthropic.Usage;
}

function safeParse(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function buildMessage(
  model: string,
  text: string,
  toolCalls: Map<number, { id: string; name: string; args: string }>,
  finish: string | null,
  usage: OpenAiUsage | null,
): Anthropic.Message {
  const content: unknown[] = [];
  if (text) content.push({ type: "text", text, citations: null });
  for (const [index, tc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    content.push({
      type: "tool_use",
      id: tc.id || `call_${index}`,
      name: tc.name,
      input: safeParse(tc.args),
    });
  }
  return {
    id: "adapter",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: toolCalls.size > 0 ? "tool_use" : stopReason(finish),
    stop_sequence: null,
    usage: mapUsage(usage),
  } as unknown as Anthropic.Message;
}

class OpenAiWireClient implements LlmClient {
  constructor(
    private p: ProviderInfo,
    private key: string,
    private model: ModelInfo,
  ) {}

  messages = {
    create: async (params: LlmParams): Promise<Anthropic.Message> => {
      const res = await this.fetch(this.body(params, false));
      const data = (await res.json()) as {
        choices?: { message?: { content?: string | null; tool_calls?: OpenAiToolCall[] }; finish_reason?: string }[];
        usage?: OpenAiUsage;
      };
      const choice = data.choices?.[0];
      const toolCalls = new Map<number, { id: string; name: string; args: string }>();
      for (const [i, tc] of (choice?.message?.tool_calls ?? []).entries()) {
        toolCalls.set(i, {
          id: tc.id ?? "",
          name: tc.function?.name ?? "",
          args: tc.function?.arguments ?? "{}",
        });
      }
      return buildMessage(
        params.model,
        choice?.message?.content ?? "",
        toolCalls,
        choice?.finish_reason ?? null,
        data.usage ?? null,
      );
    },
    stream: (params: LlmParams): LlmStream => new OpenAiWireStream(this, params),
  };

  body(params: LlmParams, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: toWireMessages(params),
    };
    // OpenAI proper rejects max_tokens on reasoning models; everyone else
    // still expects it.
    if (this.p.id === "openai") body.max_completion_tokens = params.max_tokens;
    else body.max_tokens = params.max_tokens;
    if (params.tools?.length) {
      body.tools = params.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    }
    // OpenAI's /chat/completions refuses function tools unless
    // reasoning_effort is EXPLICITLY 'none' on GPT-5.6 models (omitting it
    // leaves their default reasoning on → same 400). So: tools on OpenAI
    // force "none"; the knob still works for tool-less uses (briefing,
    // check-ins) and everywhere on Groq/Cerebras. The real fix is their
    // /v1/responses API — future work.
    if (this.p.id === "openai" && params.tools?.length) {
      body.reasoning_effort = "none";
    } else if (typeof params.reasoning_effort === "string") {
      body.reasoning_effort = params.reasoning_effort;
    }
    const format = (params.output_config as { format?: { type?: string; schema?: unknown } } | undefined)
      ?.format;
    if (format?.type === "json_schema" && this.model.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "result", strict: true, schema: format.schema },
      };
    }
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  async fetch(body: Record<string, unknown>): Promise<Response> {
    const res = await fetch(`${this.p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      throw new Error(`${this.p.label} API error ${res.status}: ${detail}`);
    }
    return res;
  }
}

class OpenAiWireStream implements LlmStream {
  private queue: Anthropic.MessageStreamEvent[] = [];
  private waiters: ((r: IteratorResult<Anthropic.MessageStreamEvent>) => void)[] = [];
  private closed = false;
  private error: unknown = null;
  private final: Anthropic.Message | null = null;
  private textListeners: ((t: string) => void)[] = [];
  private donePromise: Promise<void>;

  constructor(client: OpenAiWireClient, params: LlmParams) {
    this.donePromise = this.pump(client, params).then(
      () => this.finish(),
      (err) => {
        this.error = err;
        this.finish();
      },
    );
  }

  on(event: "text", listener: (text: string) => void): this {
    if (event === "text") this.textListeners.push(listener);
    return this;
  }

  async finalMessage(): Promise<Anthropic.Message> {
    await this.donePromise;
    if (this.error) throw this.error;
    if (!this.final) throw new Error("stream ended without a message");
    return this.final;
  }

  [Symbol.asyncIterator](): AsyncIterator<Anthropic.MessageStreamEvent> {
    return {
      next: (): Promise<IteratorResult<Anthropic.MessageStreamEvent>> => {
        const ev = this.queue.shift();
        if (ev) return Promise.resolve({ value: ev, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }

  private push(ev: unknown): void {
    const event = ev as Anthropic.MessageStreamEvent;
    const w = this.waiters.shift();
    if (w) w({ value: event, done: false });
    else this.queue.push(event);
  }

  private finish(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  private async pump(client: OpenAiWireClient, params: LlmParams): Promise<void> {
    const res = await client.fetch(client.body(params, true));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let text = "";
    let sawText = false;
    let finish: string | null = null;
    let usage: OpenAiUsage | null = null;
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();

    const handleLine = (line: string) => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let chunk: {
        choices?: {
          delta?: { content?: string | null; reasoning?: string | null; tool_calls?: OpenAiToolCall[] };
          finish_reason?: string | null;
        }[];
        usage?: OpenAiUsage | null;
        x_groq?: { usage?: OpenAiUsage };
      };
      try {
        chunk = JSON.parse(payload) as typeof chunk;
      } catch {
        return; // partial keep-alive noise
      }
      if (chunk.usage) usage = chunk.usage;
      else if (chunk.x_groq?.usage) usage = chunk.x_groq.usage;
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta ?? {};
      // Some providers (Groq gpt-oss et al.) stream reasoning; surface it the
      // way call sites already understand.
      if (typeof delta.reasoning === "string" && delta.reasoning) {
        this.push({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: delta.reasoning },
        });
      }
      if (typeof delta.content === "string" && delta.content) {
        if (!sawText) {
          sawText = true;
          this.push({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "", citations: null },
          });
        }
        text += delta.content;
        this.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta.content } });
        for (const l of this.textListeners) l(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const cur = toolCalls.get(index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        toolCalls.set(index, cur);
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) handleLine(line.trim());
    }
    if (buf.trim()) handleLine(buf.trim());

    this.final = buildMessage(params.model, text, toolCalls, finish, usage);
  }
}

/**
 * DeepSeek Chat API client with streaming support.
 * Uses SSE (Server-Sent Events) for real-time token delivery.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface DeepSeekResponse {
  id: string;
  choices: {
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

let apiKey = "";
let apiBaseUrl = "https://api.deepseek.com";
let apiModel = "deepseek-chat";

export function setDeepSeekApiKey(key: string) {
  apiKey = key;
}

export function getDeepSeekApiKey(): string {
  return apiKey;
}

export function setDeepSeekBaseUrl(url: string) {
  apiBaseUrl = url.replace(/\/+$/, ""); // strip trailing slash
}

export function getDeepSeekBaseUrl(): string {
  return apiBaseUrl;
}

export function setDeepSeekModel(model: string) {
  apiModel = model;
}

export function getDeepSeekModel(): string {
  return apiModel;
}

function getCompletionsUrl(): string {
  return `${apiBaseUrl}/chat/completions`;
}

/**
 * Streaming chat completion — yields tokens as they arrive.
 */
export async function* streamChatCompletion(
  messages: ChatMessage[],
  options?: {
    temperature?: number;
    max_tokens?: number;
    model?: string;
  },
): AsyncGenerator<string, string, undefined> {
  if (!apiKey) throw new Error("DeepSeek API key not set");

  const res = await fetch(getCompletionsUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: options?.model ?? apiModel,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.max_tokens ?? 8192,
      stream: true,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    throw new Error(`DeepSeek API error ${res.status}: ${errText}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let fullContent = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          yield delta;
        }
      } catch {
        // skip malformed chunks
      }
    }
  }

  return fullContent;
}

/**
 * Non-streaming chat completion (for simple calls).
 */
export async function chatCompletion(
  messages: ChatMessage[],
  options?: {
    temperature?: number;
    max_tokens?: number;
    model?: string;
  },
): Promise<string> {
  if (!apiKey) throw new Error("DeepSeek API key not set");

  const res = await fetch(getCompletionsUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: options?.model ?? apiModel,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.max_tokens ?? 4096,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    throw new Error(`DeepSeek API error ${res.status}: ${errText}`);
  }

  const data: DeepSeekResponse = await res.json();
  return data.choices[0]?.message?.content ?? "";
}

/**
 * Parse JSON from LLM response, handling markdown code blocks.
 */
export function parseJsonResponse<T>(raw: string): T {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  return JSON.parse(cleaned) as T;
}

/**
 * Claude (Anthropic) LLM helper for iAudit rewrite and audit calls.
 * Mirrors the invokeLLM interface so callers can swap between models easily.
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-5";
const DEFAULT_MAX_TOKENS = 32000;

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ClaudeOptions {
  messages: ClaudeMessage[];
  system?: string;
  max_tokens?: number;
  model?: string;
  response_format?: {
    type: "json_schema";
    json_schema: {
      name: string;
      strict?: boolean;
      schema: Record<string, unknown>;
    };
  };
}

export interface ClaudeResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
  }>;
}

/**
 * Invoke Claude via the Anthropic Messages API.
 * Returns a response shaped like the OpenAI-compatible invokeLLM response
 * so existing callers can access result.choices[0].message.content.
 */
export async function invokeClaude(options: ClaudeOptions): Promise<ClaudeResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  // Build the system prompt — if response_format is json_schema, append a JSON instruction
  let systemPrompt = options.system ?? "";
  if (options.response_format?.type === "json_schema") {
    const schemaStr = JSON.stringify(options.response_format.json_schema.schema, null, 2);
    systemPrompt +=
      "\n\nYou MUST respond with a valid JSON object that strictly conforms to this schema. " +
      "Do NOT include any text outside the JSON object. Do NOT use markdown fences.\n\nSchema:\n" +
      schemaStr;
  }

  const body: Record<string, unknown> = {
    model: options.model ?? DEFAULT_MODEL,
    max_tokens: options.max_tokens ?? DEFAULT_MAX_TOKENS,
    messages: options.messages,
  };
  if (systemPrompt) {
    body.system = systemPrompt;
  }

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text: string }>;
    error?: { message: string };
  };

  if (data.error) {
    throw new Error(`Anthropic API error: ${data.error.message}`);
  }

  const text = data.content?.find((c) => c.type === "text")?.text ?? "";

  // Return in OpenAI-compatible shape
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: text,
        },
      },
    ],
  };
}

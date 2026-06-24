import type { ResolvedApiFormat } from "./types.ts";

export function normalizeBaseUrl(baseUrl: string): string[] {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const candidates = new Set<string>();

  candidates.add(trimmed);

  if (trimmed.endsWith("/v1")) {
    candidates.add(trimmed.slice(0, -3));
  } else {
    candidates.add(`${trimmed}/v1`);
  }

  candidates.add(`${trimmed}/chat/completions`);
  candidates.add(`${trimmed}/v1/chat/completions`);
  candidates.add(`${trimmed}/responses`);
  candidates.add(`${trimmed}/v1/responses`);

  return Array.from(candidates);
}

export async function detectApiFormat(baseUrl: string, apiKey: string): Promise<ResolvedApiFormat | null> {
  const candidates = normalizeBaseUrl(baseUrl);

  for (const candidate of candidates) {
    const modelsUrl = candidate.endsWith("/models") ? candidate : `${candidate}/models`;
    const modelsOk = await probeModelsEndpoint(modelsUrl, apiKey);
    if (!modelsOk) continue;

    const responsesUrl = candidate.endsWith("/responses") ? candidate : `${candidate}/responses`;
    const responsesOk = await probeResponsesEndpoint(responsesUrl, apiKey);
    if (responsesOk) {
      return { format: "openai-new", baseUrl: candidate };
    }

    const completionsUrl = candidate.endsWith("/chat/completions") ? candidate : `${candidate}/chat/completions`;
    const completionsOk = await probeCompletionsEndpoint(completionsUrl, apiKey);
    if (completionsOk) {
      return { format: "openai-old", baseUrl: candidate };
    }

    return { format: "openai-old", baseUrl: candidate };
  }

  return null;
}

async function probeModelsEndpoint(url: string, apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { data?: unknown[] };
    return Array.isArray(data.data);
  } catch {
    return false;
  }
}

async function probeResponsesEndpoint(url: string, apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "probe-model",
        input: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(10000),
    });
    return res.status !== 404;
  } catch {
    return false;
  }
}

async function probeCompletionsEndpoint(url: string, apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "probe-model",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(10000),
    });
    return res.status !== 404;
  } catch {
    return false;
  }
}

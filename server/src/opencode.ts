import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";

let cached: { baseUrl: string; headers: Record<string, string> } | null = null;

/**
 * Discover the local OpenCode background service (starting it if needed) and
 * build the auth headers the server expects. Cached for the process lifetime.
 */
export async function endpoint(): Promise<{ baseUrl: string; headers: Record<string, string> }> {
  if (cached) return cached;
  const ep = await Service.ensure();
  const value = {
    baseUrl: ep.url.replace(/\/$/, ""),
    headers: (Service.headers(ep) ?? {}) as Record<string, string>,
  };
  cached = value;
  return value;
}

/** Minimal typed fetch against the OpenCode HTTP API. */
export async function oc<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  const { baseUrl, headers } = await endpoint();
  const res = await fetch(baseUrl + path, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: opts.signal,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenCode ${method} ${path} -> ${res.status}: ${text.slice(0, 600)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export interface AssistantMessage {
  id: string;
  type: string;
  agent?: string;
  model?: { id: string };
  time?: { created: number; completed?: number };
  finish?: string;
  content?: Array<{ type?: string; text?: string }>;
  error?: { type?: string; message?: string };
  text?: string;
}

export interface IdleMessage {
  type: "idle";
  outcome?: string;
  time: { created: number };
}

/**
 * Unwrap an error chain. `fetch()` reports "fetch failed" and hides the real
 * reason (ECONNREFUSED, HeadersTimeoutError, …) in `err.cause`.
 */
export function describeError(err: unknown): string {
  const e = err as { message?: string; name?: string; code?: string; cause?: unknown };
  const parts: string[] = [];
  if (e?.message) parts.push(String(e.message));
  let cause = e?.cause as { message?: string; name?: string; code?: string; cause?: unknown } | undefined;
  for (let depth = 0; cause && depth < 4; depth++) {
    const name = cause.name && cause.name !== "Error" ? `${cause.name}: ` : "";
    const code = cause.code ? ` (${cause.code})` : "";
    parts.push(`${name}${cause.message ?? String(cause)}${code}`);
    cause = cause.cause as typeof cause;
  }
  const text = parts.join(" — ") || String(err);
  if (/timeout/i.test(text)) {
    return `${text} [the request timed out; the agent may still be working]`;
  }
  return text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const IDLE_POLL_MS = Number(process.env.ORCHESTRA_IDLE_POLL_MS ?? 1500);
const IDLE_POLL_RETRIES = Number(process.env.ORCHESTRA_IDLE_POLL_RETRIES ?? 8);

/**
 * Wait for a turn to finish by polling, instead of holding one long request.
 *
 * The previous `POST /experimental/session/{id}/wait` call kept a single HTTP
 * request open until the session went idle. Node's fetch (undici) aborts any
 * request whose response headers do not arrive within 300s, so any task running
 * longer than 5 minutes died with an opaque "fetch failed" — while the agent was
 * still working and went on to succeed. Short polls cannot hit that timer.
 *
 * `session.outcome` is stale across turns, so completion is detected from the
 * turn-specific `idle` message (created after the prompt time).
 */
export async function waitForTurn(
  sessionID: string,
  promptTime: number,
  timeoutMs: number,
  label: string,
): Promise<IdleMessage> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveFailures = 0;

  for (;;) {
    try {
      const res = await oc<{ data: IdleMessage[] }>(
        "GET",
        `/api/session/${sessionID}/message?limit=6`,
      );
      consecutiveFailures = 0;
      const idle = res.data.find(
        (m) => m.type === "idle" && (m.time?.created ?? 0) >= promptTime - 1000,
      );
      if (idle) return idle;
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures > IDLE_POLL_RETRIES) {
        throw new Error(`${label}: lost contact with OpenCode — ${describeError(err)}`);
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `${label} timed out after ${Math.round(timeoutMs / 1000)}s; the agent may still be working (session ${sessionID})`,
      );
    }
    await sleep(IDLE_POLL_MS);
  }
}

export async function serverInfo() {
  return oc<{ version: string; urls: string[] }>("GET", "/api/info");
}

export async function listAgents() {
  const r = await oc<{ data: Array<{ id: string; name: string; mode: string; description?: string }> }>(
    "GET",
    "/api/agent",
  );
  return r.data;
}

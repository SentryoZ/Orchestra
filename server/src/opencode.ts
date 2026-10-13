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

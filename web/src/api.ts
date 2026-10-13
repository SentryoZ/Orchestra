import type { Agent, Mission, MissionTask, ModelRef } from "./types";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((json && json.error) || `${res.status} ${res.statusText}`);
  return (json?.data ?? json) as T;
}

export const api = {
  health: () => req<{ version: string; urls: string[] }>("GET", "/api/health"),
  agents: () => req<Agent[]>("GET", "/api/agents"),
  missions: () => req<Mission[]>("GET", "/api/missions"),
  mission: (id: string) => req<Mission>("GET", `/api/missions/${id}`),
  deleteMission: (id: string) => req<{ removed: string }>("DELETE", `/api/missions/${id}`),
  clearMissions: () => req<{ removed: number }>("DELETE", "/api/missions"),
  createMission: (idea: string, targetDirectory: string, model?: ModelRef) =>
    req<Mission>("POST", "/api/missions", { idea, targetDirectory, model }),
  answerMission: (id: string, answers: Record<string, string>) =>
    req<Mission>("POST", `/api/missions/${id}/answers`, { answers }),
  updatePlan: (id: string, tasks: MissionTask[]) =>
    req<Mission>("PUT", `/api/missions/${id}/plan`, { tasks }),
  revisePlan: (id: string, instruction: string) =>
    req<Mission>("POST", `/api/missions/${id}/revise`, { instruction }),
  runMission: (id: string) => req<Mission>("POST", `/api/missions/${id}/run`),
  retryMission: (id: string, taskId?: string) =>
    req<Mission>("POST", `/api/missions/${id}/retry`, taskId ? { taskId } : {}),
};

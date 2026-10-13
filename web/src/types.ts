export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface Agent {
  id: string;
  name: string;
  mode: string;
  description?: string;
}

export interface MissionQuestion {
  id: string;
  text: string;
  /** Optional choices offered by the agent; free-form answers are still allowed. */
  options?: string[];
}

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type MissionStatus =
  | "planning"
  | "awaiting_answers"
  | "ready"
  | "running"
  | "succeeded"
  | "failed";

export interface MissionTask {
  id: string;
  title: string;
  agent: string;
  prompt: string;
  dependsOn: string[];
  readOnly?: boolean;
  status: TaskStatus;
  sessionID?: string;
  branch?: string;
  output?: string;
  error?: string;
  integration?: "merged" | "conflict" | "skipped" | "no-changes";
  startedAt?: number;
  finishedAt?: number;
}

export interface Mission {
  id: string;
  idea: string;
  targetDirectory: string;
  model?: ModelRef;
  status: MissionStatus;
  questions: MissionQuestion[];
  answers: Record<string, string>;
  tasks: MissionTask[];
  waves: string[][];
  notes: string[];
  /** Instructions the user has asked the CTO to apply, in order. */
  revisions?: string[];
  error?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}

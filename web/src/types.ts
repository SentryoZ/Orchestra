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

export interface ReviewCheck {
  name: string;
  result: string;
  evidence?: string;
}

export interface ReviewFailure {
  summary: string;
  files?: string[];
  suggestedFix?: string;
  severity?: "blocker" | "major" | "minor";
}

export interface ReviewVerdict {
  status: "pass" | "fail" | "unknown";
  checks?: ReviewCheck[];
  failures?: ReviewFailure[];
  unparsed?: string;
}

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
  review?: ReviewVerdict;
  fixRound?: number;
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
  /** Outcome of the final review, after any fix rounds. */
  reviewVerdict?: "pass" | "fail" | "unknown";
  /** How many fix rounds the review loop ran. */
  reviewRounds?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}

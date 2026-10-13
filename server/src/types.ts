export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface MissionQuestion {
  id: string;
  text: string;
  /** Optional choices the agent offers; the user may still type a free-form answer. */
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
  /** The raw reply when it was not valid JSON. */
  unparsed?: string;
}

export interface MissionTask {
  id: string;
  title: string;
  agent: string;
  prompt: string;
  /** Ids of tasks that must finish (and merge) before this one starts. */
  dependsOn: string[];
  /** Read-only tasks cannot edit files. */
  readOnly?: boolean;
  status: TaskStatus;
  sessionID?: string;
  branch?: string;
  worktree?: string;
  output?: string;
  error?: string;
  integration?: "merged" | "conflict" | "skipped" | "no-changes";
  /** For the final review task: the parsed verdict it returned. */
  review?: ReviewVerdict;
  /** Which review round produced this fix task. */
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
  /** question id -> answer text. */
  answers: Record<string, string>;
  tasks: MissionTask[];
  /** Human-readable log of git setup and integration decisions. */
  notes: string[];
  /** The CTO's planning session, reused so revisions keep the conversation. */
  ctoSessionID?: string;
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

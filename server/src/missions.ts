 import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { oc, type AssistantMessage } from "./opencode.js";
import { ensureDirectory } from "./util.js";
import {
  commitWorktree,
  createWorktree,
  deleteBranch,
  ensureRepo,
  mergeBranch,
  removeWorktree,
} from "./git.js";
import type { Mission, MissionQuestion, MissionTask, ModelRef } from "./types.js";

export const missionEvents = new EventEmitter();
missionEvents.setMaxListeners(100);

const missions = new Map<string, Mission>();

const MAX_PARALLEL = Number(process.env.ORCHESTRA_MAX_PARALLEL ?? 3);
const TASK_TIMEOUT_MS = Number(process.env.ORCHESTRA_TASK_TIMEOUT_MS ?? 1_200_000);
const WORKTREE_ROOT = process.env.ORCHESTRA_WORKTREE_DIR ?? "/tmp/opencode/orchestra-worktrees";

const ALLOW_ALL = [{ action: "*", resource: "*", effect: "allow" as const }];
const READ_ONLY = [
  { action: "edit", resource: "*", effect: "deny" as const },
  { action: "write", resource: "*", effect: "deny" as const },
];

const READ_ONLY_AGENTS = new Set(["plan", "explore"]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE =
  process.env.ORCHESTRA_MISSIONS_FILE ?? path.resolve(__dirname, "../../missions.json");

/* -------------------------------- persistence ------------------------------- */

function loadHistory() {
  try {
    const saved = JSON.parse(readFileSync(DATA_FILE, "utf8")) as Mission[];
    for (const m of saved) {
      // A mission that was mid-flight when the server stopped cannot be resumed.
      if (m.status === "running" || m.status === "planning") {
        m.status = "failed";
        m.error = "interrupted by a server restart";
      }
      missions.set(m.id, m);
    }
  } catch {
    /* no history yet */
  }
}

let saveTimer: NodeJS.Timeout | undefined;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try {
      writeFileSync(DATA_FILE, JSON.stringify(listMissions(), null, 2));
    } catch (err) {
      console.error("[missions] could not save history:", (err as Error).message);
    }
  }, 500);
}

loadHistory();

/* --------------------------------- helpers --------------------------------- */

function emit(m: Mission) {
  m.updatedAt = Date.now();
  missionEvents.emit("mission", m);
  persist();
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function extractText(m: AssistantMessage): string {
  return (m.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
    .trim();
}

function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const startObj = candidate.indexOf("{");
  const startArr = candidate.indexOf("[");
  if (startObj === -1 && startArr === -1) {
    throw new Error("The CTO did not return a JSON plan:\n" + text.slice(0, 500));
  }
  const useArray = startArr !== -1 && (startObj === -1 || startArr < startObj);
  const start = useArray ? startArr : startObj;
  const end = useArray ? candidate.lastIndexOf("]") : candidate.lastIndexOf("}");
  if (end < start) throw new Error("The CTO returned malformed JSON:\n" + text.slice(0, 500));
  return JSON.parse(candidate.slice(start, end + 1));
}

/** Create a session for one agent turn. */
async function openSession(opts: {
  directory: string;
  agent: string;
  model?: ModelRef;
  title: string;
  readOnly: boolean;
}): Promise<string> {
  const created = await oc<{ data: { id: string } }>("POST", "/api/session", {
    agent: opts.agent,
    model: opts.model,
    location: { directory: opts.directory },
    title: opts.title,
    permissions: opts.readOnly ? READ_ONLY : ALLOW_ALL,
  });
  return created.data.id;
}

/** Prompt an existing session and wait for the agent's final text. */
async function promptAndWait(sessionID: string, text: string, timeoutLabel: string): Promise<string> {
  const prompted = await oc<{ data: { time: { created: number } } }>(
    "POST",
    `/api/session/${sessionID}/prompt`,
    { text },
  );
  await withTimeout(
    oc("POST", `/api/experimental/session/${sessionID}/wait`),
    TASK_TIMEOUT_MS,
    timeoutLabel,
  );
  const msgs = await oc<{ data: AssistantMessage[] }>("GET", `/api/session/${sessionID}/message`);
  const assistant = msgs.data.find(
    (m) => m.type === "assistant" && (m.time?.created ?? 0) >= prompted.data.time.created - 1000,
  );
  if (!assistant) throw new Error("No response was produced");
  if (assistant.error) throw new Error(assistant.error.message ?? assistant.error.type ?? "Agent error");
  return extractText(assistant) || "(empty response)";
}

/** One-shot: new session, one prompt, final text. */
async function askOnce(opts: {
  directory: string;
  agent: string;
  model?: ModelRef;
  prompt: string;
  title: string;
  readOnly: boolean;
  timeoutLabel: string;
}): Promise<{ text: string; sessionID: string }> {
  const sessionID = await openSession(opts);
  const text = await promptAndWait(sessionID, opts.prompt, opts.timeoutLabel);
  return { text, sessionID };
}

/* ----------------------------------- CTO ----------------------------------- */

const CTO_PROMPT = `You are the CTO of an autonomous engineering team. Turn a high-level idea into a plan of small tasks that workers will execute in parallel where possible.

Reply with ONLY one JSON object. No prose, no markdown fences. Exactly one of these two shapes:

{"status":"needs_clarification","questions":[{"id":"q1","text":"...","options":["first choice","second choice"]}]}
{"status":"ready","tasks":[{"id":"t1","title":"short title","agent":"build","prompt":"self-contained instructions","dependsOn":[],"readOnly":false}]}

Rules:
- Ask clarifying questions FIRST if anything material is ambiguous (scope, tech choices, data model, UI expectations). Ask at most 5, each answerable in a sentence. Do not guess on something the user clearly cares about. If the idea is clear enough, go straight to "ready".
- When a question has a small set of sensible answers, include 2-5 short "options" (the user can still type something else). Omit "options" for open-ended questions.
- agent must be one of: "plan" (read-only analysis), "build" (writes code), "general" (research or review), "explore" (read-only search).
- "plan", "explore", and any readOnly task CANNOT write files. Never ask them to create or edit a file — their output is text passed to dependent tasks. Use "build" for anything that writes or edits a file.
- dependsOn lists task ids that must finish first. Tasks with no dependency between them run IN PARALLEL.
- Model the dependency graph explicitly and conservatively. Add a dependency whenever a task needs another's files or output, or edits the same file. When in doubt, add the dependency: a needless dependency costs a little time, a missing one breaks correctness.
- Decompose by LAYER, not by topic. For any non-trivial system the natural order is: foundation/infrastructure -> core domain logic -> feature logic -> wiring/entry points -> tests -> review. Each layer depends on the layers before it.
- Scale the plan to the work. A trivial idea needs 3-5 tasks; a substantial system needs 8-15. Never compress a multi-layer system into one flat wave of parallel tasks.
- Aim for at least 3 dependency levels (waves) whenever the work has more than one layer. It is normal and expected for a hard task to produce many waves. Parallelism is a bonus, not the goal — correctness and a clear order matter more.
- Each task prompt must be a complete work order, not a one-liner. A worker sees only its own task, its dependencies' summaries, and the repository — so the prompt alone must be enough to do the job. Include: what to build, the exact file path(s), the exported API (names and signatures), the key behaviours and edge cases to handle, and how to verify the result (a concrete command or check).
- Titles must be descriptive enough to understand the task without opening it. Write "Implement wordCount() counting whitespace-separated words", NOT "Implement src/wordCount.js".
- Each task must be small enough for one focused pass.
- Bad prompt: "Implement src/wordCount.js".
  Good prompt: "Create src/wordCount.js exporting a single function wordCount(text) that returns the number of whitespace-separated words. Handle: empty or whitespace-only string -> 0; runs of spaces, tabs and newlines collapse to one separator; punctuation attached to a word still counts once. Export via module.exports = { wordCount } and add a short JSDoc comment. Verify with: node -e \"const {wordCount}=require('./src/wordCount'); if(wordCount('a b  c')!==3) throw new Error('fail')\"."
- Include a final review task (agent "general", readOnly true) that depends on ALL other tasks.
- Do not include tasks that merely restate the idea; each must change or verify something concrete.
- Never put absolute filesystem paths in a task prompt. Refer to "the repository root" and relative paths; each worker runs in its own isolated copy of the repo.`;

function buildCtoPrompt(m: Mission): string {
  const answered = Object.entries(m.answers);
  const qa = answered.length
    ? "\n\nAnswers to your earlier questions:\n" +
      answered.map(([id, text]) => `- ${id}: ${text}`).join("\n")
    : "";
  return `${CTO_PROMPT}

Project directory: ${m.targetDirectory}

The idea:
${m.idea}${qa}`;
}

function normalizeQuestions(raw: any): MissionQuestion[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .map((q: any, i: number): MissionQuestion => {
      const rawOptions = Array.isArray(q?.options) ? q.options : Array.isArray(q?.choices) ? q.choices : [];
      const options = rawOptions
        .map((o: unknown) => String(o ?? "").trim())
        .filter(Boolean)
        .slice(0, 6);
      return {
        id: typeof q?.id === "string" && q.id ? q.id : `q${i + 1}`,
        text: String(q?.text ?? q ?? "").trim(),
        ...(options.length ? { options } : {}),
      };
    })
    .filter((q) => q.text)
    .slice(0, 8);
}

function normalizeTasks(raw: any): MissionTask[] {
  const arr = Array.isArray(raw) ? raw : [];
  const tasks: MissionTask[] = [];
  const seen = new Set<string>();
  for (const [i, t] of arr.entries()) {
    const id = typeof t?.id === "string" && t.id ? t.id : `t${i + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    tasks.push({
      id,
      title: String(t?.title ?? id),
      agent: typeof t?.agent === "string" ? t.agent : "build",
      prompt: String(t?.prompt ?? "").trim() || String(t?.title ?? id),
      dependsOn: Array.isArray(t?.dependsOn) ? t.dependsOn.filter((d: unknown) => typeof d === "string") : [],
      readOnly: Boolean(t?.readOnly) || READ_ONLY_AGENTS.has(String(t?.agent)),
      status: "pending",
    });
  }
  if (tasks.length === 0) throw new Error("The CTO returned no tasks");
  // Drop dependencies that do not resolve, then reject cycles.
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) t.dependsOn = [...new Set(t.dependsOn)].filter((d) => ids.has(d) && d !== t.id);
  enforceDependencies(tasks);
  detectCycle(tasks);
  return tasks;
}

/**
 * Safety net for the dependency graph. A model planner sometimes marks every
 * task independent, which would run tests before the code they test. These
 * rules only ever ADD dependencies, and are reverted if they would create a
 * cycle.
 */
function enforceDependencies(tasks: MissionTask[]) {
  const before = tasks.map((t) => [...t.dependsOn]);
  const text = (t: MissionTask) => `${t.title} ${t.prompt}`;
  const isReview = (t: MissionTask) =>
    /\b(review|verify|audit)\b/i.test(t.title) && (t.readOnly === true || t.agent === "general");
  const isTest = (t: MissionTask) => /\b(tests?|specs?)\b/i.test(text(t));

  const implementation = tasks.filter((t) => !isReview(t) && !isTest(t)).map((t) => t.id);

  for (const t of tasks) {
    if (isReview(t)) {
      // A review must see everything.
      t.dependsOn = [...new Set([...t.dependsOn, ...tasks.filter((o) => o.id !== t.id).map((o) => o.id)])];
    } else if (isTest(t) && !t.dependsOn.some((id) => implementation.includes(id))) {
      // Tests need the implementation to exist — but only if the planner did not
      // already point them at specific modules, which would be more precise.
      t.dependsOn = [...new Set([...t.dependsOn, ...implementation.filter((id) => id !== t.id)])];
    }
  }

  try {
    detectCycle(tasks);
  } catch {
    tasks.forEach((t, i) => {
      t.dependsOn = before[i];
    });
  }
}

function detectCycle(tasks: MissionTask[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): void => {
    const s = state.get(id) ?? 0;
    if (s === 1) throw new Error(`Task dependencies contain a cycle at "${id}"`);
    if (s === 2) return;
    state.set(id, 1);
    for (const d of byId.get(id)?.dependsOn ?? []) visit(d);
    state.set(id, 2);
  };
  for (const t of tasks) visit(t.id);
}

/** Topological "waves": everything in a wave can run in parallel. */
export function taskWaves(tasks: MissionTask[]): MissionTask[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const level = new Map<string, number>();
  const depth = (id: string): number => {
    if (level.has(id)) return level.get(id)!;
    const deps = byId.get(id)?.dependsOn ?? [];
    const v = deps.length ? 1 + Math.max(...deps.map(depth)) : 0;
    level.set(id, v);
    return v;
  };
  for (const t of tasks) depth(t.id);
  const max = tasks.length ? Math.max(...tasks.map((t) => level.get(t.id) ?? 0)) : -1;
  const waves: MissionTask[][] = [];
  for (let i = 0; i <= max; i++) waves.push(tasks.filter((t) => level.get(t.id) === i));
  return waves;
}

/**
 * Ensure every task prompt is a usable work order. Planners often echo the
 * title ("Implement src/wordCount.js"), which tells a worker nothing. This pass
 * rewrites only the prompt text and keeps the validated structure.
 */
const MIN_PROMPT_CHARS = 120;

async function ensureDetailedPrompts(sessionID: string, tasks: MissionTask[]): Promise<MissionTask[]> {
  const thin = tasks.filter((t) => t.prompt.trim().length < MIN_PROMPT_CHARS);
  if (thin.length === 0) return tasks;

  let text: string;
  try {
    text = await promptAndWait(
      sessionID,
      `These task prompts are too thin to act on:\n\n` +
        `${JSON.stringify(thin.map((t) => ({ id: t.id, title: t.title, prompt: t.prompt })), null, 1)}\n\n` +
        `Rewrite EVERY prompt as a complete work order: the exact file path(s) to create or change, the exported API (names and signatures), the key behaviours and edge cases to handle, and a concrete way to verify the result (a command or check). ` +
        `Keep the same ids, titles, agents and dependsOn — change only the prompt text.\n\n` +
        `Reply with ONLY the JSON array of the rewritten tasks (the same set), no prose and no code fences.`,
      "CTO prompt expansion",
    );
  } catch {
    return tasks;
  }

  try {
    const parsed = extractJson(text);
    const raw = Array.isArray(parsed) ? parsed : parsed?.tasks;
    if (!Array.isArray(raw)) return tasks;
    const repaired = normalizeTasks(raw);
    if (repaired.length !== tasks.length || !repaired.every((t) => tasks.some((o) => o.id === t.id))) {
      return tasks;
    }
    // Keep the already-validated structure; take only longer prompt text.
    return tasks.map((t) => {
      const richer = repaired.find((x) => x.id === t.id);
      return richer && richer.prompt.trim().length > t.prompt.trim().length
        ? { ...t, prompt: richer.prompt }
        : t;
    });
  } catch {
    return tasks;
  }
}

/* --------------------------------- lifecycle -------------------------------- */

export function listMissions(): Mission[] {
  return [...missions.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getMission(id: string): Mission | undefined {
  return missions.get(id);
}

export function deleteMission(id: string): boolean {
  const existed = missions.delete(id);
  if (existed) {
    missionEvents.emit("deleted", id);
    persist();
  }
  return existed;
}

export function clearMissions(): number {
  const removed = missions.size;
  missions.clear();
  persist();
  missionEvents.emit("cleared", { removed });
  return removed;
}

export function createMission(input: {
  idea: string;
  targetDirectory: string;
  model?: ModelRef;
}): Mission {
  const idea = String(input.idea ?? "").trim();
  const targetDirectory = String(input.targetDirectory ?? "").trim();
  if (!idea) throw new Error("A mission needs an idea");
  if (!targetDirectory) throw new Error("A mission needs a targetDirectory");
  if (!path.isAbsolute(targetDirectory)) {
    throw new Error(`targetDirectory must be an absolute path, got "${targetDirectory}"`);
  }

  const m: Mission = {
    id: "mis_" + randomUUID().slice(0, 8),
    idea,
    targetDirectory,
    model: input.model,
    status: "planning",
    questions: [],
    answers: {},
    tasks: [],
    notes: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  missions.set(m.id, m);
  emit(m);
  void planMission(m).catch((err) => {
    m.status = "failed";
    m.error = (err as Error).message;
    m.finishedAt = Date.now();
    emit(m);
  });
  return m;
}

const CTO_AGENT = "build"; // the `plan` agent narrates plan-mode prose instead of returning JSON

async function planMission(m: Mission) {
  m.status = "planning";
  m.questions = [];
  m.tasks = [];
  m.error = undefined;
  emit(m);

  const { created } = await ensureDirectory(m.targetDirectory);
  if (created) {
    m.notes.push(`created the target directory ${m.targetDirectory}`);
    emit(m);
  }

  const sessionID = await openSession({
    directory: m.targetDirectory,
    agent: CTO_AGENT,
    model: m.model,
    title: `CTO plan — ${m.id}`,
    readOnly: true,
  });
  m.ctoSessionID = sessionID;

  let text = await promptAndWait(sessionID, buildCtoPrompt(m), "CTO planning");
  let parsed: any;
  try {
    parsed = extractJson(text);
  } catch {
    text = await promptAndWait(
      sessionID,
      "That was not valid JSON. Reply with ONLY the JSON object, no prose and no code fences.",
      "CTO planning (retry)",
    );
    parsed = extractJson(text);
  }

  if (parsed.status === "needs_clarification") {
    const questions = normalizeQuestions(parsed.questions);
    if (questions.length === 0) throw new Error("The CTO asked for clarification but gave no questions");
    m.questions = questions;
    m.status = "awaiting_answers";
  } else {
    const tasks = normalizeTasks(parsed.tasks);
    const reviewed = await reviewDependencies(sessionID, tasks);
    m.tasks = await ensureDetailedPrompts(sessionID, reviewed);
    m.status = "ready";
  }
  emit(m);
}

/**
 * Ask the CTO to re-check its own dependency graph. Planners often mark every
 * task independent, which would run integration code before the modules it
 * needs. One extra planning call is cheap next to executing the graph.
 */
async function reviewDependencies(sessionID: string, tasks: MissionTask[]): Promise<MissionTask[]> {
  if (tasks.length < 4) return tasks;
  const sketch = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    agent: t.agent,
    readOnly: !!t.readOnly,
    dependsOn: t.dependsOn,
  }));
  let text: string;
  try {
    text = await promptAndWait(
      sessionID,
      `Now re-check the dependency graph of the plan you just produced:\n\n${JSON.stringify(sketch, null, 1)}\n\n` +
        `For each task ask: does it need files or output that another task produces? If yes, that task id must be in its "dependsOn". ` +
        `Tasks that are genuinely independent (for example separate self-contained modules, or independent feature files) must keep NO dependency — do not invent edges. ` +
        `In particular, integration/wiring/entry-point tasks must depend on the modules they assemble, and tests must depend on the code they exercise.\n\n` +
        `Reply with ONLY the corrected JSON array of tasks — same ids, same shape, no prose and no code fences.`,
      "CTO dependency review",
    );
  } catch {
    return tasks;
  }

  try {
    const parsed = extractJson(text);
    const raw = Array.isArray(parsed) ? parsed : parsed?.tasks;
    if (!Array.isArray(raw)) return tasks;
    const repaired = normalizeTasks(raw);
    // Only accept a repair that keeps the same task set.
    const sameSet =
      repaired.length === tasks.length && repaired.every((t) => tasks.some((o) => o.id === t.id));
    return sameSet ? repaired : tasks;
  } catch {
    return tasks;
  }
}

export async function answerMission(id: string, answers: Record<string, string>): Promise<Mission> {
  const m = missions.get(id);
  if (!m) throw new Error("Mission not found");
  m.answers = { ...m.answers, ...answers };
  m.questions = [];
  emit(m);
  await planMission(m);
  return m;
}

/** Replace the plan while it is under review, or to fix it after a failure. */
export function updateMissionPlan(id: string, tasks: unknown): Mission {
  const m = missions.get(id);
  if (!m) throw new Error("Mission not found");
  if (m.status !== "ready" && m.status !== "failed") {
    throw new Error(
      `Mission is "${m.status}" — the plan can only be edited while it is "ready" or "failed"`,
    );
  }
  const normalized = normalizeTasks(tasks);
  // Editing after a run must not wipe what already ran: keep each existing
  // task's runtime state and take only its new definition.
  const previous = new Map(m.tasks.map((t) => [t.id, t]));
  m.tasks = normalized.map((t) => {
    const old = previous.get(t.id);
    if (!old) return t;
    return {
      ...old,
      title: t.title,
      agent: t.agent,
      prompt: t.prompt,
      dependsOn: t.dependsOn,
      readOnly: t.readOnly,
    };
  });
  emit(m);
  return m;
}

function planSketch(tasks: MissionTask[]) {
  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    agent: t.agent,
    readOnly: !!t.readOnly,
    dependsOn: t.dependsOn,
    prompt: t.prompt,
  }));
}

const PLAN_RULES = `Keep the same rules as before: layer the work (foundation -> domain -> features -> wiring -> tests -> review), give each task a descriptive title and a complete work order as its prompt (exact files, exported API, behaviours, edge cases, and how to verify), remember that "plan"/"explore"/readOnly tasks cannot write files, and end with one read-only review task that depends on all the others.`;

/**
 * Apply a follow-up instruction from the user: the CTO rewrites the existing
 * plan to match the new spec. The planning session is reused so it keeps the
 * conversation; on failure the previous plan is left untouched.
 */
export async function reviseMissionPlan(id: string, instruction: string): Promise<Mission> {
  const m = missions.get(id);
  if (!m) throw new Error("Mission not found");
  if (m.status !== "ready") {
    throw new Error(`Mission is "${m.status}" — the plan can only be revised while it is "ready"`);
  }
  const request = String(instruction ?? "").trim();
  if (!request) throw new Error("A revision needs an instruction");

  m.status = "planning";
  m.error = undefined;
  emit(m);

  try {
    let sessionID = m.ctoSessionID;
    let prompt =
      `The mission's overall idea (still the goal):\n${m.idea}\n\n` +
      `The user wants to change the plan.\n\nRequested change:\n${request}\n\n` +
      `Rewrite the plan so it still delivers the idea above, adjusted for the requested change. ` +
      `Keep task ids stable for tasks that stay essentially the same; you may add, remove, retitle, re-scope and rewire tasks. ${PLAN_RULES}\n\n` +
      `Reply with ONLY the JSON array of tasks, no prose and no code fences.`;

    if (!sessionID) {
      sessionID = await openSession({
        directory: m.targetDirectory,
        agent: CTO_AGENT,
        model: m.model,
        title: `CTO revise — ${m.id}`,
        readOnly: true,
      });
      m.ctoSessionID = sessionID;
      prompt = `Your current plan:\n${JSON.stringify(planSketch(m.tasks), null, 1)}\n\n${prompt}`;
    }

    let reply = await promptAndWait(sessionID, prompt, "CTO revision");
    let parsed: any;
    try {
      parsed = extractJson(reply);
    } catch {
      reply = await promptAndWait(
        sessionID,
        "That was not valid JSON. Reply with ONLY the JSON array of tasks, nothing else.",
        "CTO revision (retry)",
      );
      parsed = extractJson(reply);
    }

    const raw = Array.isArray(parsed) ? parsed : parsed?.tasks;
    if (!Array.isArray(raw)) throw new Error("The CTO did not return a task list");

    const tasks = normalizeTasks(raw);
    const reviewed = await reviewDependencies(sessionID, tasks);
    m.tasks = await ensureDetailedPrompts(sessionID, reviewed);
    m.revisions = [...(m.revisions ?? []), request];
  } catch (err) {
    m.error = `Revision failed: ${(err as Error).message}`;
  }

  m.status = "ready";
  emit(m);
  return m;
}

/* --------------------------------- execution -------------------------------- */

export function startMission(id: string): Mission {
  const m = missions.get(id);
  if (!m) throw new Error("Mission not found");
  if (m.status !== "ready") {
    throw new Error(`Mission is "${m.status}" — it must be "ready" to run. Use retry to resume a failed mission.`);
  }
  for (const t of m.tasks) resetTask(t);
  m.error = undefined;
  m.finishedAt = undefined;
  m.status = "running";
  emit(m);
  void execute(m).catch((err) => {
    m.status = "failed";
    m.error = (err as Error).message;
    m.finishedAt = Date.now();
    emit(m);
  });
  return m;
}

/** Clear a task's runtime state so it can run again. */
function resetTask(t: MissionTask) {
  t.status = "pending";
  t.output = undefined;
  t.error = undefined;
  t.integration = undefined;
  t.worktree = undefined;
  t.branch = undefined;
  t.sessionID = undefined;
  t.startedAt = undefined;
  t.finishedAt = undefined;
}

/**
 * Resume a failed mission without redoing work that already succeeded.
 * With `taskId`, retry just that task; otherwise retry every task that did not
 * succeed. Tasks skipped because a dependency failed are queued again too.
 */
export function retryMission(id: string, taskId?: string): Mission {
  const m = missions.get(id);
  if (!m) throw new Error("Mission not found");
  if (m.status !== "failed") {
    throw new Error(`Mission is "${m.status}" — only a failed mission can be retried`);
  }

  let targets: MissionTask[];
  if (taskId) {
    const target = m.tasks.find((t) => t.id === taskId);
    if (!target) throw new Error(`No task "${taskId}"`);
    if (target.status === "succeeded") throw new Error(`Task "${taskId}" already succeeded`);
    targets = [target];
  } else {
    targets = m.tasks.filter((t) => t.status !== "succeeded");
    if (targets.length === 0) throw new Error("Nothing to retry — every task already succeeded");
  }

  for (const t of targets) {
    if (t.branch || t.worktree) {
      m.notes.push(`retry: discarding the previous attempt of ${t.id}${t.branch ? ` (branch ${t.branch})` : ""}`);
    }
    resetTask(t);
  }
  // Skipped tasks are only blocked by a failed dependency; queue them again and
  // let the scheduler re-skip any that are still blocked.
  for (const t of m.tasks) if (t.status === "skipped") resetTask(t);

  m.error = undefined;
  m.finishedAt = undefined;
  m.status = "running";
  emit(m);
  void execute(m).catch((err) => {
    m.status = "failed";
    m.error = (err as Error).message;
    m.finishedAt = Date.now();
    emit(m);
  });
  return m;
}

function buildTaskPrompt(m: Mission, task: MissionTask, worktree: string): string {
  // Workers must stay inside their own worktree. Rewrite any canonical path the
  // CTO baked into the task text so absolute references resolve in the sandbox.
  const sandbox = (s: string) => s.split(m.targetDirectory).join(worktree);
  const deps = task.dependsOn
    .map((d) => m.tasks.find((t) => t.id === d))
    .filter(Boolean) as MissionTask[];
  const upstream = deps.length
    ? "\n\nWork already completed by upstream tasks (already merged into your working copy):\n" +
      deps.map((d) => `- ${d.id} (${d.title}):\n${sandbox((d.output ?? "").slice(0, 1200))}`).join("\n\n")
    : "";
  return `You are one worker on an autonomous engineering team. Do exactly the task below.

Your working directory (the repository root) is:
${worktree}

Use relative paths. Read and write ONLY inside that directory — never anywhere else.

Overall idea:
${sandbox(m.idea)}

Your task ${task.id}: ${task.title}

${sandbox(task.prompt)}${upstream}

When finished, give a concise summary of what you changed and why. Make sensible decisions without asking questions.`;
}

async function execute(m: Mission) {
  const prep = await ensureRepo(m.targetDirectory);
  m.notes.push(...prep.notes);
  const base = prep.baseBranch;
  const byId = (id: string) => m.tasks.find((t) => t.id === id);
  emit(m);

  const active = new Map<string, Promise<void>>();

  for (;;) {
    for (const t of m.tasks) {
      if (t.status === "pending" && t.dependsOn.some((d) => ["failed", "skipped"].includes(byId(d)?.status ?? ""))) {
        t.status = "skipped";
        t.error = "skipped: a dependency did not succeed";
        emit(m);
      }
    }

    const ready = m.tasks.filter(
      (t) => t.status === "pending" && t.dependsOn.every((d) => byId(d)?.status === "succeeded"),
    );
    const slots = Math.max(0, MAX_PARALLEL - active.size);
    for (const t of ready.slice(0, slots)) {
      const p = runTask(m, t, base).finally(() => active.delete(t.id));
      active.set(t.id, p);
    }

    if (active.size === 0) break;
    await Promise.race(active.values());
  }

  const failed = m.tasks.some((t) => t.status === "failed" || t.status === "skipped");
  m.status = failed ? "failed" : "succeeded";
  m.finishedAt = Date.now();
  emit(m);
}

async function runTask(m: Mission, task: MissionTask, base: string) {
  task.status = "running";
  task.startedAt = Date.now();
  emit(m);

  const branch = `orchestra/${m.id}/${task.id}`;
  const worktree = path.join(WORKTREE_ROOT, m.id, task.id);
  const readOnly = task.readOnly || READ_ONLY_AGENTS.has(task.agent);

  try {
    // A retry must not inherit the previous attempt's worktree or branch.
    await removeWorktree(m.targetDirectory, worktree);
    await deleteBranch(m.targetDirectory, branch);
    await createWorktree(m.targetDirectory, worktree, branch, base);
    task.worktree = worktree;
    task.branch = branch;

    const { text, sessionID } = await askOnce({
      directory: worktree,
      agent: task.agent,
      model: m.model,
      prompt: buildTaskPrompt(m, task, worktree),
      title: `${task.title} — ${m.id}/${task.id}`,
      readOnly,
      timeoutLabel: `Task ${task.id}`,
    });
    task.sessionID = sessionID;
    task.output = text;

    const committed = await commitWorktree(worktree, `orchestra(${task.id}): ${task.title}`);
    if (!committed) {
      task.integration = "no-changes";
      task.status = "succeeded";
      await removeWorktree(m.targetDirectory, worktree);
      await deleteBranch(m.targetDirectory, branch);
      return;
    }

    const res = await mergeBranch(m.targetDirectory, branch, `orchestra: merge ${task.id} — ${task.title}`);
    if (res.merged) {
      task.integration = "merged";
      task.status = "succeeded";
      await removeWorktree(m.targetDirectory, worktree);
      await deleteBranch(m.targetDirectory, branch);
    } else {
      task.integration = "conflict";
      task.status = "failed";
      task.error = res.detail;
      m.notes.push(`task ${task.id}: could not merge ${branch} (${res.detail}); branch kept for manual merge`);
    }
  } catch (err) {
    task.status = "failed";
    task.error = (err as Error).message;
    // Nothing was committed, so leave no worktree or branch behind.
    await removeWorktree(m.targetDirectory, worktree);
    await deleteBranch(m.targetDirectory, branch);
  } finally {
    task.finishedAt = Date.now();
    emit(m);
  }
}

# 🎼 Orchestra

Autonomous engineering on top of **OpenCode**, with a live web dashboard.

You give a high-level **idea**. A **CTO** agent asks clarifying questions if
anything is unclear (offering answer options where it makes sense), then splits
the work into a **task graph** — tasks that can run in parallel, and tasks that
must wait for others. **Worker** agents execute the graph in isolated git
worktrees, and everything is merged back automatically.

```
idea ──▶ CTO ──questions + options?──▶ you ──▶ CTO ──▶ task DAG ──▶ workers (parallel + dependent) ──▶ merged
```

## Quickstart

```sh
npm install
npm run dev        # server on :8787, dashboard on http://localhost:5173
```

Open <http://localhost:5173>. The dashboard has two screens:

- **Missions** — the list of missions and the selected mission's detail.
- **New mission** — a dedicated screen for entering an idea and a target directory.

The server discovers the local OpenCode background service automatically
(starting it if needed) and talks to its HTTP API over authenticated fetch.

## How a mission runs

1. **Plan.** The CTO (a read-only `build` session in the target directory)
   replies with JSON: either `{"status":"needs_clarification","questions":[...]}`
   or `{"status":"ready","tasks":[...]}`. It only asks when something material is
   genuinely ambiguous, and never guesses on things you care about.
2. **Answer.** Questions appear in the dashboard. Questions with a small set of
   sensible answers come with **options** the CTO offers, shown as clickable
   choices; you can always type your own answer instead. Your answers are fed
   back and the CTO re-plans until it is ready.
3. **Review the plan.** Two screens:
   - **Plan summary** — a compact, scannable list grouped by wave: task id,
     title, agent, read-only flag, and what it waits for. No prompts. From here
     you **Execute mission**, **Add task**, **Save changes**, or **Reset**.
   - **Task detail** — click any task to open its own screen and edit its title,
     agent, read-only flag, `dependsOn`, and prompt.

   The summary updates live as you rewire dependencies; a cycle is flagged and
   blocks execution. **Execute mission** saves first if you have unsaved edits.
4. **Ask the CTO to revise.** Still on the summary screen, type a follow-up
   instruction ("use Postgres instead of SQLite", "add rate limiting to the auth
   routes", "split the biggest task") and press **Revise plan**. The CTO rewrites
   the existing plan to match — it keeps the ids of tasks that stay the same, and
   may add, remove, retitle, re-scope and rewire tasks. The mission's original
   idea is re-sent each time so the plan stays on goal, and the CTO's session is
   reused so it keeps the conversation. Applied instructions are listed under the
   box. If a revision fails, the previous plan is left untouched.
5. **Execute.** Tasks are scheduled in **waves**:
   - tasks in the same wave have no dependency between them and run **in
     parallel** (up to `ORCHESTRA_MAX_PARALLEL`, default 3);
   - a task with `dependsOn` waits until those tasks have finished *and been
     merged*, so it sees their changes.
6. **Isolate & merge.** Each task runs in its own **git worktree** on a branch
   `orchestra/<mission>/<task>`. On success the branch is committed and merged
   into your base branch, then the worktree is removed. Merge conflicts are
   reported and the branch is kept for you to resolve by hand.
7. **Retry what failed.** A failed mission is not a dead end:
   - **Resume mission** re-runs every task that did not succeed, and leaves
     succeeded ones completely alone (they are not re-run or re-merged).
   - **Retry** on an individual failed or skipped task re-runs just that task;
     tasks skipped because of it are queued again automatically.
   - **Edit plan** works while a mission is `failed`, so you can fix the prompt
     that caused the failure before retrying. Runtime state (status, output,
     session) of tasks that already ran is preserved.

   A retry discards the previous attempt's worktree and branch and records a note
   saying so. Retrying a task that already succeeded is refused, and a failed
   mission must be resumed with **retry** rather than run again from scratch.

If the target directory does not exist, Orchestra creates it (like `mkdir -p`)
and notes that in the mission. A relative path is rejected with a clear error.
If the target is not a git repo, Orchestra runs `git init` and creates an initial
commit (empty if the directory is empty) so worktrees have a base. If your
working tree has uncommitted changes, they are saved as a checkpoint commit
first — nothing is lost.

Read-only tasks (`agent` `plan`/`explore`, or `readOnly: true`) run with
file-write permissions denied and cannot modify anything.

### How the plan is shaped

- **Scale follows complexity.** The CTO plans 3–5 tasks for a trivial change and
  8–15 for a substantial system, decomposed by *layer* (foundation → domain →
  features → wiring → tests → review) rather than by topic.
- **Self-critique pass.** After producing the graph, the CTO re-reads its own
  `dependsOn` edges and corrects missing ones — without inventing dependencies
  between genuinely independent tasks.
- **Prompt expansion pass.** Any task whose prompt is a one-liner (under 120
  characters, e.g. "Implement src/wordCount.js") is rewritten into a complete
  work order: exact file path(s), the exported API with signatures, behaviours
  and edge cases, worked examples, and a concrete verification command. Only the
  prompt text changes; the validated graph is kept.
- **Safety net.** A deterministic pass then guarantees a review task depends on
  everything, and that test tasks depend on the implementation (unless the
  planner already pointed them at specific modules). It only ever adds edges,
  and is reverted if it would create a cycle.

The result, verified on three shapes of work:

| Task shape | Plan |
| --- | --- |
| Trivial (`add a --version flag`) | 4 tasks, 4 sequential waves |
| Genuinely parallel (6 independent modules + tests) | 14 tasks, 2 wide parallel waves + review |
| Hard (REST API: SQLite, JWT auth, validation, routes, tests) | 16 tasks, 9 layered waves |

Task titles are descriptive ("Implement wordCount() counting whitespace-separated
words", not "Implement src/wordCount.js"), and task prompts average ~1,200
characters of concrete instructions.

Mission history is saved to `missions.json` and reloaded on restart; a mission
that was mid-flight when the server stopped is marked as interrupted.

## Agents

| Agent     | Use for                                          |
| --------- | ------------------------------------------------ |
| `plan`    | read-only analysis and planning                  |
| `build`   | writing and editing files                        |
| `general` | research and review                              |
| `explore` | read-only codebase search                        |

Note: the `plan` agent narrates plan-mode prose and will not return strict JSON,
so the CTO runs on `build` with writes denied.

## HTTP API

| Method | Path                        | Purpose                                    |
| ------ | --------------------------- | ------------------------------------------ |
| GET    | `/api/health`               | OpenCode service version/status            |
| GET    | `/api/agents`               | available agents                           |
| GET    | `/api/missions`             | list missions (with computed waves)        |
| POST   | `/api/missions`             | create `{ idea, targetDirectory, model }`  |
| GET    | `/api/missions/:id`         | one mission                                |
| POST   | `/api/missions/:id/answers` | submit `{ answers }`, re-plan              |
| PUT    | `/api/missions/:id/plan`    | replace `{ tasks }` while the plan is under review |
| POST   | `/api/missions/:id/revise`  | ask the CTO to rewrite the plan for `{ instruction }` |
| POST   | `/api/missions/:id/run`     | execute the DAG                            |
| POST   | `/api/missions/:id/retry`   | resume `{ taskId? }` — one task, or all that did not succeed |
| DELETE | `/api/missions/:id`         | delete one mission                         |
| DELETE | `/api/missions`             | delete every mission                       |
| GET    | `/api/events`               | SSE: `snapshot`, `mission`                 |

## Layout

```
server/     Node + Express + TypeScript.
  src/missions.ts   CTO planning + DAG executor + worktree integration
  src/git.ts        git repo prep, worktrees, commits, merges
  src/opencode.ts   service discovery + authenticated API fetch
  src/util.ts       target-directory handling
  src/index.ts      routes + SSE
web/        Vite + React + TypeScript dashboard.
  src/App.tsx                    screens, mission list, live updates
  src/components/NewMission.tsx  the create screen
  src/components/MissionView.tsx questions/options, waves, task cards
  src/components/PlanReview.tsx  review container, switches screens
  src/components/PlanSummary.tsx compact plan summary by wave
  src/components/TaskDetail.tsx  one task's full detail
  src/components/Markdown.tsx    renders agent output as markdown
  src/waves.ts                   client-side wave computation
```

Agent output is rendered as markdown (GFM tables, code blocks, lists); raw HTML
in model output is escaped, not executed.

## Configuration

| Variable                    | Default                              | Meaning                    |
| --------------------------- | ------------------------------------ | -------------------------- |
| `PORT`                      | `8787`                               | server port                |
| `ORCHESTRA_MAX_PARALLEL`    | `3`                                  | concurrent workers         |
| `ORCHESTRA_TASK_TIMEOUT_MS` | `1200000`                            | per-task timeout           |
| `ORCHESTRA_WORKTREE_DIR`    | `/tmp/opencode/orchestra-worktrees`  | where worktrees are created |
| `ORCHESTRA_MISSIONS_FILE`   | `./missions.json`                    | mission history            |

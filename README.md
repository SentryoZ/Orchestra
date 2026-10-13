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

   Workers often commit their own changes. A task counts as having produced work
   when its **branch is ahead of the base**, not merely when its working tree is
   dirty — otherwise an agent that commits would be recorded as `no-changes` and
   its commits discarded. A task that fails keeps its branch (with a note) if it
   had already committed anything, rather than throwing the commits away.
7. **Review → fix → re-review.** The final review task (the terminal read-only
   task that nothing depends on) is asked to return a machine-readable verdict:

   ```json
   {"status":"fail","checks":[{"name":"npm test","result":"fail","evidence":"3 of 12 failing"}],
    "failures":[{"summary":"slugify drops accents","files":["src/slugify.js"],
                 "suggestedFix":"normalise to NFD first","severity":"blocker"}]}
   ```

   Orchestra appends this contract to the review prompt itself, and the reviewer
   is told to **run** the tests/build and paste the real command output as
   evidence rather than judging by reading. If the verdict is `fail`, every
   `blocker`/`major` failure becomes a **fix task** (`fix1-1`, `fix1-2`, …) with
   the summary, files and suggested fix. The fix tasks run in their own
   worktrees, then the **same review task is queued again** — its dependencies
   now include the fixes — and the loop repeats up to `ORCHESTRA_REVIEW_ROUNDS`
   times (default 2, at most `ORCHESTRA_MAX_FIXES_PER_ROUND` fixes per round).

   Outcomes: the review passing ends the loop; a verdict that cannot be parsed
   (`unknown`) is surfaced instead of guessed at; a fix task that fails stops the
   loop; and if the review still reports failures when the rounds run out, the
   mission is marked `failed` with
   `the final review still reports failures after N fix round(s)` — it built, but
   it is not verified.
8. **Retry what failed.** A failed mission is not a dead end:
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

Mission history is saved to `missions.json` and reloaded on restart. A mission
that was mid-flight when the server stopped cannot be resumed, so it is marked
`failed` with `interrupted by a server restart`; any task that was still running
is marked failed the same way, so nothing is left showing as `running` forever.
That correction is written back to `missions.json`, so the file and the running
server never disagree. Use **Resume mission** to carry on from there.

### Waiting for an agent

Orchestra polls a session's newest messages to detect the end of a turn rather
than holding one long HTTP request open. This matters: Node's `fetch` (undici)
aborts any request whose response headers do not arrive within **300 seconds**, so
a single long-lived "wait" call made any task running longer than five minutes
fail with an opaque `fetch failed` — while the agent was still working and often
went on to succeed. Short polls cannot trip that timer.

Completion is detected from the turn-specific `idle` message (created after the
prompt time), not from `session.outcome`, which is stale across turns. A few
consecutive poll failures are tolerated before giving up, and errors are reported
with their underlying cause, so a failure reads
`fetch failed — HeadersTimeoutError: Headers Timeout Error (UND_ERR_HEADERS_TIMEOUT)`
instead of just `fetch failed`. A task's session id is recorded before it starts
waiting, so a failed task can still be traced to its session.

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
| `ORCHESTRA_IDLE_POLL_MS`    | `1500`                               | how often a running turn is polled |
| `ORCHESTRA_IDLE_POLL_RETRIES` | `8`                                | tolerated consecutive poll failures |
| `ORCHESTRA_REVIEW_ROUNDS`   | `2`                                  | max fix rounds after a failed review |
| `ORCHESTRA_MAX_FIXES_PER_ROUND` | `5`                              | fix tasks spawned per failed review |
| `ORCHESTRA_WORKTREE_DIR`    | `/tmp/opencode/orchestra-worktrees`  | where worktrees are created |
| `ORCHESTRA_MISSIONS_FILE`   | `./missions.json`                    | mission history            |

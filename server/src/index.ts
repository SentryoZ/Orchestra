import express from "express";
import cors from "cors";
import { listAgents, serverInfo } from "./opencode.js";
import { describeError } from "./opencode.js";
import {
  answerMission,
  clearMissions,
  createMission,
  deleteMission,
  getMission,
  listMissions,
  missionEvents,
  retryMission,
  reviseMissionPlan,
  startMission,
  taskWaves,
  updateMissionPlan,
} from "./missions.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const ok = <T>(res: express.Response, data: T) => res.json({ data });
const fail = (res: express.Response, status: number, message: string) =>
  res.status(status).json({ error: message });

const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) => {
    fn(req, res).catch((err) => fail(res, 400, describeError(err)));
  };

const withWaves = (m: ReturnType<typeof getMission>) =>
  m ? { ...m, waves: taskWaves(m.tasks).map((w) => w.map((t) => t.id)) } : m;

app.get("/api/health", wrap(async (_req, res) => ok(res, await serverInfo())));
app.get("/api/agents", wrap(async (_req, res) => ok(res, await listAgents())));

app.get("/api/missions", wrap(async (_req, res) => ok(res, listMissions().map(withWaves))));
app.get(
  "/api/missions/:id",
  wrap(async (req, res) => {
    const m = getMission(req.params.id);
    return m ? ok(res, withWaves(m)) : fail(res, 404, "Mission not found");
  }),
);
app.post(
  "/api/missions",
  wrap(async (req, res) => {
    const m = createMission({
      idea: req.body?.idea,
      targetDirectory: req.body?.targetDirectory,
      model: req.body?.model,
    });
    return res.status(201).json({ data: withWaves(m) });
  }),
);
app.post(
  "/api/missions/:id/answers",
  wrap(async (req, res) =>
    ok(res, withWaves(await answerMission(req.params.id, req.body?.answers ?? {}))),
  ),
);
app.delete(
  "/api/missions",
  wrap(async (_req, res) => ok(res, { removed: clearMissions() })),
);
app.delete(
  "/api/missions/:id",
  wrap(async (req, res) => {
    const removed = deleteMission(req.params.id);
    return removed ? ok(res, { removed: req.params.id }) : fail(res, 404, "Mission not found");
  }),
);
app.put(
  "/api/missions/:id/plan",
  wrap(async (req, res) => ok(res, withWaves(updateMissionPlan(req.params.id, req.body?.tasks)))),
);
app.post(
  "/api/missions/:id/revise",
  wrap(async (req, res) =>
    ok(res, withWaves(await reviseMissionPlan(req.params.id, req.body?.instruction))),
  ),
);
app.post(
  "/api/missions/:id/run",
  wrap(async (req, res) => res.status(202).json({ data: withWaves(startMission(req.params.id)) })),
);
app.post(
  "/api/missions/:id/retry",
  wrap(async (req, res) =>
    res.status(202).json({ data: withWaves(retryMission(req.params.id, req.body?.taskId)) }),
  ),
);

/** Server-sent events: live mission updates. */
app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: string, payload: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);

  send("snapshot", { missions: listMissions().map(withWaves) });

  const onMission = (m: unknown) => send("mission", withWaves(m as ReturnType<typeof getMission>));
  const onDeleted = (id: unknown) => send("mission-deleted", id);
  const onCleared = (info: unknown) => send("cleared", info);
  missionEvents.on("mission", onMission);
  missionEvents.on("deleted", onDeleted);
  missionEvents.on("cleared", onCleared);

  const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    missionEvents.off("mission", onMission);
    missionEvents.off("deleted", onDeleted);
    missionEvents.off("cleared", onCleared);
  });
});

const PORT = Number(process.env.PORT ?? 8787);
app.listen(PORT, async () => {
  console.log(`Orchestra server on http://localhost:${PORT}`);
  try {
    const info = await serverInfo();
    console.log(`Connected to OpenCode ${info.version} at ${info.urls.join(", ")}`);
  } catch (err) {
    console.error("Could not reach OpenCode:", (err as Error).message);
  }
});

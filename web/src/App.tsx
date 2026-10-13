import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import MissionView from "./components/MissionView";
import NewMission from "./components/NewMission";
import type { Agent, Mission, MissionTask } from "./types";

type Tab = "missions" | "new";

const DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash";

export default function App() {
  const [tab, setTab] = useState<Tab>("missions");
  const [missions, setMissions] = useState<Mission[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [version, setVersion] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [selectedMission, setSelectedMission] = useState<string | null>(null);
  const [idea, setIdea] = useState("");
  const [directory, setDirectory] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  /** Single source of truth for adding/replacing a mission — keeps list entries unique. */
  const upsertMission = useCallback((m: Mission) => {
    setMissions((prev) => {
      const next = prev.filter((x) => x.id !== m.id);
      return [m, ...next].sort((a, b) => b.createdAt - a.createdAt);
    });
  }, []);

  useEffect(() => {
    api.health().then((h) => setVersion(h.version)).catch((e) => setError(e.message));
    api.agents().then(setAgents).catch(() => {});
    api.missions().then(setMissions).catch(() => {});
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("snapshot", (ev) => {
      setMissions(JSON.parse((ev as MessageEvent).data).missions ?? []);
    });
    es.addEventListener("mission", (ev) => {
      upsertMission(JSON.parse((ev as MessageEvent).data) as Mission);
    });
    es.addEventListener("mission-deleted", (ev) => {
      const id = JSON.parse((ev as MessageEvent).data) as string;
      setMissions((prev) => prev.filter((m) => m.id !== id));
      setSelectedMission((cur) => (cur === id ? null : cur));
    });
    es.addEventListener("cleared", () => {
      setMissions([]);
      setSelectedMission(null);
      setAnswers({});
    });
    return () => es.close();
  }, [upsertMission]);

  const mission = useMemo(
    () => missions.find((m) => m.id === selectedMission) ?? null,
    [missions, selectedMission],
  );

  function parseModel(s: string) {
    const [providerID, ...rest] = s.split("/");
    const id = rest.join("/");
    return id ? { providerID, id } : undefined;
  }

  async function createMission() {
    setBusy(true);
    setError(null);
    try {
      const m = await api.createMission(idea, directory, parseModel(model));
      upsertMission(m);
      setSelectedMission(m.id);
      setAnswers({});
      setIdea("");
      setTab("missions");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitAnswers() {
    if (!mission) return;
    setBusy(true);
    setError(null);
    try {
      upsertMission(await api.answerMission(mission.id, answers));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function executeMission() {
    if (!mission) return;
    setBusy(true);
    setError(null);
    try {
      upsertMission(await api.runMission(mission.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resumeMission() {
    if (!mission) return;
    setBusy(true);
    setError(null);
    try {
      upsertMission(await api.retryMission(mission.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function retryTask(taskId: string) {
    if (!mission) return;
    setBusy(true);
    setError(null);
    try {
      upsertMission(await api.retryMission(mission.id, taskId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function savePlan(tasks: MissionTask[]): Promise<Mission> {
    if (!mission) throw new Error("No mission selected");
    const updated = await api.updatePlan(mission.id, tasks);
    upsertMission(updated);
    return updated;
  }

  async function revisePlan(instruction: string): Promise<boolean> {
    if (!mission) return false;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.revisePlan(mission.id, instruction);
      upsertMission(updated);
      return !updated.error;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openMission(id: string) {
    setSelectedMission(id);
    setAnswers({});
    setTab("missions");
  }

  async function deleteMission(id: string) {
    setError(null);
    try {
      await api.deleteMission(id);
      setMissions((prev) => prev.filter((m) => m.id !== id));
      setSelectedMission((cur) => (cur === id ? null : cur));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function clearAllMissions() {
    if (!confirm(`Delete all ${missions.length} missions? This cannot be undone.`)) return;
    setError(null);
    try {
      await api.clearMissions();
      setMissions([]);
      setSelectedMission(null);
      setAnswers({});
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="app">
      <header>
        <h1>🎼 Orchestra</h1>
        <nav className="tabs">
          <button className={tab === "missions" ? "tab active" : "tab"} onClick={() => setTab("missions")}>
            Missions
          </button>
          <button className={tab === "new" ? "tab active" : "tab"} onClick={() => setTab("new")}>
            New mission
          </button>
        </nav>
        <div className="spacer" />
        <span className={`pill ${connected ? "on" : "off"}`}>{connected ? "live" : "disconnected"}</span>
        <span className="pill on">{version ? `opencode ${version}` : "no service"}</span>
      </header>

      <div className="layout">
        <div className="sidebar">
          <div className="section-title">
            Missions
            <span className="row" style={{ gap: 6 }}>
              {missions.length > 0 && (
                <button className="danger" onClick={clearAllMissions}>
                  Clear all
                </button>
              )}
              <button onClick={() => setTab("new")}>+ New</button>
            </span>
          </div>
          {missions.length === 0 && <div className="list-item muted">No missions yet.</div>}
          {missions.map((m) => (
            <div
              key={m.id}
              className={`list-item ${tab === "missions" && m.id === selectedMission ? "active" : ""}`}
              onClick={() => openMission(m.id)}
            >
              <div className="name row">
                {m.id}
                <span className={`badge ${m.status} right`}>{m.status}</span>
              </div>
              <div className="sub">{m.idea}</div>
            </div>
          ))}
        </div>

        <div className="main">
          {error && (
            <div className="card">
              <div className="error">{error}</div>
            </div>
          )}

          {tab === "new" && (
            <NewMission
              idea={idea}
              directory={directory}
              model={model}
              agents={agents}
              busy={busy}
              error={null}
              onIdea={setIdea}
              onDirectory={setDirectory}
              onModel={setModel}
              onCreate={createMission}
              onCancel={() => setTab("missions")}
            />
          )}

          {tab === "missions" && mission && (
            <MissionView
              key={mission.id}
              mission={mission}
              agents={agents}
              answers={answers}
              onAnswer={(id, v) => setAnswers((prev) => ({ ...prev, [id]: v }))}
              onSubmitAnswers={submitAnswers}
              onSavePlan={savePlan}
              onRevisePlan={revisePlan}
              onDelete={() => deleteMission(mission.id)}
              onResume={resumeMission}
              onRetryTask={retryTask}
              onRun={executeMission}
              busy={busy}
            />
          )}

          {tab === "missions" && !mission && (
            <div className="empty">
              No mission selected. Pick one from the list, or start a{" "}
              <a href="#" onClick={(e) => { e.preventDefault(); setTab("new"); }}>
                new mission
              </a>
              .
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

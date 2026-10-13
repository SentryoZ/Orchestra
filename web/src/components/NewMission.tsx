import type { Agent } from "../types";

interface Props {
  idea: string;
  directory: string;
  model: string;
  agents: Agent[];
  busy: boolean;
  error?: string | null;
  onIdea: (v: string) => void;
  onDirectory: (v: string) => void;
  onModel: (v: string) => void;
  onCreate: () => void;
  onCancel: () => void;
}

export default function NewMission({
  idea,
  directory,
  model,
  agents,
  busy,
  error,
  onIdea,
  onDirectory,
  onModel,
  onCreate,
  onCancel,
}: Props) {
  const ready = idea.trim().length > 0 && directory.trim().length > 0 && !busy;

  return (
    <div className="card">
      <h2>New mission</h2>
      <p className="desc">
        Describe the idea. A CTO agent will ask clarifying questions, then split it into a task graph that
        workers run in parallel where it is safe.
      </p>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      <label htmlFor="idea">Idea</label>
      <textarea
        id="idea"
        rows={5}
        placeholder="e.g. Build a small CLI that manages a todo list, with tests."
        value={idea}
        onChange={(e) => onIdea(e.target.value)}
      />

      <label htmlFor="dir">Target directory</label>
      <input
        id="dir"
        placeholder="/absolute/path/to/project"
        value={directory}
        onChange={(e) => onDirectory(e.target.value)}
      />
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        Must be an absolute path. Created automatically if it does not exist; a git repo is initialised if
        needed.
      </div>

      <label htmlFor="model">Model (providerID/modelID)</label>
      <input id="model" value={model} onChange={(e) => onModel(e.target.value)} />

      <div className="row" style={{ marginTop: 16 }}>
        <button className="primary" onClick={onCreate} disabled={!ready}>
          {busy ? "Starting…" : "Start planning"}
        </button>
        <button onClick={onCancel}>Cancel</button>
        <span className="muted right">Agents: {agents.map((a) => a.id).join(", ")}</span>
      </div>
    </div>
  );
}

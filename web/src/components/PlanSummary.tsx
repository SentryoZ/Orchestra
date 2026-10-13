import { useState } from "react";
import type { MissionTask } from "../types";

interface Props {
  tasks: MissionTask[];
  waves: string[][];
  cyclic: boolean;
  dirty: boolean;
  saving: boolean;
  busy: boolean;
  error: string | null;
  revisions: string[];
  onExecute: () => void;
  onSave: () => void;
  onReset: () => void;
  onAdd: () => void;
  onOpen: (id: string) => void;
  onRevise: (instruction: string) => Promise<boolean>;
  runLabel?: string;
}

export default function PlanSummary({
  tasks,
  waves,
  cyclic,
  dirty,
  saving,
  busy,
  error,
  revisions,
  onExecute,
  onSave,
  onReset,
  onAdd,
  onOpen,
  onRevise,
  runLabel,
}: Props) {
  const [instruction, setInstruction] = useState("");
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const maxParallel = waves.length ? Math.max(...waves.map((w) => w.length)) : 0;

  const row = (id: string) => {
    const t = byId.get(id);
    if (!t) return null;
    return (
      <div className="task-row" key={id} onClick={() => onOpen(id)}>
        <span className="idx">{t.id}</span>
        <span className="name">{t.title || "(untitled)"}</span>
        <span className="tag">{t.agent}</span>
        {t.readOnly && <span className="tag">read-only</span>}
        {t.dependsOn.length > 0 ? (
          <span className="dep-badge" title={`waits for ${t.dependsOn.join(", ")}`}>
            ⤷ {t.dependsOn.length}
            <span className="tip">waits for {t.dependsOn.join(", ")}</span>
          </span>
        ) : (
          <span className="muted" style={{ fontSize: 11 }}>
            —
          </span>
        )}
        <span className="chev">›</span>
      </div>
    );
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <strong>Plan summary</strong>
        <span className="muted">
          {tasks.length} tasks · {cyclic ? "cycle!" : `${waves.length} waves`} · up to {maxParallel} in parallel
        </span>
      </div>

      <div className="revision-box">
        <div className="label" style={{ marginTop: 0 }}>
          Ask the CTO to revise the plan
        </div>
        <textarea
          rows={3}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="e.g. Use Postgres instead of SQLite, and add rate limiting to the auth routes."
        />
        <div className="row" style={{ marginTop: 8 }}>
          <button
            onClick={async () => {
              const changed = await onRevise(instruction);
              if (changed) setInstruction("");
            }}
            disabled={!instruction.trim() || busy || saving || cyclic}
          >
            {busy ? "Revising…" : "Revise plan"}
          </button>
          <span className="muted">
            {revisions.length
              ? `${revisions.length} revision${revisions.length > 1 ? "s" : ""} applied.`
              : "The CTO rewrites the plan to match your instruction."}
          </span>
        </div>
        {revisions.length > 0 && (
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {revisions.map((r, i) => (
              <div key={i}>• {r}</div>
            ))}
          </div>
        )}
      </div>

      {error && <div className="error" style={{ marginBottom: 10 }}>{error}</div>}
      {cyclic && (
        <div className="error" style={{ marginBottom: 10 }}>
          Dependency cycle detected — some task waits on itself, directly or indirectly.
        </div>
      )}

      <div className="row" style={{ marginBottom: 14 }}>
        <button className="primary" onClick={onExecute} disabled={busy || saving || cyclic}>
          {runLabel ?? "▶ Execute mission"}
        </button>
        <button onClick={onSave} disabled={!dirty || saving || cyclic}>
          {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
        <button onClick={onAdd}>+ Add task</button>
        <button onClick={onReset} disabled={!dirty}>
          Reset
        </button>
      </div>

      {cyclic ? (
        <div>{tasks.map((t) => row(t.id))}</div>
      ) : (
        waves.map((wave, i) => (
          <div key={i} style={{ marginBottom: 12 }}>
            <div className="label">
              Wave {i + 1} {wave.length > 1 ? `— ${wave.length} parallel` : "— sequential"}
            </div>
            {wave.map((id) => row(id))}
          </div>
        ))
      )}

      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Click any task to open its details.
      </div>
    </div>
  );
}

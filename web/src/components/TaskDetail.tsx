import type { Agent, MissionTask } from "../types";

interface Props {
  task: MissionTask;
  tasks: MissionTask[];
  agents: Agent[];
  onChange: (patch: Partial<MissionTask>) => void;
  onToggleDep: (dep: string) => void;
  onRemove: () => void;
  onBack: () => void;
}

export default function TaskDetail({ task, tasks, agents, onChange, onToggleDep, onRemove, onBack }: Props) {
  const agentIds = agents.length ? agents.map((a) => a.id) : [task.agent];
  if (!agentIds.includes(task.agent)) agentIds.push(task.agent);

  return (
    <div style={{ marginTop: 16 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <button onClick={onBack}>← Plan summary</button>
        <span className="tag">{task.id}</span>
      </div>

      <label htmlFor="task-title">Title</label>
      <input
        id="task-title"
        value={task.title}
        onChange={(e) => onChange({ title: e.target.value })}
        placeholder="Short task title"
      />

      <label htmlFor="task-agent">Agent</label>
      <select id="task-agent" value={task.agent} onChange={(e) => onChange({ agent: e.target.value })}>
        {agentIds.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>

      <label className="check" style={{ marginTop: 12 }}>
        <input
          type="checkbox"
          checked={!!task.readOnly}
          onChange={(e) => onChange({ readOnly: e.target.checked })}
        />
        read-only (cannot edit files)
      </label>

      <label>Waits for</label>
      <div className="deps">
        {tasks.filter((o) => o.id !== task.id).map((o) => (
          <label key={o.id} className={task.dependsOn.includes(o.id) ? "dep on" : "dep"}>
            <input
              type="checkbox"
              checked={task.dependsOn.includes(o.id)}
              onChange={() => onToggleDep(o.id)}
            />
            {o.id}
          </label>
        ))}
        {tasks.length <= 1 && <span className="muted">no other tasks</span>}
      </div>

      <label htmlFor="task-prompt">Prompt</label>
      <textarea
        id="task-prompt"
        rows={12}
        value={task.prompt}
        onChange={(e) => onChange({ prompt: e.target.value })}
        placeholder="Self-contained instructions for the worker…"
      />

      <div className="row" style={{ marginTop: 14 }}>
        <button className="primary" onClick={onBack}>
          Done
        </button>
        <button className="danger right" onClick={onRemove}>
          Remove task
        </button>
      </div>
    </div>
  );
}

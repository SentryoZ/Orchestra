import { useEffect, useMemo, useState } from "react";
import { computeWaves } from "../waves";
import PlanSummary from "./PlanSummary";
import TaskDetail from "./TaskDetail";
import type { Agent, Mission, MissionTask } from "../types";

interface Props {
  mission: Mission;
  agents: Agent[];
  busy: boolean;
  onSave: (tasks: MissionTask[]) => Promise<Mission>;
  onRevise: (instruction: string) => Promise<boolean>;
  onRun: () => void;
  runLabel?: string;
}

const clone = (tasks: MissionTask[]) => tasks.map((t) => ({ ...t, dependsOn: [...t.dependsOn] }));

export default function PlanReview({ mission, agents, busy, onSave, onRevise, onRun, runLabel }: Props) {
  const [tasks, setTasks] = useState<MissionTask[]>(() => clone(mission.tasks));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** null = summary screen, otherwise the id of the task being edited. */
  const [editing, setEditing] = useState<string | null>(null);

  // Adopt the server's plan whenever it changes and we have no local edits —
  // e.g. after the CTO revises it.
  useEffect(() => {
    if (!dirty) setTasks(clone(mission.tasks));
  }, [mission.tasks, dirty]);

  const waves = useMemo(() => computeWaves(tasks), [tasks]);
  const cyclic = tasks.length > 0 && waves.length === 0;

  const setTask = (id: string, patch: Partial<MissionTask>) => {
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    setDirty(true);
  };

  const toggleDep = (id: string, dep: string) => {
    setTasks((ts) =>
      ts.map((t) =>
        t.id === id
          ? {
              ...t,
              dependsOn: t.dependsOn.includes(dep)
                ? t.dependsOn.filter((d) => d !== dep)
                : [...t.dependsOn, dep],
            }
          : t,
      ),
    );
    setDirty(true);
  };

  const addTask = () => {
    let created = "";
    setTasks((ts) => {
      const used = new Set(ts.map((t) => t.id));
      let n = 1;
      while (used.has(`t${n}`)) n++;
      created = `t${n}`;
      return [
        ...ts,
        {
          id: created,
          title: "New task",
          agent: "build",
          prompt: "",
          dependsOn: [],
          readOnly: false,
          status: "pending" as const,
        },
      ];
    });
    setDirty(true);
    setEditing(created);
  };

  const removeTask = (id: string) => {
    setTasks((ts) =>
      ts.filter((t) => t.id !== id).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== id) })),
    );
    setDirty(true);
    if (editing === id) setEditing(null);
  };

  async function save(): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const updated = await onSave(tasks);
      setTasks(clone(updated.tasks));
      setDirty(false);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function execute() {
    if (cyclic) {
      setError("Fix the dependency cycle before executing.");
      return;
    }
    if (dirty) {
      const ok = await save();
      if (!ok) return;
    }
    onRun();
  }

  function reset() {
    setTasks(clone(mission.tasks));
    setDirty(false);
    setError(null);
    setEditing(null);
  }

  /** Save pending edits first, then let the CTO rewrite the plan. */
  async function revise(instruction: string): Promise<boolean> {
    if (dirty) {
      const ok = await save();
      if (!ok) return false;
    }
    setEditing(null);
    return onRevise(instruction);
  }

  const task = editing ? tasks.find((t) => t.id === editing) ?? null : null;

  if (task) {
    return (
      <TaskDetail
        task={task}
        tasks={tasks}
        agents={agents}
        onChange={(patch) => setTask(task.id, patch)}
        onToggleDep={(dep) => toggleDep(task.id, dep)}
        onRemove={() => removeTask(task.id)}
        onBack={() => setEditing(null)}
      />
    );
  }

  return (
    <PlanSummary
      tasks={tasks}
      waves={waves}
      cyclic={cyclic}
      dirty={dirty}
      saving={saving}
      busy={busy}
      error={error}
      revisions={mission.revisions ?? []}
      onExecute={execute}
      onSave={save}
      onReset={reset}
      onAdd={addTask}
      onOpen={setEditing}
      onRevise={revise}
      runLabel={runLabel}
    />
  );
}

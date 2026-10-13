import { useState } from "react";
import Markdown from "./Markdown";
import PlanReview from "./PlanReview";
import type { Agent, Mission, MissionTask } from "../types";

interface Props {
  mission: Mission;
  agents: Agent[];
  answers: Record<string, string>;
  onAnswer: (id: string, value: string) => void;
  onSubmitAnswers: () => void;
  onSavePlan: (tasks: MissionTask[]) => Promise<Mission>;
  onRevisePlan: (instruction: string) => Promise<boolean>;
  onDelete: () => void;
  onResume: () => void;
  onRetryTask: (taskId: string) => void;
  onRun: () => void;
  busy: boolean;
}

function TaskCard({
  mission,
  id,
  onRetry,
}: {
  mission: Mission;
  id: string;
  onRetry?: (id: string) => void;
}) {
  const t = mission.tasks.find((x) => x.id === id);
  if (!t) return null;
  return (
    <div className="step">
      <div className="step-head">
        <span className="idx">{t.id}</span>
        <span className="name">{t.title}</span>
        <span className="tag">{t.agent}</span>
        {t.readOnly && <span className="tag">read-only</span>}
        {t.integration && <span className="tag">{t.integration}</span>}
        <span className={`badge ${t.status}`}>{t.status}</span>
      </div>
      <div className="step-body">
        {t.dependsOn.length > 0 && (
          <>
            <div className="label">Waits for</div>
            <pre>{t.dependsOn.join(", ")}</pre>
          </>
        )}
        {t.prompt && (
          <details>
            <summary className="label" style={{ cursor: "pointer" }}>
              Prompt
            </summary>
            <pre className="muted">{t.prompt}</pre>
          </details>
        )}
        {t.output && (
          <>
            <div className="label">Output</div>
            <Markdown>{t.output}</Markdown>
          </>
        )}
        {t.error && (
          <>
            <div className="label">Error</div>
            <div className="error">{t.error}</div>
          </>
        )}
        {(t.status === "failed" || t.status === "skipped") && onRetry && (
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => onRetry(t.id)}>↻ Retry {t.id}</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function MissionView({
  mission,
  agents,
  answers,
  onAnswer,
  onSubmitAnswers,
  onSavePlan,
  onRevisePlan,
  onDelete,
  onResume,
  onRetryTask,
  onRun,
  busy,
}: Props) {
  const [editingPlan, setEditingPlan] = useState(false);
  const waves = mission.waves ?? [];
  const done = mission.tasks.filter((t) => t.status === "succeeded").length;
  const allAnswered = mission.questions.every((q) => (answers[q.id] ?? "").trim().length > 0);
  const finished = ["running", "succeeded", "failed"].includes(mission.status);

  return (
    <div className="card">
      <h2 className="row">
        Mission
        <span className="right row" style={{ gap: 8 }}>
          <button className="danger" onClick={onDelete}>
            Delete
          </button>
          <span className={`badge ${mission.status}`}>{mission.status}</span>
        </span>
      </h2>
      <p className="desc">{mission.idea}</p>
      <div className="meta">
        <span>
          target <code>{mission.targetDirectory}</code>
        </span>
        {mission.model && (
          <span>
            model <code>{mission.model.providerID}/{mission.model.id}</code>
          </span>
        )}
        {mission.tasks.length > 0 && (
          <span>
            {done}/{mission.tasks.length} tasks done
          </span>
        )}
      </div>

      {mission.notes.length > 0 && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          {mission.notes.map((n, i) => (
            <div key={i}>• {n}</div>
          ))}
        </div>
      )}

      {mission.error && <div className="error" style={{ marginBottom: 12 }}>{mission.error}</div>}

      {mission.status === "planning" && (
        <div className="muted">
          {mission.revisions?.length ? "CTO is revising the plan…" : "CTO is planning…"}
        </div>
      )}

      {mission.status === "awaiting_answers" && (
        <div>
          <div className="label" style={{ color: "var(--accent)" }}>
            The CTO needs answers before it can plan
          </div>
          {mission.questions.map((q) => {
            const value = answers[q.id] ?? "";
            const chosen = q.options?.find((o) => o === value);
            return (
              <div key={q.id} style={{ marginTop: 14 }}>
                <label htmlFor={`q-${q.id}`}>{q.text}</label>
                {q.options && q.options.length > 0 && (
                  <div className="options">
                    {q.options.map((o) => (
                      <button
                        key={o}
                        className={chosen === o ? "option chosen" : "option"}
                        onClick={() => onAnswer(q.id, o)}
                        type="button"
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  id={`q-${q.id}`}
                  rows={2}
                  placeholder={q.options?.length ? "…or write your own answer" : "Your answer"}
                  value={value}
                  onChange={(e) => onAnswer(q.id, e.target.value)}
                />
              </div>
            );
          })}
          <div className="row" style={{ marginTop: 14 }}>
            <button className="primary" onClick={onSubmitAnswers} disabled={busy || !allAnswered}>
              Submit answers
            </button>
            {!allAnswered && <span className="muted">Answer every question to continue.</span>}
          </div>
        </div>
      )}

      {mission.status === "ready" && (
        <PlanReview
          mission={mission}
          agents={agents}
          busy={busy}
          onSave={onSavePlan}
          onRevise={onRevisePlan}
          onRun={onRun}
        />
      )}

      {finished && (
        <div style={{ marginTop: 16 }}>
          {mission.status === "failed" && (
            <div className="row" style={{ marginBottom: 12 }}>
              <button className="primary" onClick={onResume} disabled={busy}>
                ▶ Resume mission
              </button>
              <button onClick={() => setEditingPlan((v) => !v)}>
                {editingPlan ? "View run" : "Edit plan"}
              </button>
              <span className="muted">Only tasks that did not succeed are run again.</span>
            </div>
          )}

          {editingPlan && mission.status === "failed" ? (
            <PlanReview
              mission={mission}
              agents={agents}
              busy={busy}
              onSave={onSavePlan}
              onRevise={onRevisePlan}
              onRun={onResume}
              runLabel="▶ Resume mission"
            />
          ) : (
            waves.map((wave, i) => (
              <div key={i} style={{ marginBottom: 14 }}>
                <div className="label">
                  Wave {i + 1} {wave.length > 1 ? `— ${wave.length} tasks in parallel` : "— sequential"}
                </div>
                {wave.map((id) => (
                  <TaskCard
                    key={id}
                    mission={mission}
                    id={id}
                    onRetry={mission.status === "failed" ? onRetryTask : undefined}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

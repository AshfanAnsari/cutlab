// Prompt tab (parked-features plan, Feature 1 §1–§6). The user describes
// an edit; the relay worker's LLM lane rewrites the project JSON; the
// reply is validated client-side AGAIN (the worker validates too — two
// gates, one contract) and shown as a diff. Nothing touches the timeline
// until Accept, which lands as ONE labelled undo step, so the store's own
// history is the snapshot the plan asks for: Undo restores the pre-edit
// project byte-for-byte because the past stack holds its JSON string.

import { useEffect, useRef, useState } from 'react';
import { store, useStore } from '../state/store';
import { newId } from '../types';
import type { Project, PromptHistoryEntry } from '../types';
import { jobService } from '../services/jobsSupabase';
import { byoTokenHash, loadByoToken } from '../services/byoClaude';
import { mediaRegistryError, validateProjectSchema } from '../services/promptSchema';
import { useAuth } from '../services/auth';
import { consumePromptDraft, subscribePromptDraft } from '../services/promptDraft';
import { summarizeProjectDiff, type DiffRow } from '../services/promptDiff';

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; note: string }
  | { kind: 'diff'; instruction: string; summary: string; revised: Project; rows: DiffRow[] }
  | { kind: 'error'; instruction: string; message: string };

const EXAMPLES = [
  'Make the second clip black and white',
  'Add a title card at the start',
  'Slow the last clip to half speed',
];

export default function PromptPanel() {
  const project = useStore((s) => s.project);
  const auth = useAuth();
  // R22: the last run's trace (lane, summary, outcome) stays visible
  // after the transient phase ends — the panel's status area.
  const [lastRun, setLastRun] = useState<{ lane?: string; summary?: string; state: string; at: string } | null>(null);
  // FIX D: Home's prompt bar hands its text over as a one-shot draft
  // (services/promptDraft) — consumed here on mount, and live if the
  // panel is already mounted when a new draft lands.
  const [text, setText] = useState(() => consumePromptDraft() ?? '');
  useEffect(() => subscribePromptDraft(() => {
    const d = consumePromptDraft();
    if (d != null) setText(d);
  }), []);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // Prompts tried this session but not (yet) accepted — shown in the
  // history list alongside the project's own entries; only accepted edits
  // are written into the project JSON.
  const [sessionEntries, setSessionEntries] = useState<PromptHistoryEntry[]>([]);
  const runningRef = useRef(false);

  const history: PromptHistoryEntry[] = [
    ...sessionEntries,
    ...(project.promptHistory ?? []),
  ];

  const topLabel = store.topHistoryLabel();
  const lastWasPromptEdit = !!topLabel && topLabel.startsWith('Prompt edit');

  async function run(instruction: string) {
    const trimmed = instruction.trim();
    if (!trimmed || runningRef.current) return;
    if (!jobService.createPromptEditJob) {
      setPhase({
        kind: 'error', instruction: trimmed,
        message: 'Prompt editing needs the live relay — this build is on the file-bundle transport.',
      });
      return;
    }
    runningRef.current = true;
    setPhase({ kind: 'running', note: 'Working on your edit…' });
    const before = store.get().project;
    try {
      const token = loadByoToken();
      const tokenHash = token ? await byoTokenHash(token) : undefined;
      const res = await jobService.createPromptEditJob(trimmed, before, tokenHash, (note) => {
        setPhase((p) => (p.kind === 'running' ? { kind: 'running', note } : p));
      });
      // Second gate (the worker is the first): schema + media identity.
      const verdict = validateProjectSchema(res.project);
      const mediaErr = verdict.ok ? mediaRegistryError(before, res.project) : null;
      if (!verdict.ok || mediaErr) {
        console.warn('Prompt edit rejected client-side:', verdict.errors, mediaErr);
        setPhase({
          kind: 'error', instruction: trimmed,
          message: "That edit didn't come back clean — nothing changed.",
        });
        return;
      }
      const rows = summarizeProjectDiff(before, res.project);
      setLastRun({ lane: res.lane, summary: res.summary, state: 'awaiting your review', at: new Date().toISOString() });
      setPhase({ kind: 'diff', instruction: trimmed, summary: res.summary, revised: res.project, rows });
      // If the panel was collapsed, ask the Inspector to show this tab.
      window.dispatchEvent(new CustomEvent('cutlab:prompt-ready'));
    } catch (e) {
      const message = e instanceof Error ? e.message : "That edit didn't come back clean — nothing changed.";
      setLastRun({ state: 'failed', summary: message, at: new Date().toISOString() });
      setPhase({ kind: 'error', instruction: trimmed, message });
    } finally {
      runningRef.current = false;
    }
  }

  function accept() {
    if (phase.kind !== 'diff') return;
    const entry: PromptHistoryEntry = {
      id: newId('ph'),
      prompt: phase.instruction,
      at: new Date().toISOString(),
      summary: phase.summary || undefined,
      applied: true,
    };
    const revised: Project = {
      ...phase.revised,
      promptHistory: [entry, ...(phase.revised.promptHistory ?? [])],
    };
    store.replaceProject(revised, {
      history: true,
      label: `Prompt edit: ${phase.instruction.slice(0, 48)}`,
    });
    setSessionEntries((list) => list.filter((e) => e.prompt !== phase.instruction));
    setLastRun((r) => (r ? { ...r, state: 'applied' } : r));
    setText('');
    setPhase({ kind: 'idle' });
    store.toastMsg('info', 'Edit applied — Undo available');
  }

  function discard() {
    if (phase.kind !== 'diff') return;
    setSessionEntries((list) => [{
      id: newId('ph'),
      prompt: phase.instruction,
      at: new Date().toISOString(),
      summary: phase.summary || undefined,
      applied: false,
    }, ...list]);
    setLastRun((r) => (r ? { ...r, state: 'discarded' } : r));
    setPhase({ kind: 'idle' });
  }

  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      <div>
        <div className="panel-title">Prompt edit</div>
        <p className="pt-1 text-[11px] leading-relaxed text-[#a8a8a8]">
          Describe a change in plain words. The assistant rewrites the project
          on the server; you review the diff before anything is applied.
        </p>
      </div>

      {phase.kind === 'diff' ? (
        <div>
          <div className="panel-title">Review the edit</div>
          {phase.summary && (
            <p className="pt-1.5 text-[12px] leading-relaxed text-[#e8e8e8]">{phase.summary}</p>
          )}
          <div className="pt-2">
            {phase.rows.length === 0 && (
              <p className="text-[12px] text-[#a8a8a8]">No clip-level changes detected.</p>
            )}
            {phase.rows.map((r, i) => (
              <div
                key={i}
                className="cl-fade-in flex items-baseline justify-between gap-2 border-b border-[#2c2c2c] py-1.5"
                style={{ animationDelay: `${i * 40}ms` }}
              >
                <span className="min-w-0 truncate text-[12px] text-[#c9c9c9]">{r.clipName}</span>
                <span className="shrink-0 text-right text-[12px] font-medium text-accent">{r.change}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-2 pt-3">
            <button className="btn primary flex-1" onClick={accept}>Accept</button>
            <button className="btn flex-1" onClick={discard}>Discard</button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button key={ex} className="btn small" disabled={phase.kind === 'running'}
                onClick={() => setText(ex)} title="Fill the instruction box (nothing is sent)">
                {ex}
              </button>
            ))}
          </div>
          <textarea
            className="field"
            rows={4}
            placeholder="Describe the change…"
            value={text}
            disabled={phase.kind === 'running'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run(text);
            }}
          />
          {phase.kind === 'running' ? (
            <div>
              <div className="cl-progress" role="progressbar" aria-label="Prompt edit in progress" />
              <p className="pt-2 text-[12px] text-[#a8a8a8]">{phase.note}</p>
            </div>
          ) : (
            <button
              className="btn primary"
              disabled={!text.trim()}
              onClick={() => void run(text)}
            >
              Apply
            </button>
          )}
          {phase.kind === 'error' && (
            <div className="rounded border border-[#5a2b26] bg-[#2a1a18] px-2.5 py-2">
              <p className="text-[12px] leading-relaxed text-[#e8b4ae]">{phase.message}</p>
              <button className="btn small mt-2" onClick={() => void run(phase.instruction)}>
                Retry
              </button>
            </div>
          )}
          <p className="text-[11px] leading-relaxed text-[#6f6f6f]">
            How it works: your instruction and the project JSON go to the
            assistant through the relay. The reply is checked against the
            project schema before you see it — an edit that fails the check
            changes nothing.
          </p>
          {!auth && (
            <p className="text-[11px] leading-relaxed text-[#a8a8a8]">
              You're signed out: sign in (top right) to run prompt edits
              through the relay — or connect your own assistant and the
              edits run on your machine instead.
            </p>
          )}
          {lastRun && phase.kind === 'idle' && (
            <div className="rounded border border-[#3a3a3a] bg-[#262626] px-2.5 py-2">
              <div className="panel-title pb-0.5">Last run</div>
              <p className="text-[12px] leading-relaxed text-[#e8e8e8]">
                {lastRun.state}
                {lastRun.lane ? ` · via ${lastRun.lane}` : ''} · {new Date(lastRun.at).toLocaleTimeString()}
              </p>
              {lastRun.summary && (
                <p className="pt-0.5 text-[11px] leading-snug text-[#a8a8a8]">{lastRun.summary}</p>
              )}
            </div>
          )}
        </>
      )}

      {lastWasPromptEdit && phase.kind === 'idle' && (
        <button className="btn" onClick={() => store.undo()}>
          Undo last prompt edit
        </button>
      )}

      {history.length > 0 && (
        <div>
          <div className="panel-title">Past prompts</div>
          <div className="pt-1">
            {history.map((h) => (
              <div key={h.id} className="flex items-start justify-between gap-2 border-b border-[#2c2c2c] py-1.5">
                <div className="min-w-0">
                  <div className="truncate text-[12px] text-[#c9c9c9]" title={h.prompt}>{h.prompt}</div>
                  <div className="text-[11px] text-[#6f6f6f]">
                    {new Date(h.at).toLocaleString()} · {h.applied ? 'applied' : 'not applied'}
                  </div>
                </div>
                <button
                  className="btn small shrink-0"
                  disabled={phase.kind === 'running'}
                  onClick={() => { setText(h.prompt); void run(h.prompt); }}
                >
                  Re-run
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

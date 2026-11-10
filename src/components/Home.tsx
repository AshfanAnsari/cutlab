import { useEffect, useRef, useState } from 'react';
import { store, useStore } from '../state/store';
import { useAuth, signOut } from '../services/auth';
import { jobService } from '../services/jobsSupabase';
import type { RemoteProjectInfo } from '../services/jobs';
import {
  entryProject, listLibrary, removeFromLibrary, type LibraryEntry,
} from '../services/projectLibrary';
import { saveProjectJson } from '../services/projectIO';
import type { PageId } from '../services/pages';
import { projectDuration, type Project } from '../types';
import AuthModal from './AuthModal';
import AccountPanel from './AccountPanel';
import SettingsDialog from './SettingsDialog';
import SegmentedToggle from './SegmentedToggle';
import NewProjectDialog, { type NewProjectSpec } from './home/NewProjectDialog';
import {
  IconHome, IconMedia, IconSettings, IconHelp, IconAccount, IconPaperclip,
  IconPlus, IconCaptions, IconReplicate, IconResize, IconExport, IconSearch,
  IconList,
} from './home/HomeIcons';
import logoMark from '../assets/logo-mark.png';

/**
 * HOME — PORT OF THE REMAKE'S WORKSPACE HOME (2026-11-06, user order
 * 18:48 IST: "copy home page exactly as in the file i gave you, i
 * really liked those toggles"). The composition, layout, spacing,
 * copy and icon set are the Antigravity remake's workspace shell
 * (Header + WorkspaceRail + PromptHero + QuickWaysIn +
 * RecentProjects), re-implemented in this codebase. The editor
 * (TopBar / pages / timeline) is untouched; this screen is the
 * front door, entered and left exactly as before.
 *
 * Data is OURS — nothing from his demo state crosses over:
 *  - projects = the autosaved working project (Continue banner) +
 *    the local library (IndexedDB) + signed-in relay projects;
 *  - card visual blocks are typographic (initials on a seeded
 *    charcoal gradient) because the library stores no thumbnails;
 *  - the prompt bar creates a real project and lands in the editor
 *    with the text waiting in the Prompt tab (App.onPromptStart);
 *  - New Project runs his dialog (name / canvas presets / fps)
 *    into a real project (App.onCreateProject).
 *
 * Deliberate deviations from his file, each flagged in BUILD-LOG:
 * no "PRO" badge (no such tier), no fake sign-in/settings (our real
 * AuthModal / SettingsDialog / AccountPanel open from his chrome),
 * the Export quick-row description names our real Deliver page
 * (not "hardware-accelerated ProRes"), card delete is two-step
 * (no trash exists to recover from), the Grid/List segmented
 * toggle in Recent sequences uses HIS SegmentedToggle mechanics
 * (his Home grid had no list view — the toggle the user liked is
 * his landing's, ported onto the section it belongs to).
 */

export interface HomeProps {
  /** Boot restore has settled (autosave read attempted either way). */
  ready: boolean;
  /** savedAt of the boot autosave record, when one existed. */
  autosaveAt: number | null;
  onContinue: () => void;
  onOpenProject: (p: Project) => Promise<boolean>;
  onOpenFile: (f: File) => Promise<boolean>;
  onOpenRelay: (id: string) => Promise<boolean>;
  onNewProject: (canvas?: '9:16' | '16:9' | '1:1') => void;
  /** New Project dialog: create with an explicit name/canvas/fps. */
  onCreateProject?: (spec: NewProjectSpec) => void;
  /** Enter the editor with the CURRENT project on a page (rail). */
  onEnterPage: (page: PageId) => void;
  /** Prompt bar submit: new project (+ imported files), prompt prefilled. */
  onPromptStart: (text: string, files: File[]) => Promise<void>;
  /** Add-captions tile: new project with these files imported, Edit page. */
  onQuickCaptions: (files: File[]) => Promise<void>;
  /** Replicate tile: new project + the Replicate view open. */
  onQuickReplicate: () => void;
  /** Prompt-edit tile: new project + the Prompt tab open. */
  onQuickPrompt: () => void;
  /** Resize tile: CURRENT project, Edit page, Project (canvas) card. */
  onQuickResize: () => void;
}

/* ---- his utils/format.ts, verbatim logic ---- */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function clipCount(p: Project): number {
  return p.tracks.reduce((n, t) => n + t.clips.length, 0);
}

/** '16:9'-style label for a canvas: exact known ratios first, then
 *  the gcd-reduced pair (his cards badge the ratio, ours store dims). */
function ratioLabel(w: number, h: number): string {
  const r = w / h;
  const known: [number, string][] = [[16 / 9, '16:9'], [9 / 16, '9:16'], [1, '1:1'], [21 / 9, '21:9'], [4 / 3, '4:3'], [3 / 4, '3:4']];
  for (const [v, label] of known) if (Math.abs(r - v) < 0.02) return label;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h) || 1;
  return `${w / g}:${h / g}`;
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'C';
  return (words[0][0] + (words[1]?.[0] ?? '')).toUpperCase();
}

/* Card skins: charcoal-family gradients seeded by the project name
 * (the library stores no thumbnails — the block is typographic,
 * never a fake still). */
const CARD_SKINS: [string, string][] = [
  ['#2e2e2e', '#1b1b1b'], ['#2a2f36', '#191c20'], ['#332a26', '#1d1917'],
  ['#262e2a', '#171b19'], ['#2e2a33', '#1c1a20'], ['#33302a', '#1e1c18'],
];
function skinOf(name: string): [string, string] {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CARD_SKINS[h % CARD_SKINS.length];
}

interface HomeEntry {
  key: string;
  name: string;
  source: 'local' | 'cloud';
  updatedAtMs: number;
  aspect?: string;
  fps?: number;
  durationSec?: number;
  clips?: number;
  onOpen: () => void;
  onExport?: () => void;
  onDelete?: () => Promise<void>;
}

export default function Home({
  ready, autosaveAt, onContinue, onOpenProject, onOpenFile, onOpenRelay, onNewProject,
  onCreateProject, onEnterPage, onPromptStart, onQuickCaptions, onQuickReplicate, onQuickPrompt, onQuickResize,
}: HomeProps) {
  const auth = useAuth();
  const project = useStore((s) => s.project);
  const lastSavedAt = useStore((s) => s.lastSavedAt);
  const [authOpen, setAuthOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [npOpen, setNpOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const avatarRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [libList, setLibList] = useState<LibraryEntry[] | null>(null);
  const [relayList, setRelayList] = useState<RemoteProjectInfo[] | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Prompt bar (his PromptHero state).
  const [promptText, setPromptText] = useState('');
  const [attachFiles, setAttachFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const attachRef = useRef<HTMLInputElement>(null);
  const captionsRef = useRef<HTMLInputElement>(null);

  const hasContent = clipCount(project) > 0 || project.media.length > 0;
  const continueSavedAt = lastSavedAt ?? autosaveAt;

  useEffect(() => {
    let live = true;
    void listLibrary().then((l) => { if (live) setLibList(l); }).catch(() => { if (live) setLibList([]); });
    return () => { live = false; };
  }, []);

  const loadRelay = () => {
    if (!jobService.listRemoteProjects) return;
    setRelayList(null);
    setRelayError(null);
    jobService.listRemoteProjects()
      .then((l) => setRelayList(l))
      .catch((e) => {
        setRelayError(e instanceof Error ? e.message : String(e));
        setRelayList([]);
      });
  };
  useEffect(() => {
    if (!auth) { setRelayList(null); setRelayError(null); return; }
    loadRelay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.user.id]);

  // Avatar menu closes on outside pointer-down / Escape (his header
  // used a dropdown; the app's hand-rolled pattern, his styling).
  useEffect(() => {
    if (!avatarOpen) return;
    const onDown = (e: PointerEvent) => {
      if (avatarRef.current && !avatarRef.current.contains(e.target as Node)) setAvatarOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAvatarOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [avatarOpen]);

  const openEntry = async (e: LibraryEntry) => {
    const p = entryProject(e, 'current');
    if (!p) { store.toastMsg('error', 'That library copy could not be read.'); return; }
    setBusy(true);
    try { await onOpenProject(p); } finally { setBusy(false); }
  };
  const openRelay = async (id: string) => {
    setBusy(true);
    try { await onOpenRelay(id); } finally { setBusy(false); }
  };
  const submitPrompt = async () => {
    if (busy || (!promptText.trim() && attachFiles.length === 0)) return;
    setBusy(true);
    try { await onPromptStart(promptText, attachFiles); } finally { setBusy(false); }
  };
  const createFromDialog = (spec: NewProjectSpec) => {
    setNpOpen(false);
    if (onCreateProject) onCreateProject(spec);
    else onNewProject();
  };

  /* ---- unified real project list (library + relay) ---- */
  const entries: HomeEntry[] = [
    ...(libList ?? []).map((e): HomeEntry => ({
      key: `lib:${e.id}`,
      name: e.name,
      source: 'local',
      updatedAtMs: Date.parse(e.savedAt) || 0,
      aspect: ratioLabel(e.project.canvas.w, e.project.canvas.h),
      fps: e.project.canvas.fps,
      durationSec: projectDuration(e.project),
      clips: clipCount(e.project),
      onOpen: () => void openEntry(e),
      onExport: () => {
        const p = entryProject(e, 'current');
        if (p) saveProjectJson(p);
      },
      onDelete: async () => {
        await removeFromLibrary(e.id);
        setLibList(await listLibrary());
      },
    })),
    ...(relayList ?? []).map((r): HomeEntry => ({
      key: `relay:${r.id}`,
      name: r.name,
      source: 'cloud',
      updatedAtMs: Date.parse(r.updatedAt) || 0,
      onOpen: () => void openRelay(r.id),
    })),
  ].sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  const q = query.trim().toLowerCase();
  const shown = entries.filter((e) => !q || e.name.toLowerCase().includes(q));
  const totalCount = entries.length + (hasContent ? 1 : 0);
  const loading = !ready || libList === null;

  const helpHref = `${import.meta.env.BASE_URL}landing/help/`;
  const landingHref = `${import.meta.env.BASE_URL}landing/`;
  const mcpDocsHref = `${import.meta.env.BASE_URL}mcp-docs.html`;
  const changelogHref = `${import.meta.env.BASE_URL}changelog.html`;

  /* ---- Continue banner target: the working project when it has
   * content (his "active project"), else the most recent entry. */
  const banner = hasContent
    ? {
        name: project.name,
        meta: `${ratioLabel(project.canvas.w, project.canvas.h)} • ${project.canvas.fps} fps • ${formatDuration(projectDuration(project))} • Edited ${formatTimeAgo(continueSavedAt ?? Date.now())}`,
        onOpen: onContinue,
      }
    : entries.length
      ? {
          name: entries[0].name,
          meta: entries[0].aspect
            ? `${entries[0].aspect} • ${entries[0].fps} fps • ${formatDuration(entries[0].durationSec ?? 0)} • Edited ${formatTimeAgo(entries[0].updatedAtMs)}`
            : `Cloud project • Edited ${formatTimeAgo(entries[0].updatedAtMs)}`,
          onOpen: entries[0].onOpen,
        }
      : null;

  const navItems: { id: string; label: string; icon: React.ReactNode; active?: boolean; onClick?: () => void; href?: string }[] = [
    { id: 'home', label: 'Home', icon: <IconHome size={16} />, active: true },
    { id: 'media', label: 'Media Library', icon: <IconMedia size={16} />, onClick: () => onEnterPage('media') },
    { id: 'settings', label: 'Settings', icon: <IconSettings size={16} />, onClick: () => setSettingsOpen(true) },
    { id: 'help', label: 'Help', icon: <IconHelp size={16} />, href: helpHref },
    { id: 'mcp-docs', label: 'MCP docs', icon: <IconHelp size={16} />, href: mcpDocsHref },
    { id: 'changelog', label: 'Changelog', icon: <IconList size={16} />, href: changelogHref },
    { id: 'account', label: 'Account', icon: <IconAccount size={16} />, onClick: () => (auth ? setAccountOpen(true) : setAuthOpen(true)) },
  ];

  const railRow = (key: string, name: string, tag: string, onOpen: () => void, current = false) => (
    <button
      key={key}
      onClick={onOpen}
      disabled={busy}
      className={`flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
        current
          ? 'border-l-2 border-[#e31000] bg-[#2a2a2a] font-medium text-white'
          : 'text-[#a8a8a8] hover:bg-[#212121]/40 hover:text-[#ececec]'
      }`}
    >
      <span className="min-w-0 flex-1 truncate pr-2">{name}</span>
      <span className="shrink-0 font-mono text-[10px] text-[#8f8f8f]">{tag}</span>
    </button>
  );

  /* ================= PROMPT HERO (his PromptHero) ================= */
  const promptHero = (
    <div className="mx-auto w-full max-w-[760px]">
      <form
        onSubmit={(e) => { e.preventDefault(); void submitPrompt(); }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const files = [...e.dataTransfer.files];
          if (files.length) setAttachFiles((prev) => [...prev, ...files]);
        }}
        className={`relative rounded-xl border bg-[#212121] p-4 shadow-lg transition-all duration-200 ${
          dragOver ? 'border-[#e31000] bg-[#2a2a2a]/80 ring-2 ring-[#e31000]/30' : 'border-[#3a3a3a] hover:border-[#555]'
        }`}
      >
        <textarea
          data-testid="home-prompt-input"
          rows={3}
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submitPrompt(); }
          }}
          placeholder="Describe the edit, sequence flow, or drop video clips to start…"
          aria-label="Describe your edit"
          className="w-full resize-none bg-transparent text-[14.5px] leading-relaxed text-[#ececec] placeholder:text-[#8f8f8f] focus:outline-none"
        />
        {attachFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 pb-1 pt-2">
            {attachFiles.map((f, i) => {
              const type = f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'audio' : 'image';
              return (
                <span key={`${f.name}-${i}`} className="home-chip-in flex items-center gap-1.5 rounded-full border border-[#3a3a3a] bg-[#2a2a2a] px-2.5 py-0.5 text-[11.5px] text-[#ececec]">
                  <span className="font-mono text-[10px] font-bold uppercase text-[#e31000]">{type}</span>
                  <span className="max-w-[150px] truncate">{f.name}</span>
                  <span className="font-mono text-[10px] text-[#8f8f8f]">({formatFileSize(f.size)})</span>
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    className="ml-1 text-[#8f8f8f] hover:text-white"
                    onClick={() => setAttachFiles(attachFiles.filter((_, j) => j !== i))}
                  >✕</button>
                </span>
              );
            })}
          </div>
        )}
        <div className="flex items-center justify-between border-t border-[#3a3a3a]/50 pt-3">
          <div className="flex items-center gap-2">
            <input
              ref={attachRef}
              type="file"
              multiple
              accept="video/*,audio/*,image/*"
              className="hidden"
              data-testid="home-attach-input"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                if (files.length) setAttachFiles((prev) => [...prev, ...files]);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => attachRef.current?.click()}
              className="flex items-center gap-1.5 rounded-full border border-[#3a3a3a] bg-[#2a2a2a] px-3 py-1 text-[12px] font-medium text-[#a8a8a8] transition-colors hover:border-[#555] hover:text-[#ececec]"
            >
              <IconPaperclip size={14} />
              <span>Attach media</span>
            </button>
            <span className="hidden text-[11px] text-[#8f8f8f] sm:inline">or drop files here</span>
          </div>
          <button
            type="submit"
            disabled={busy || (!promptText.trim() && attachFiles.length === 0)}
            className="flex items-center gap-1.5 rounded-full bg-[#e31000] px-5 py-1.5 text-[13px] font-medium text-white shadow transition-all hover:bg-[#ff2414] active:scale-95 disabled:opacity-40 disabled:hover:bg-[#e31000]"
          >
            <span>Start</span>
            <span>→</span>
          </button>
        </div>
      </form>
      <p className="pt-2 text-center text-[12px] leading-relaxed text-[#8f8f8f]">
        Starts a sequence with your prompt primed in the timeline. CutLab edits by prompt — it does not hallucinate video from scratch.
      </p>
    </div>
  );

  /* ================= QUICK WAYS IN (his QuickWaysIn) ================= */
  const quickActions: { id: string; label: string; desc: string; icon: React.ReactNode; accent?: boolean; onClick: () => void }[] = [
    { id: 'new', label: 'New project', desc: 'A blank sequence canvas, straight into the editor', icon: <IconPlus size={16} />, accent: true, onClick: () => setNpOpen(true) },
    { id: 'captions', label: 'Add captions', desc: 'Import footage — automatic speech-to-text or kinetic manual subtitles', icon: <IconCaptions size={16} />, onClick: () => captionsRef.current?.click() },
    { id: 'replicate', label: 'Replicate an edit', desc: 'Rebuild a reference reel structure with your footage and timing beats', icon: <IconReplicate size={16} />, onClick: onQuickReplicate },
    { id: 'prompt', label: 'Prompt edit', desc: 'Describe timeline transitions, split cuts, and audio ducking', icon: <IconPaperclip size={16} />, onClick: onQuickPrompt },
    { id: 'resize', label: 'Resize canvas', desc: 'Switch aspect ratio between 16:9 widescreen, 9:16 vertical, and 1:1', icon: <IconResize size={16} />, onClick: onQuickResize },
    { id: 'export', label: 'Export / Deliver', desc: 'The Deliver page — render queue, history and downloads', icon: <IconExport size={16} />, onClick: () => onEnterPage('deliver') },
  ];
  const quickWays = (
    <div className="mx-auto mt-8 w-full max-w-[760px]">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-[12px] font-semibold uppercase tracking-wider text-[#a8a8a8]">Quick ways in</span>
      </div>
      <div className="divide-y divide-[#3a3a3a]/60 border-b border-t border-[#3a3a3a]/60" role="list">
        {quickActions.map((item) => (
          <button
            key={item.id}
            role="listitem"
            data-testid={`home-tile-${item.id}`}
            onClick={item.onClick}
            className="group flex w-full items-center gap-3.5 rounded px-2 py-3 text-left transition-colors hover:bg-[#212121]/60"
          >
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-transform group-hover:scale-105 ${
              item.accent ? 'border-[#e31000] bg-[#e31000] text-white shadow-sm' : 'border-[#3a3a3a] bg-[#2a2a2a] text-[#c0c0c0]'
            }`}>
              {item.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-medium text-[#ececec] transition-colors group-hover:text-white">{item.label}</span>
              <span className="block truncate text-[12px] text-[#a8a8a8]">{item.desc}</span>
            </span>
            <span className="shrink-0 text-[14px] text-[#8f8f8f] transition-transform group-hover:translate-x-1 group-hover:text-white">→</span>
          </button>
        ))}
      </div>
      <input
        ref={captionsRef}
        type="file"
        multiple
        accept="video/*,audio/*"
        className="hidden"
        data-testid="home-captions-input"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) {
            setBusy(true);
            void onQuickCaptions(files).finally(() => setBusy(false));
          }
        }}
      />
    </div>
  );

  /* ================= RECENT SEQUENCES (his RecentProjects) ================= */
  const cardVisual = (e: HomeEntry, small = false) => {
    const [from, to] = skinOf(e.name);
    return (
      <div
        className={`relative w-full overflow-hidden rounded-lg border border-[#3a3a3a]/40 ${small ? 'aspect-video' : 'aspect-video'}`}
        style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
      >
        <div className="flex h-full w-full items-center justify-center">
          <span className={`wordmark ${small ? 'text-[20px]' : 'text-[34px]'} text-[#c0c0c0]/50`}>{initialsOf(e.name)}</span>
        </div>
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20" />
        {e.aspect && (
          <span className="absolute left-2 top-2 rounded border border-white/10 bg-black/60 px-1.5 py-0.5 font-mono text-[10px] font-medium text-[#ececec] backdrop-blur-md">
            {e.aspect}
          </span>
        )}
        {e.durationSec !== undefined && (
          <span className="absolute bottom-2 right-2 rounded border border-white/10 bg-black/70 px-1.5 py-0.5 font-mono text-[10.5px] text-[#ececec] backdrop-blur-md">
            {formatDuration(e.durationSec)}
          </span>
        )}
      </div>
    );
  };

  const deleteControl = (e: HomeEntry) => {
    if (!e.onDelete) return null;
    if (confirmDelete === e.key) {
      return (
        <span className="flex items-center gap-1.5 text-[11px]">
          <span className="text-[#ffb3a7]">Delete?</span>
          <button
            type="button"
            className="font-medium text-red-400 hover:text-red-300"
            onClick={() => { setConfirmDelete(null); void e.onDelete?.(); }}
          >Confirm</button>
          <button type="button" className="text-[#a8a8a8] hover:text-white" onClick={() => setConfirmDelete(null)}>Keep</button>
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={() => setConfirmDelete(e.key)}
        className="text-[11px] text-[#8f8f8f] transition-colors hover:text-red-400"
        aria-label={`Delete ${e.name}`}
      >
        Delete
      </button>
    );
  };

  const recentSection = (
    <div className="mx-auto mt-12 w-full max-w-[1040px] pb-16">
      {banner && (
        <div className="mb-8">
          <button
            type="button"
            onClick={banner.onOpen}
            disabled={busy}
            className="group flex w-full items-center gap-4 rounded-xl border border-[#3a3a3a] bg-[#212121] p-4 text-left shadow-md transition-all hover:border-[#555] hover:bg-[#2a2a2a]/70"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#3a3a3a] bg-[#2a2a2a] text-[16px] text-[#ececec] transition-all group-hover:border-[#e31000] group-hover:bg-[#e31000] group-hover:text-white">
              ▸
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-bold uppercase tracking-[0.14em] text-[#e31000]">Continue editing</span>
              <span className="block truncate pt-0.5 text-[16px] font-medium text-white">{banner.name}</span>
              <span className="flex flex-wrap items-center gap-2 pt-1 font-mono text-[11.5px] text-[#a8a8a8]">{banner.meta}</span>
            </span>
            <span className="hidden rounded-full border border-[#3a3a3a] px-3 py-1 text-[12px] font-medium text-[#a8a8a8] transition-colors group-hover:text-white sm:inline-block">
              Open Timeline →
            </span>
          </button>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[17px] font-semibold text-[#ececec]">Recent sequences</h2>
          <span className="rounded-full border border-[#3a3a3a] bg-[#2a2a2a] px-2 py-0.5 font-mono text-[11px] text-[#8f8f8f]">
            {totalCount}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <SegmentedToggle
            ariaLabel="Project view"
            size="sm"
            value={view}
            onChange={(v) => setView(v as 'grid' | 'list')}
            options={[
              { value: 'grid', label: 'Grid' },
              { value: 'list', label: 'List' },
            ]}
          />
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8f8f8f]">
              <IconSearch size={14} />
            </span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects…"
              aria-label="Search projects"
              className="w-[200px] rounded-lg border border-[#3a3a3a] bg-[#212121] py-1 pl-8 pr-3 text-[12.5px] text-[#ececec] transition-all placeholder:text-[#8f8f8f] focus:w-[240px] focus:border-[#555] focus:outline-none"
            />
            {query && (
              <button onClick={() => setQuery('')} className="absolute right-2 top-1.5 text-xs text-[#8f8f8f] hover:text-white" aria-label="Clear search">✕</button>
            )}
          </div>
        </div>
      </div>

      {loading ? (
        <p className="pt-6 text-[13px] text-[#a8a8a8]">Loading your projects…</p>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#3a3a3a] p-12 text-center">
          <p className="text-[14px] text-[#a8a8a8]">
            {q ? `No projects matching "${query}"` : 'No projects found on this device.'}
          </p>
          <button
            onClick={() => setNpOpen(true)}
            className="mt-3 rounded-full bg-[#e31000] px-4 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-[#ff2414]"
          >
            Create New Project
          </button>
        </div>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          {shown.map((e) => (
            <div
              key={e.key}
              className="group flex flex-col justify-between rounded-xl border border-[#3a3a3a] bg-[#212121] p-3.5 shadow-sm transition-all hover:border-[#555] hover:bg-[#2a2a2a]/40"
            >
              <div onClick={e.onOpen} className="cursor-pointer">
                {cardVisual(e)}
              </div>
              <div className="pt-3">
                <h3 onClick={e.onOpen} className="cursor-pointer truncate text-[14px] font-medium text-[#ececec] group-hover:text-white" title={e.name}>
                  {e.name}
                </h3>
                <div className="flex items-center justify-between pt-1 font-mono text-[11px] text-[#8f8f8f]">
                  <span>{formatTimeAgo(e.updatedAtMs)}</span>
                  <span>{e.source === 'cloud' ? 'Cloud' : e.clips !== undefined ? `${e.clips} clip${e.clips === 1 ? '' : 's'}` : 'Local'}</span>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-[#3a3a3a]/40 pt-2">
                {e.onExport ? (
                  <button
                    type="button"
                    onClick={e.onExport}
                    className="font-mono text-[11px] text-[#a8a8a8] transition-colors hover:text-[#ececec]"
                    title="Download this project as a .cutlab.json file"
                  >
                    Export JSON
                  </button>
                ) : (
                  <span className="font-mono text-[11px] text-[#8f8f8f]">Relay project</span>
                )}
                {deleteControl(e)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2" data-testid="home-project-list">
          {shown.map((e) => (
            <div
              key={e.key}
              className="group flex items-center gap-3.5 rounded-xl border border-[#3a3a3a] bg-[#212121] p-3 shadow-sm transition-all hover:border-[#555] hover:bg-[#2a2a2a]/40"
            >
              <div onClick={e.onOpen} className="w-[120px] shrink-0 cursor-pointer max-[480px]:hidden">
                {cardVisual(e, true)}
              </div>
              <div className="min-w-0 flex-1">
                <h3 onClick={e.onOpen} className="cursor-pointer truncate text-[14px] font-medium text-[#ececec] group-hover:text-white" title={e.name}>
                  {e.name}
                </h3>
                <div className="pt-0.5 font-mono text-[11px] text-[#8f8f8f]">
                  {e.aspect ? `${e.aspect} • ${e.fps} fps • ${formatDuration(e.durationSec ?? 0)} • ` : ''}{formatTimeAgo(e.updatedAtMs)} • {e.source === 'cloud' ? 'Cloud' : `${e.clips ?? 0} clip${e.clips === 1 ? '' : 's'}`}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {e.onExport && (
                  <button type="button" onClick={e.onExport} className="font-mono text-[11px] text-[#a8a8a8] transition-colors hover:text-[#ececec]">
                    Export JSON
                  </button>
                )}
                {deleteControl(e)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Cloud states — real relay data his demo never had to show:
          signed out = one honest locked row; signed in + failed =
          the error with a retry; signed in + loading = a line. */}
      {!auth && !loading && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-[#3a3a3a] bg-[#1b1b1b] px-4 py-3">
          <span className="min-w-0 flex-1 text-[13px] text-[#c9c9c9]">Sign in to see your cloud projects</span>
          <button className="btn small" onClick={() => setAuthOpen(true)}>Sign in</button>
        </div>
      )}
      {auth && relayError && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-[#3a3a3a] bg-[#1b1b1b] px-4 py-3">
          <span className="min-w-0 flex-1 text-[13px] text-[#c9c9c9]">Couldn’t load your cloud projects — {relayError}</span>
          <button className="btn small" onClick={loadRelay}>Retry</button>
        </div>
      )}
      {auth && relayList === null && !relayError && (
        <p className="pt-3 text-[12px] text-[#8f8f8f]">Loading cloud projects…</p>
      )}
    </div>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#161616] text-[#ececec]">
      {/* ================= HEADER (his Header) ================= */}
      <header className="z-20 flex h-[48px] shrink-0 select-none items-center justify-between border-b border-[#3a3a3a] bg-[#161616] px-3.5">
        <div className="flex items-center gap-2.5">
          <img src={logoMark} alt="" width={24} height={24} className="block" draggable={false} />
          <span className="wordmark text-[19px] font-semibold tracking-tight text-white">CutLab</span>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <a
            href={landingHref}
            className="hidden rounded-full border border-[#3a3a3a]/60 bg-transparent px-2.5 py-1 text-[12px] font-medium text-[#a8a8a8] transition-colors hover:border-[#3a3a3a] hover:text-white sm:inline-flex"
          >
            ← Landing
          </a>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.cutlab,application/json,application/zip"
            className="hidden"
            data-testid="home-project-file-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onOpenFile(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded-full border border-[#3a3a3a] bg-[#212121] px-2.5 py-1 text-[12px] font-medium text-[#ececec] transition-colors hover:border-[#555] hover:bg-[#2a2a2a] active:scale-[0.98] sm:px-3 sm:text-[12.5px]"
          >
            Open…
          </button>
          <button
            type="button"
            onClick={() => setNpOpen(true)}
            className="flex items-center gap-1 rounded-full bg-[#e31000] px-3 py-1 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-[#ff2414] active:scale-[0.98] sm:px-3.5 sm:text-[12.5px]"
          >
            <span>+</span>
            <span className="hidden min-[420px]:inline">New project</span>
            <span className="min-[420px]:hidden">New</span>
          </button>
          {auth ? (
            <div className="relative" ref={avatarRef}>
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-full bg-[#e31000] text-[12px] font-semibold text-white transition-transform focus:outline-none focus:ring-1 focus:ring-[#ececec] active:scale-95"
                title={auth.user.email ?? 'Account'}
                aria-label="Account menu" aria-haspopup="menu" aria-expanded={avatarOpen}
                onClick={() => setAvatarOpen((v) => !v)}
              >
                {(auth.user.email?.[0] ?? '?').toUpperCase()}
              </button>
              {avatarOpen && (
                <div className="absolute right-0 top-full z-50 mt-1.5 min-w-[210px] rounded-lg border border-[#3a3a3a] bg-[#212121] p-1 shadow-2xl" role="menu">
                  <div className="border-b border-[#3a3a3a]/60 px-3 py-2">
                    <p className="truncate text-[12.5px] font-medium text-[#ececec]">{auth.user.email}</p>
                    <p className="text-[10.5px] text-[#8f8f8f]">Signed in</p>
                  </div>
                  <button role="menuitem" className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[12.5px] text-[#ececec] outline-none hover:bg-[#2a2a2a]"
                    onClick={() => { setAvatarOpen(false); setAccountOpen(true); }}>
                    Account…
                  </button>
                  <button role="menuitem" className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[12.5px] text-[#ececec] outline-none hover:bg-[#2a2a2a]"
                    onClick={() => { setAvatarOpen(false); setSettingsOpen(true); }}>
                    Preferences…
                  </button>
                  <button role="menuitem" className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[12.5px] text-red-400 outline-none hover:bg-[#2a2a2a]"
                    onClick={() => {
                      setAvatarOpen(false);
                      void signOut().then(() => store.toastMsg('info', 'Signed out. Local projects are untouched.'));
                    }}>
                    Sign out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAuthOpen(true)}
              className="rounded-full border border-[#3a3a3a] px-3 py-1 text-[12.5px] text-[#a8a8a8] transition-colors hover:border-[#555] hover:text-[#ececec]"
            >
              Sign in
            </button>
          )}
        </div>
      </header>

      {/* ================= BODY: rail + content ================= */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        <aside className="flex w-full shrink-0 select-none flex-col border-b border-[#3a3a3a] bg-[#161616] md:w-[240px] md:border-b-0 md:border-r" aria-label="Workspace rail">
          <nav className="flex flex-row gap-1 overflow-x-auto border-b border-[#3a3a3a]/60 p-1.5 md:flex-col md:border-b-0 md:p-2" aria-label="Workspace">
            {navItems.map((item) => {
              const cls = `group relative flex flex-1 items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors md:flex-initial ${
                item.active ? 'bg-[#2a2a2a]/70 font-medium text-white' : 'text-[#a8a8a8] hover:bg-[#212121]/50 hover:text-white'
              }`;
              const inner = (
                <>
                  {item.active && <span className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r bg-[#e31000]" />}
                  <span className={`transition-colors ${item.active ? 'text-[#e31000]' : 'text-[#a8a8a8] group-hover:text-[#ececec]'}`}>{item.icon}</span>
                  <span>{item.label}</span>
                </>
              );
              return item.href ? (
                <a key={item.id} href={item.href} target="_blank" rel="noreferrer" className={cls}>{inner}</a>
              ) : (
                <button key={item.id} onClick={item.onClick} aria-current={item.active ? 'page' : undefined} className={`${cls} text-left`}>
                  {inner}
                </button>
              );
            })}
          </nav>

          {/* Projects on this device + cloud (his rail list) */}
          <div className="hidden min-h-0 flex-1 flex-col overflow-hidden px-3 pt-4 md:flex">
            <div className="flex items-center justify-between px-1 pb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#8f8f8f]">Projects</span>
              <span className="rounded border border-[#3a3a3a]/40 bg-[#212121] px-1.5 py-0.5 font-mono text-[10px] text-[#8f8f8f]">
                {totalCount}
              </span>
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
              {loading ? (
                <p className="px-2 pt-2 text-[12px] leading-relaxed text-[#8f8f8f]">Loading…</p>
              ) : totalCount === 0 ? (
                <p className="px-2 pt-2 text-[12px] leading-relaxed text-[#8f8f8f]">No sequences saved yet.</p>
              ) : (
                <>
                  {hasContent && railRow('rail:current', project.name, 'Current', onContinue, true)}
                  {entries.map((e) => railRow(`rail:${e.key}`, e.name, e.source === 'cloud' ? 'Cloud' : 'Local', e.onOpen))}
                </>
              )}
            </div>
          </div>

          {/* Bottom sync tile (his) — identity, real session state */}
          <div className="hidden shrink-0 border-t border-[#3a3a3a] bg-[#212121]/30 p-3 md:block">
            {auth ? (
              <div className="flex items-center justify-between">
                <div className="min-w-0 flex-1 pr-2">
                  <span className="block truncate text-[12px] font-medium text-[#ececec]">{auth.user.email}</span>
                  <span className="block font-mono text-[10px] text-green-400">Signed in</span>
                </div>
                <button
                  onClick={() => setSettingsOpen(true)}
                  className="rounded border border-[#3a3a3a] bg-[#212121] px-2 py-1 text-[11px] text-[#8f8f8f] hover:text-[#ececec]"
                >
                  Config
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <span className="text-[11.5px] leading-tight text-[#8f8f8f]">Signed out — device only</span>
                <button
                  type="button"
                  onClick={() => setAuthOpen(true)}
                  className="rounded-full border border-[#3a3a3a] bg-[#2a2a2a] px-2.5 py-1 text-[11.5px] font-medium text-[#ececec] transition-colors hover:border-[#555] hover:text-white"
                >
                  Sign in
                </button>
              </div>
            )}
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto px-4 py-8 sm:px-8">
          <div className="mx-auto w-full max-w-[1040px]">
            {promptHero}
            {quickWays}
            {recentSection}
          </div>
        </main>
      </div>

      {npOpen && <NewProjectDialog onClose={() => setNpOpen(false)} onCreate={createFromDialog} />}
      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {accountOpen && (
        <AccountPanel
          onClose={() => setAccountOpen(false)}
          onLoadProject={(id) => { setAccountOpen(false); void openRelay(id); }}
        />
      )}
    </div>
  );
}

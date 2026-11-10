// FALLBACK JobService implementation: file bundles out, result packs in.
//
// This was the M1 transport (the app downloads a .zip job bundle, the user
// carries it to the server, the results pack comes back as a file). It is
// kept intact as the fallback — the live transport is jobsSupabase.ts,
// which runs the same jobs against the Supabase relay queue. Both feed the
// shared attach routine in attachResults.ts.
import JSZip from 'jszip';
import type { JobService, IngestResult } from './jobs';
import { downloadBlob } from './projectIO';
import { attachServerResults, recsBySrc, type ResultsManifest } from './attachResults';
import { store } from '../state/store';

function safeName(name: string) {
  return name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'cutlab';
}

export const serverJobService: JobService = {
  async createMediaJobBundle(project, recs) {
    const bySrc = recsBySrc(recs);
    const zip = new JSZip();
    const items = project.media.map((m) => ({
      id: m.id,
      src: m.src,
      kind: m.kind,
      requests: m.kind === 'image' ? ['thumbnail'] : ['proxy', 'thumbnail', 'peaks'],
    }));
    zip.file('job.json', JSON.stringify({
      version: 1, type: 'media-analysis', createdAt: new Date().toISOString(), items,
    }, null, 2));
    const folder = zip.folder('media');
    let included = 0;
    const missing: string[] = [];
    for (const m of project.media) {
      const rec = bySrc.get(m.src);
      if (rec && folder) {
        folder.file(m.src, rec.blob);
        included++;
      } else missing.push(m.src);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `${safeName(project.name)}_media_job.zip`);
    store.toastMsg('info', missing.length
      ? `Media job bundle downloaded (${included} file(s)). Not in the bin yet: ${missing.join(', ')}`
      : `Media job bundle downloaded (${included} file(s)). Send it to the CutLab server; load the results pack here when it comes back.`);
  },

  async createRenderJobBundle(project, recs) {
    const bySrc = recsBySrc(recs);
    const zip = new JSZip();
    zip.file('project.json', JSON.stringify(project, null, 2));
    zip.file('job.json', JSON.stringify({
      version: 1, type: 'render', lane: 'B', createdAt: new Date().toISOString(),
      output: { container: 'mp4', crf: 18, color: 'bt709', stripMetadata: true },
      command: 'python3 server/render_job.py <this-bundle.zip> --out render.mp4',
    }, null, 2));
    const folder = zip.folder('media');
    let included = 0;
    const missing: string[] = [];
    for (const m of project.media) {
      const rec = bySrc.get(m.src);
      if (rec && folder) {
        folder.file(m.src, rec.blob);
        included++;
      } else missing.push(m.src);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `${safeName(project.name)}_render_job.zip`);
    store.toastMsg('info', missing.length
      ? `Render job bundle downloaded (${included} media file(s)). Missing originals: ${missing.join(', ')} — the render will fail until they are included.`
      : `Render job bundle downloaded (${included} media file(s)). The server renders it with Lane B and returns the finished MP4.`);
  },

  async ingestServerResults(file, project): Promise<IngestResult> {
    const zip = await JSZip.loadAsync(file);
    let manifest: ResultsManifest = {};
    const mf = zip.file('manifest.json');
    if (mf) {
      try { manifest = JSON.parse(await mf.async('string')) as ResultsManifest; } catch { /* fall back to name patterns */ }
    }
    const getFile = async (path: string) => {
      const f = zip.file(path);
      return f ? await f.async('blob') : null;
    };
    const { attached, missing } = await attachServerResults(project, manifest, getFile);
    store.toastMsg('info', attached
      ? `Server results attached to ${attached} media item(s) — preview now uses the server proxies.`
      : 'That pack contained no results matching this project’s media.');
    return { attached, missing };
  },
};

// ─── Processing Queue — pure helpers (no DOM, no module state) ─
//
// A queue job is { kind: 'clicktrack'|'stems', trackId, state, message?,
// progress?, device? }. One track can have one job of each kind at once, so
// jobs are keyed by kind + track id.

export const KIND_LABEL = { clicktrack: 'Click track', stems: 'Guitar removal' };

const STAGE_LABEL = {
  queued: 'Queued',
  decoding: 'Decoding…',
  analyzing: 'Analyzing…',
  separating: 'Separating…',
  done: 'Done',
  error: 'Failed',
};

const ACTIVE = new Set(['queued', 'decoding', 'analyzing', 'separating']);

export function jobKey(kind, trackId) {
  return `${kind}:${trackId}`;
}

export function isActiveJob(job) {
  return !!job && ACTIVE.has(job.state);
}

/** Bar width / label / animation for one queue row. */
export function queueRowModel(job) {
  const { state } = job;
  let pct;
  if (state === 'done') pct = 100;
  else if (state === 'separating') {
    // Real fraction from the sidecar; separation is most of the job, decoding ~10%.
    const p = Number.isFinite(job.progress) ? Math.min(1, Math.max(0, job.progress)) : 0;
    pct = Math.round(10 + p * 90);
  } else if (state === 'analyzing') pct = 66;
  else if (state === 'decoding') pct = job.kind === 'stems' ? 5 : 25;
  else if (state === 'queued') pct = job.kind === 'stems' ? 2 : 8;
  else pct = 0;

  let label = state === 'error' ? (job.message || 'Failed') : (STAGE_LABEL[state] || state);
  if (state === 'separating' && Number.isFinite(job.progress)) {
    label = `Separating ${Math.round(job.progress * 100)}%${job.device === 'cuda' ? ' (GPU)' : job.device === 'cpu' ? ' (CPU)' : ''}`;
  }
  // Only animate when there's no real progress to show.
  const animate = ACTIVE.has(state) && state !== 'queued' && !(state === 'separating' && Number.isFinite(job.progress));
  return { pct, label, animate };
}

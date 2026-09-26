import { describe, expect, it } from 'vitest';
import { jobKey, isActiveJob, queueRowModel } from '../renderer/js/queue-utils.js';
import { gpuPackView } from '../renderer/js/gpu-pack.js';

describe('jobKey', () => {
  it('keeps click-track and stems jobs for the same track distinct', () => {
    expect(jobKey('clicktrack', 't1')).not.toBe(jobKey('stems', 't1'));
  });
});

describe('isActiveJob', () => {
  it('treats queued/decoding/analyzing/separating as active', () => {
    for (const state of ['queued', 'decoding', 'analyzing', 'separating']) {
      expect(isActiveJob({ state })).toBe(true);
    }
  });
  it('treats done/error/missing as inactive', () => {
    expect(isActiveJob({ state: 'done' })).toBe(false);
    expect(isActiveJob({ state: 'error' })).toBe(false);
    expect(isActiveJob(null)).toBe(false);
  });
});

describe('queueRowModel', () => {
  it('maps real separation progress onto the bar after the decode slice', () => {
    const m = queueRowModel({ kind: 'stems', state: 'separating', progress: 0.5, device: 'cuda' });
    expect(m.pct).toBe(55);
    expect(m.label).toBe('Separating 50% (GPU)');
    expect(m.animate).toBe(false);
  });

  it('clamps out-of-range progress', () => {
    expect(queueRowModel({ kind: 'stems', state: 'separating', progress: 1.7 }).pct).toBe(100);
    expect(queueRowModel({ kind: 'stems', state: 'separating', progress: -1 }).pct).toBe(10);
  });

  it('animates while separating before the first progress report', () => {
    const m = queueRowModel({ kind: 'stems', state: 'separating' });
    expect(m.label).toBe('Separating…');
    expect(m.animate).toBe(true);
  });

  it('keeps the click-track bar positions unchanged', () => {
    expect(queueRowModel({ kind: 'clicktrack', state: 'queued' }).pct).toBe(8);
    expect(queueRowModel({ kind: 'clicktrack', state: 'decoding' }).pct).toBe(25);
    expect(queueRowModel({ kind: 'clicktrack', state: 'analyzing' }).pct).toBe(66);
    expect(queueRowModel({ kind: 'clicktrack', state: 'done' }).pct).toBe(100);
  });

  it('shows the error message on failure', () => {
    expect(queueRowModel({ kind: 'stems', state: 'error', message: 'boom' }).label).toBe('boom');
    expect(queueRowModel({ kind: 'stems', state: 'error' }).label).toBe('Failed');
  });
});

describe('gpuPackView', () => {
  const base = { sizeBytes: 1_915_188_422, minDriver: 580, progress: { installing: false, stage: '' } };

  it('offers the download when an NVIDIA GPU with a new driver is present', () => {
    const v = gpuPackView({ ...base, gpuName: 'RTX 4070', driver: '616.64', driverOk: true });
    expect(v.install).toBe(true);
    expect(v.installLabel).toBe('Download GPU pack (1.8 GB)');
    expect(v.remove).toBe(false);
  });

  it('explains CPU fallback when no NVIDIA GPU is found', () => {
    const v = gpuPackView({ ...base, gpuName: null });
    expect(v.install).toBe(false);
    expect(v.text).toMatch(/CPU/);
  });

  it('asks for a driver update instead of offering a download that cannot work', () => {
    const v = gpuPackView({ ...base, gpuName: 'GTX 1080', driver: '472.12', driverOk: false });
    expect(v.install).toBe(false);
    expect(v.tone).toBe('warn');
    expect(v.text).toMatch(/580/);
  });

  it('shows download progress with a cancel button', () => {
    const v = gpuPackView({ ...base, gpuName: 'RTX 4070', driverOk: true,
      progress: { installing: true, stage: 'downloading', done: 1024 ** 3, total: 2 * 1024 ** 3 } });
    expect(v.pct).toBe(50);
    expect(v.cancel).toBe(true);
    expect(v.text).toBe('Downloading 1.0 GB of 2.0 GB');
  });

  it('reports the active GPU once installed', () => {
    const v = gpuPackView({ ...base, installed: true, gpuName: 'RTX 4070', probe: { gpu: 'NVIDIA GeForce RTX 4070' } });
    expect(v.text).toMatch(/NVIDIA GeForce RTX 4070/);
    expect(v.remove).toBe(true);
    expect(v.install).toBe(false);
  });

  it('offers a retry after a failed install, but not after a cancel', () => {
    const failed = gpuPackView({ ...base, gpuName: 'RTX 4070', driverOk: true, progress: { stage: 'error', error: 'download: timeout' } });
    expect(failed.installLabel).toBe('Retry');
    expect(failed.tone).toBe('error');
    const cancelled = gpuPackView({ ...base, gpuName: 'RTX 4070', driverOk: true, progress: { stage: 'error', error: 'cancelled' } });
    expect(cancelled.installLabel).toMatch(/^Download/);
  });
});

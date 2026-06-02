//! Live input path: Focusrite (or any cpal device) → SPSC ring → VST → output stream.
//!
//! Music playback is intentionally NOT routed through here. Music continues to flow
//! through the rodio Sink in audio.rs. The two outputs mix at the device level.
//!
//! Threading: cpal manages its own audio threads for the input/output callbacks.
//! Both callbacks are zero-allocation and use atomics + try_lock only.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, Data, SampleFormat, SampleRate, Stream, StreamConfig};
use parking_lot::Mutex;
use ringbuf::{HeapCons, HeapProd, HeapRb};
use ringbuf::traits::{Consumer, Producer, Split};
use serde::{Deserialize, Serialize};

use crate::vst_host::VstHost;

/// Stereo block size used between input and output halves of the ring.
/// Must be ≥ the largest expected ASIO buffer size to avoid permanent underrun.
const RING_FRAMES: usize = 8192;

/// Convert linear gain (f32) to atomic-storable bits and back.
#[inline]
fn pack_gain(g: f32) -> u32 { g.to_bits() }
#[inline]
fn unpack_gain(b: u32) -> f32 { f32::from_bits(b) }

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LiveInputConfig {
    pub device_name: String,
    pub is_asio: bool,
    /// Physical input channel indices (0-based). 1 = mono, 2 = stereo pair.
    pub input_channels: Vec<u32>,
    /// Physical output channel indices to write VST output into (default [0,1]).
    pub output_channels: Vec<u32>,
    pub buffer_size: u32,
    pub sample_rate: u32,
}

#[derive(Serialize, Clone)]
pub struct LiveInputStatus {
    pub running: bool,
    pub device: String,
    pub is_asio: bool,
    pub input_channels: Vec<u32>,
    pub output_channels: Vec<u32>,
    pub buffer_size: u32,
    pub sample_rate: u32,
    pub underruns: u64,
    /// Absolute peak level of the last input block (0.0–1.0+). Used by JS level meter.
    pub peak_level: f32,
}

/// Wrap !Send Stream in a Send newtype — same pattern as SendStream in audio.rs.
/// cpal manages the audio thread internally; we just hold the lifetime handle.
struct SendStream(Stream);
unsafe impl Send for SendStream {}
unsafe impl Sync for SendStream {}

pub struct LiveInputEngine {
    input_stream: Option<SendStream>,
    output_stream: Option<SendStream>,
    config: Option<LiveInputConfig>,
    vst_slot: Arc<Mutex<Option<VstHost>>>,

    // Atomic knobs read by callbacks.
    input_gain: Arc<AtomicU32>,    // f32 bits
    output_gain: Arc<AtomicU32>,
    muted: Arc<AtomicBool>,
    underruns: Arc<AtomicU64>,
    peak_level: Arc<AtomicU32>,    // f32 bits; abs peak of last input block
}

impl LiveInputEngine {
    pub fn new(vst_slot: Arc<Mutex<Option<VstHost>>>) -> Self {
        Self {
            input_stream: None,
            output_stream: None,
            config: None,
            vst_slot,
            input_gain: Arc::new(AtomicU32::new(pack_gain(1.0))),
            output_gain: Arc::new(AtomicU32::new(pack_gain(1.0))),
            muted: Arc::new(AtomicBool::new(false)),
            underruns: Arc::new(AtomicU64::new(0)),
            peak_level: Arc::new(AtomicU32::new(pack_gain(0.0))),
        }
    }

    pub fn set_input_gain(&self, g: f32) {
        self.input_gain.store(pack_gain(g.clamp(0.0, 8.0)), Ordering::Relaxed);
    }
    pub fn set_output_gain(&self, g: f32) {
        self.output_gain.store(pack_gain(g.clamp(0.0, 8.0)), Ordering::Relaxed);
    }
    pub fn set_mute(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }

    pub fn status(&self) -> LiveInputStatus {
        let cfg = self.config.clone();
        LiveInputStatus {
            running: self.input_stream.is_some() && self.output_stream.is_some(),
            device: cfg.as_ref().map(|c| c.device_name.clone()).unwrap_or_default(),
            is_asio: cfg.as_ref().map(|c| c.is_asio).unwrap_or(false),
            input_channels: cfg.as_ref().map(|c| c.input_channels.clone()).unwrap_or_default(),
            output_channels: cfg.as_ref().map(|c| c.output_channels.clone()).unwrap_or_default(),
            buffer_size: cfg.as_ref().map(|c| c.buffer_size).unwrap_or(0),
            sample_rate: cfg.as_ref().map(|c| c.sample_rate).unwrap_or(0),
            underruns: self.underruns.load(Ordering::Relaxed),
            peak_level: unpack_gain(self.peak_level.load(Ordering::Relaxed)),
        }
    }

    /// Stop and drop both streams. Safe to call when not running.
    pub fn stop(&mut self) {
        self.input_stream = None;
        self.output_stream = None;
        self.config = None;
        self.peak_level.store(pack_gain(0.0), Ordering::Relaxed);
    }

    pub fn start(&mut self, cfg: LiveInputConfig) -> Result<(), String> {
        // Replace any prior session.
        self.stop();

        if cfg.input_channels.is_empty() {
            return Err("At least one input channel required".into());
        }
        if cfg.input_channels.len() > 2 {
            return Err("Stage 2 supports mono (1ch) or stereo (2ch) input only".into());
        }
        if cfg.output_channels.len() != 2 {
            return Err("Output channel count must be exactly 2 (stereo)".into());
        }

        // Resolve cpal device once. ASIO drivers allow only one instance per process —
        // the same Device must be used for both input and output streams.
        let device = find_device(&cfg.device_name, cfg.is_asio)?;
        let out_device = device.clone();

        let default_in = device
            .default_input_config()
            .map_err(|e| format!("Cannot read input config: {e}"))?;
        let default_out = out_device
            .default_output_config()
            .map_err(|e| format!("Cannot read output config: {e}"))?;
        let device_in_channels = default_in.channels();
        let device_out_channels = default_out.channels();
        let device_sample_rate = default_in.sample_rate().0;
        let in_format = default_in.sample_format();
        let out_format = default_out.sample_format();

        // Validate channel indices fit the device.
        for &ch in &cfg.input_channels {
            if ch as u16 >= device_in_channels {
                return Err(format!(
                    "Input channel {} out of range (device has {} input channels)",
                    ch, device_in_channels
                ));
            }
        }
        for &ch in &cfg.output_channels {
            if ch as u16 >= device_out_channels {
                return Err(format!(
                    "Output channel {} out of range (device has {} output channels)",
                    ch, device_out_channels
                ));
            }
        }

        // ASIO drivers control buffer size + sample rate themselves (Focusrite control panel).
        // Requesting Fixed buffer or specific SR fails — use Default and let the driver decide.
        // WASAPI input: always use BufferSize::Default — many USB/webcam devices reject Fixed.
        // WASAPI output: honor user's buffer size choice for latency control.
        let in_buffer_size = BufferSize::Default;
        let out_buffer_size = if cfg.is_asio {
            BufferSize::Default
        } else {
            BufferSize::Fixed(cfg.buffer_size)
        };
        let sample_rate = if cfg.is_asio {
            SampleRate(device_sample_rate)
        } else {
            SampleRate(cfg.sample_rate)
        };

        let stream_in_cfg = StreamConfig {
            channels: device_in_channels,
            sample_rate,
            buffer_size: in_buffer_size,
        };
        let stream_out_cfg = StreamConfig {
            channels: device_out_channels,
            sample_rate,
            buffer_size: out_buffer_size,
        };

        // SPSC ring carries stereo interleaved (L,R,L,R...) samples.
        let rb = HeapRb::<f32>::new(RING_FRAMES * 2);
        let (mut producer, mut consumer): (HeapProd<f32>, HeapCons<f32>) = rb.split();

        // Snapshot atomics for the callbacks (clone Arcs).
        let in_gain = self.input_gain.clone();
        let out_gain = self.output_gain.clone();
        let muted = self.muted.clone();
        let underruns = self.underruns.clone();
        let vst_slot = self.vst_slot.clone();
        let peak_level_cb = self.peak_level.clone();

        // Resolve input channel mapping outside the hot path.
        let in_ch_indices = cfg.input_channels.clone();
        let in_total_channels = device_in_channels as usize;
        let mono_input = in_ch_indices.len() == 1;
        let in_idx_l = in_ch_indices[0] as usize;
        let in_idx_r = if mono_input { in_idx_l } else { in_ch_indices[1] as usize };

        let out_ch_indices = cfg.output_channels.clone();
        let out_total_channels = device_out_channels as usize;
        let out_idx_l = out_ch_indices[0] as usize;
        let out_idx_r = out_ch_indices[1] as usize;

        // Preallocated per-callback scratch buffers. Size generously — ASIO driver
        // dictates actual buffer size, we don't know it in advance. RING_FRAMES is the
        // upper bound the rest of the engine assumes.
        let max_frames = RING_FRAMES;
        let mut in_scratch: Vec<f32> = vec![0.0; max_frames * 2];        // stereo interleaved
        let mut pull_scratch: Vec<f32> = vec![0.0; max_frames * 2];      // ring → output
        let mut process_scratch: Vec<f32> = vec![0.0; max_frames * 2];   // VST output

        // ── Input callback (raw — handles any sample format) ──────────────────
        let in_total_channels_cb = in_total_channels;
        let input_data_fn = move |data: &Data, _: &cpal::InputCallbackInfo| {
            let frames = data.len() / in_total_channels_cb;
            let needed = frames * 2;
            if in_scratch.len() < needed { return; }
            let gain = unpack_gain(in_gain.load(Ordering::Relaxed));
            let is_muted = muted.load(Ordering::Relaxed);

            // Read sample at frame `f`, channel `ch`, converting to f32 in [-1, 1].
            let read_f32 = |f: usize, ch: usize| -> f32 {
                let idx = f * in_total_channels_cb + ch;
                match in_format {
                    SampleFormat::F32 => data.as_slice::<f32>().map(|s| s[idx]).unwrap_or(0.0),
                    SampleFormat::I32 => data.as_slice::<i32>()
                        .map(|s| s[idx] as f32 / i32::MAX as f32).unwrap_or(0.0),
                    SampleFormat::I16 => data.as_slice::<i16>()
                        .map(|s| s[idx] as f32 / i16::MAX as f32).unwrap_or(0.0),
                    _ => 0.0,
                }
            };

            for f in 0..frames {
                let l_raw = if is_muted { 0.0 } else { read_f32(f, in_idx_l) * gain };
                let r_raw = if mono_input {
                    l_raw
                } else if is_muted { 0.0 } else { read_f32(f, in_idx_r) * gain };
                in_scratch[f * 2] = l_raw;
                in_scratch[f * 2 + 1] = r_raw;
            }

            // Track peak for JS level meter (abs max of the post-gain block).
            let peak = in_scratch[..needed].iter().map(|s| s.abs()).fold(0.0_f32, f32::max);
            peak_level_cb.store(peak.to_bits(), Ordering::Relaxed);

            let _ = producer.push_slice(&in_scratch[..needed]);
        };

        let input_err_fn = move |err| {
            log::warn!("[live_input] input stream error: {err}");
        };

        // ── Output callback (raw — handles any sample format) ─────────────────
        let out_total_channels_cb = out_total_channels;
        let output_data_fn = move |data: &mut Data, _: &cpal::OutputCallbackInfo| {
            let total_samples = data.len();
            let frames = total_samples / out_total_channels_cb;
            let needed = frames * 2;

            if pull_scratch.len() < needed || process_scratch.len() < needed { return; }

            let pulled = consumer.pop_slice(&mut pull_scratch[..needed]);
            if pulled < needed {
                for s in &mut pull_scratch[pulled..needed] { *s = 0.0; }
                underruns.fetch_add(1, Ordering::Relaxed);
            }

            const VST_MAX_FRAMES: usize = 512;
            let mut handled = false;
            if let Some(mut slot) = vst_slot.try_lock() {
                if let Some(host) = slot.as_mut() {
                    let mut off_frames = 0;
                    while off_frames < frames {
                        let chunk_frames = (frames - off_frames).min(VST_MAX_FRAMES);
                        let s = off_frames * 2;
                        let e = s + chunk_frames * 2;
                        host.process_block(
                            &pull_scratch[s..e],
                            &mut process_scratch[s..e],
                        );
                        off_frames += chunk_frames;
                    }
                    handled = true;
                }
            }
            if !handled {
                process_scratch[..needed].copy_from_slice(&pull_scratch[..needed]);
            }

            let g = unpack_gain(out_gain.load(Ordering::Relaxed));

            // Write to device output, converting f32 → device's native sample format.
            // Zero entire output buffer first.
            match out_format {
                SampleFormat::F32 => {
                    if let Some(out) = data.as_slice_mut::<f32>() {
                        for s in out.iter_mut() { *s = 0.0; }
                        for f in 0..frames {
                            let base = f * out_total_channels_cb;
                            out[base + out_idx_l] = process_scratch[f * 2] * g;
                            out[base + out_idx_r] = process_scratch[f * 2 + 1] * g;
                        }
                    }
                }
                SampleFormat::I32 => {
                    if let Some(out) = data.as_slice_mut::<i32>() {
                        for s in out.iter_mut() { *s = 0; }
                        for f in 0..frames {
                            let base = f * out_total_channels_cb;
                            let l = (process_scratch[f * 2] * g).clamp(-1.0, 1.0);
                            let r = (process_scratch[f * 2 + 1] * g).clamp(-1.0, 1.0);
                            out[base + out_idx_l] = (l * i32::MAX as f32) as i32;
                            out[base + out_idx_r] = (r * i32::MAX as f32) as i32;
                        }
                    }
                }
                SampleFormat::I16 => {
                    if let Some(out) = data.as_slice_mut::<i16>() {
                        for s in out.iter_mut() { *s = 0; }
                        for f in 0..frames {
                            let base = f * out_total_channels_cb;
                            let l = (process_scratch[f * 2] * g).clamp(-1.0, 1.0);
                            let r = (process_scratch[f * 2 + 1] * g).clamp(-1.0, 1.0);
                            out[base + out_idx_l] = (l * i16::MAX as f32) as i16;
                            out[base + out_idx_r] = (r * i16::MAX as f32) as i16;
                        }
                    }
                }
                _ => {} // unsupported format → silence
            }
        };

        let output_err_fn = move |err| {
            log::warn!("[live_input] output stream error: {err}");
        };

        // Use _raw variants because ASIO drivers expose specific native formats
        // (typically i32 for Focusrite) and reject non-matching SampleFormat.
        let input = device
            .build_input_stream_raw(
                &stream_in_cfg,
                in_format,
                input_data_fn,
                input_err_fn,
                None,
            )
            .map_err(|e| format!("Build input stream failed: {e}"))?;
        let output = out_device
            .build_output_stream_raw(
                &stream_out_cfg,
                out_format,
                output_data_fn,
                output_err_fn,
                None,
            )
            .map_err(|e| format!("Build output stream failed: {e}"))?;

        input.play().map_err(|e| format!("Start input failed: {e}"))?;
        output.play().map_err(|e| format!("Start output failed: {e}"))?;

        self.input_stream = Some(SendStream(input));
        self.output_stream = Some(SendStream(output));
        self.config = Some(cfg);
        self.underruns.store(0, Ordering::Relaxed);

        log::info!("[live_input] started: device={} in_ch={:?} out_ch={:?} buf={} sr={}",
            self.config.as_ref().unwrap().device_name,
            self.config.as_ref().unwrap().input_channels,
            self.config.as_ref().unwrap().output_channels,
            self.config.as_ref().unwrap().buffer_size,
            self.config.as_ref().unwrap().sample_rate);
        let _ = SampleFormat::F32; // silence unused-import warning under cfg variants
        Ok(())
    }
}

/// Look up a cpal device by name. ASIO devices expose both in + out via the same Device,
/// so we don't filter by direction — caller uses the returned Device for both streams.
fn find_device(name: &str, is_asio: bool) -> Result<cpal::Device, String> {
    #[cfg(target_os = "windows")]
    if is_asio {
        let host = cpal::host_from_id(cpal::HostId::Asio)
            .map_err(|e| format!("Steinberg driver host unavailable: {e}"))?;
        // ASIO: enumerate via input_devices (the same device represents both directions).
        let devices = host
            .input_devices()
            .map_err(|e| format!("Cannot enumerate ASIO devices: {e}"))?;
        for d in devices {
            if d.name().map(|n| n == name).unwrap_or(false) {
                return Ok(d);
            }
        }
        return Err(format!("ASIO device not found: {name}"));
    }

    let _ = is_asio;
    let host = cpal::default_host();
    // WASAPI: try input first, then output (same name may live on either side).
    if let Ok(devs) = host.input_devices() {
        for d in devs {
            if d.name().map(|n| n == name).unwrap_or(false) {
                return Ok(d);
            }
        }
    }
    if let Ok(devs) = host.output_devices() {
        for d in devs {
            if d.name().map(|n| n == name).unwrap_or(false) {
                return Ok(d);
            }
        }
    }
    Err(format!("Device not found: {name}"))
}

// ── Device enumeration helpers (for Tauri commands) ──────────────────────────

#[derive(Serialize, Clone)]
pub struct InputDeviceInfo {
    pub name: String,
    pub is_asio: bool,
    pub channels: u16,
    pub default_sample_rate: u32,
}

pub fn enumerate_input_devices() -> Vec<InputDeviceInfo> {
    let mut out = Vec::new();

    #[cfg(target_os = "windows")]
    if let Ok(asio_host) = cpal::host_from_id(cpal::HostId::Asio) {
        if let Ok(devs) = asio_host.input_devices() {
            for d in devs {
                let name = d.name().unwrap_or_default();
                let cfg = d.default_input_config().ok();
                out.push(InputDeviceInfo {
                    name,
                    is_asio: true,
                    channels: cfg.as_ref().map(|c| c.channels()).unwrap_or(0),
                    default_sample_rate: cfg.as_ref().map(|c| c.sample_rate().0).unwrap_or(0),
                });
            }
        }
    }

    let host = cpal::default_host();
    if let Ok(devs) = host.input_devices() {
        for d in devs {
            let name = d.name().unwrap_or_default();
            let cfg = d.default_input_config().ok();
            out.push(InputDeviceInfo {
                name,
                is_asio: false,
                channels: cfg.as_ref().map(|c| c.channels()).unwrap_or(0),
                default_sample_rate: cfg.as_ref().map(|c| c.sample_rate().0).unwrap_or(0),
            });
        }
    }
    out
}

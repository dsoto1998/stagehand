use std::io::Cursor;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use parking_lot::Mutex;
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink, Source};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

// Safety: OutputStream is !Send because cpal::Stream has thread affinity on some
// platforms. We store it solely to keep it alive — no methods are called on it
// after construction. The Mutex in EngineState prevents concurrent access.
struct SendStream(OutputStream);
unsafe impl Send for SendStream {}
unsafe impl Sync for SendStream {}

#[derive(Debug, Clone, Serialize)]
pub struct LoadResult {
    pub duration: f64,
    pub sample_rate: u32,
    pub peaks: Vec<f32>,
}

pub struct AudioEngine {
    _stream: SendStream,
    handle: OutputStreamHandle,
    // Arc shared with the progress thread so it can read position + detect end
    sink: Arc<Mutex<Option<Sink>>>,
    bytes: Mutex<Option<Vec<u8>>>,
    duration_us: Arc<AtomicU64>,
    is_playing: Arc<AtomicBool>,
}

impl AudioEngine {
    pub fn new(app: AppHandle) -> Result<Self, String> {
        let (stream, handle) = OutputStream::try_default()
            .map_err(|e| format!("Audio output init failed: {e}"))?;

        let sink_arc: Arc<Mutex<Option<Sink>>> = Arc::new(Mutex::new(None));
        let duration_us = Arc::new(AtomicU64::new(0));
        let is_playing = Arc::new(AtomicBool::new(false));

        // Spawn progress + end-detection thread (runs for app lifetime)
        {
            let sink = sink_arc.clone();
            let dur = duration_us.clone();
            let playing = is_playing.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(16));
                if !playing.load(Ordering::Relaxed) {
                    continue;
                }
                let guard = sink.lock();
                let (pos_us, ended) = match guard.as_ref() {
                    Some(s) if s.empty() => (0u64, true),
                    Some(s) => (s.get_pos().as_micros() as u64, false),
                    None => (0u64, false),
                };
                drop(guard);

                let dur_s = dur.load(Ordering::Relaxed) as f64 / 1_000_000.0;
                if dur_s <= 0.0 {
                    continue;
                }

                if ended {
                    playing.store(false, Ordering::SeqCst);
                    let _ = app.emit("playback_ended", serde_json::json!({}));
                } else {
                    let pos_s = pos_us as f64 / 1_000_000.0;
                    let _ = app.emit("playback_progress", serde_json::json!({
                        "position": pos_s,
                        "duration": dur_s,
                        "fraction": (pos_s / dur_s).min(1.0)
                    }));
                }
            });
        }

        Ok(Self {
            _stream: SendStream(stream),
            handle,
            sink: sink_arc,
            bytes: Mutex::new(None),
            duration_us,
            is_playing,
        })
    }

    pub fn load(&self, bytes: Vec<u8>) -> Result<LoadResult, String> {
        let (duration, sample_rate, peaks) = decode_info(&bytes, 600)?;
        self.duration_us.store((duration * 1_000_000.0) as u64, Ordering::SeqCst);
        *self.bytes.lock() = Some(bytes);
        Ok(LoadResult { duration, sample_rate, peaks })
    }

    pub fn play(&self, volume: f32) -> Result<(), String> {
        self.stop_sink();

        let bytes = self.bytes.lock().clone().ok_or("No track loaded")?;
        let sink = Sink::try_new(&self.handle).map_err(|e| e.to_string())?;
        sink.set_volume(volume);

        // Phase 2a: basic decode — no pitch/speed/seek yet
        let decoder = Decoder::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
        sink.append(decoder);

        *self.sink.lock() = Some(sink);
        self.is_playing.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn pause(&self) -> f64 {
        let guard = self.sink.lock();
        if let Some(s) = guard.as_ref() {
            let pos = s.get_pos().as_secs_f64();
            s.pause();
            self.is_playing.store(false, Ordering::SeqCst);
            return pos;
        }
        0.0
    }

    pub fn resume(&self) {
        let guard = self.sink.lock();
        if let Some(s) = guard.as_ref() {
            s.play();
            self.is_playing.store(true, Ordering::SeqCst);
        }
    }

    pub fn stop(&self) {
        self.stop_sink();
        self.is_playing.store(false, Ordering::SeqCst);
    }

    pub fn set_volume(&self, volume: f32) {
        let guard = self.sink.lock();
        if let Some(s) = guard.as_ref() {
            s.set_volume(volume);
        }
    }

    fn stop_sink(&self) {
        let mut guard = self.sink.lock();
        if let Some(sink) = guard.take() {
            sink.stop();
        }
    }
}

/// Decode audio bytes → (duration_secs, sample_rate, n_peaks amplitude values).
/// rodio 0.19 Decoder yields f32 samples.
fn decode_info(bytes: &[u8], n_peaks: usize) -> Result<(f64, u32, Vec<f32>), String> {
    let cursor = Cursor::new(bytes.to_vec());
    let decoder = Decoder::new(cursor).map_err(|e| format!("Decode error: {e}"))?;
    let sample_rate = decoder.sample_rate();
    let channels = decoder.channels() as usize;

    let samples: Vec<i16> = decoder.collect();
    let total_frames = samples.len() / channels.max(1);
    let duration = total_frames as f64 / sample_rate as f64;

    let frames_per_bucket = (total_frames / n_peaks).max(1);
    let mut peaks = Vec::with_capacity(n_peaks);
    for i in 0..n_peaks {
        let s = i * frames_per_bucket * channels;
        let e = ((i + 1) * frames_per_bucket * channels).min(samples.len());
        let peak = if s < samples.len() {
            samples[s..e].iter()
                .map(|v| v.unsigned_abs() as f32 / 32768.0)
                .fold(0.0f32, f32::max)
        } else {
            0.0
        };
        peaks.push(peak);
    }

    Ok((duration, sample_rate, peaks))
}

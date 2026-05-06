use std::io::Cursor;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::Duration;
use parking_lot::Mutex;
use rodio::{OutputStream, OutputStreamHandle, Sink, Source};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

// ── !Send OutputStream wrapper ───────────────────────────────────────────────
struct SendStream { _stream: OutputStream }
unsafe impl Send for SendStream {}
unsafe impl Sync for SendStream {}

// ── Rubberband C FFI ─────────────────────────────────────────────────────────
#[repr(C)]
struct RbOpaque {
    _private: [u8; 0],
}

extern "C" {
    fn rubberband_new(
        sample_rate: u32, channels: u32, options: i32,
        time_ratio: f64, pitch_scale: f64,
    ) -> *mut RbOpaque;
    fn rubberband_delete(state: *mut RbOpaque);
    fn rubberband_reset(state: *mut RbOpaque);
    fn rubberband_get_samples_required(state: *const RbOpaque) -> u32;
    fn rubberband_process(
        state: *mut RbOpaque, input: *const *const f32,
        samples: u32, r#final: i32,
    );
    fn rubberband_available(state: *const RbOpaque) -> i32;
    fn rubberband_retrieve(
        state: *const RbOpaque, output: *const *mut f32,
        samples: u32,
    ) -> u32;
}

const RB_OPT_REALTIME: i32 = 0x00000001;
const RB_OPT_THREADING_NEVER: i32 = 0x00010000;

struct RbHandle(*mut RbOpaque);
unsafe impl Send for RbHandle {}
impl Drop for RbHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { rubberband_delete(self.0); }
        }
    }
}

// ── Shared loop state (lock-free for audio thread) ───────────────────────────
pub struct LoopState {
    pub enabled: AtomicBool,
    pub start_us: AtomicU64,
    pub end_us: AtomicU64,
}

impl LoopState {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            enabled: AtomicBool::new(false),
            start_us: AtomicU64::new(0),
            end_us: AtomicU64::new(0),
        })
    }
}

// ── Pre-decoded audio buffer ─────────────────────────────────────────────────
pub(crate) struct DecodedAudio {
    pub samples: Vec<f32>,   // interleaved, all channels
    pub channels: u16,
    pub sample_rate: u32,
}

// ── Prefetch cache entry ──────────────────────────────────────────────────────
pub struct PrefetchEntry {
    pub track_id: String,
    pub raw_bytes: Arc<[u8]>,
    pub(crate) audio: Arc<DecodedAudio>,
    pub peaks: Vec<f32>,
    pub duration: f64,
}

impl PrefetchEntry {
    pub fn new(
        track_id: String,
        raw_bytes: Vec<u8>,
        samples: Vec<f32>,
        channels: u16,
        sample_rate: u32,
        peaks: Vec<f32>,
        duration: f64,
    ) -> Self {
        Self {
            track_id,
            raw_bytes: raw_bytes.into(),
            audio: Arc::new(DecodedAudio { samples, channels, sample_rate }),
            peaks,
            duration,
        }
    }
}

// ── Public API types ─────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize)]
pub struct LoadResult {
    pub duration: f64,
    pub sample_rate: u32,
    pub peaks: Vec<f32>,
}

// ── StreamingSource — symphonia-based immediate playback (no full pre-decode) ──
// Item = f32; works for all formats including M4A/AAC (rodio::Decoder panics on those).
struct StreamingSource {
    raw: Arc<[u8]>,
    format: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    channels: u16,
    sample_rate: u32,
    sample_buf: Vec<f32>,
    buf_pos: usize,
    current_frame: u64,
    frame_counter: Arc<AtomicU64>,
    ended: Arc<AtomicBool>,
    loop_state: Arc<LoopState>,
    inside_loop_region: bool,
}

unsafe impl Send for StreamingSource {}

impl StreamingSource {
    fn new(
        raw: Arc<[u8]>,
        offset_secs: f64,
        sample_rate: u32,
        channels: u16,
        loop_state: Arc<LoopState>,
        frame_counter: Arc<AtomicU64>,
        ended: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
        use symphonia::core::formats::FormatOptions;
        use symphonia::core::io::MediaSourceStream;
        use symphonia::core::meta::MetadataOptions;

        let hint = make_hint(&raw);
        let mss = MediaSourceStream::new(
            Box::new(Cursor::new((*raw).to_vec())),
            Default::default(),
        );
        let mut probed = symphonia::default::get_probe()
            .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
            .map_err(|e| format!("Probe failed: {e}"))?;

        let track = probed.format.tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or("No audio track found")?;

        let track_id = track.id;
        let sr = track.codec_params.sample_rate.unwrap_or(sample_rate);
        let ch = track.codec_params.channels.map(|c| c.count() as u16).unwrap_or(channels);

        let mut decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|e| format!("Codec init failed: {e}"))?;

        let start_frame = (offset_secs * sr as f64) as u64;
        if offset_secs > 0.0 {
            use symphonia::core::formats::{SeekMode, SeekTo};
            use symphonia::core::units::Time;
            let time = Time { seconds: offset_secs as u64, frac: offset_secs.fract() };
            let _ = probed.format.seek(SeekMode::Accurate, SeekTo::Time { time, track_id: None });
            decoder.reset();
        }

        frame_counter.store(start_frame, Ordering::SeqCst);
        ended.store(false, Ordering::SeqCst);

        Ok(Self {
            raw,
            format: probed.format,
            decoder,
            track_id,
            channels: ch,
            sample_rate: sr,
            sample_buf: Vec::new(),
            buf_pos: 0,
            current_frame: start_frame,
            frame_counter,
            ended,
            loop_state,
            inside_loop_region: false,
        })
    }

    fn seek_to(&mut self, secs: f64) {
        use symphonia::core::formats::{SeekMode, SeekTo};
        use symphonia::core::units::Time;
        let secs = secs.max(0.0);
        let time = Time { seconds: secs as u64, frac: secs.fract() };
        if self.format.seek(SeekMode::Accurate, SeekTo::Time { time, track_id: None }).is_ok() {
            self.decoder.reset();
        } else {
            // Rebuild reader from raw bytes (formats without a seek index)
            use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
            use symphonia::core::formats::FormatOptions;
            use symphonia::core::io::MediaSourceStream;
            use symphonia::core::meta::MetadataOptions;
            let hint = make_hint(&self.raw);
            let mss = MediaSourceStream::new(
                Box::new(Cursor::new((*self.raw).to_vec())),
                Default::default(),
            );
            if let Ok(mut probed) = symphonia::default::get_probe()
                .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
            {
                if let Some(track) = probed.format.tracks()
                    .iter()
                    .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
                {
                    if let Ok(dec) = symphonia::default::get_codecs()
                        .make(&track.codec_params, &DecoderOptions::default())
                    {
                        let _ = probed.format.seek(SeekMode::Accurate, SeekTo::Time { time, track_id: None });
                        self.format = probed.format;
                        self.decoder = dec;
                    }
                }
            }
        }
        self.sample_buf.clear();
        self.buf_pos = 0;
        self.current_frame = (secs * self.sample_rate as f64) as u64;
        self.frame_counter.store(self.current_frame, Ordering::SeqCst);
        self.inside_loop_region = false;
    }

    fn fill_buf(&mut self) -> bool {
        use symphonia::core::audio::SampleBuffer;
        use symphonia::core::errors::Error as SE;
        loop {
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(SE::IoError(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    return false;
                }
                Err(SE::ResetRequired) => { self.decoder.reset(); continue; }
                Err(_) => return false,
            };
            if packet.track_id() != self.track_id { continue; }
            match self.decoder.decode(&packet) {
                Ok(decoded) => {
                    let spec = *decoded.spec();
                    let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                    buf.copy_interleaved_ref(decoded);
                    self.sample_buf = buf.samples().to_vec();
                    self.buf_pos = 0;
                    return true;
                }
                Err(SE::DecodeError(_)) => continue,
                Err(_) => return false,
            }
        }
    }
}

impl Iterator for StreamingSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        // Loop boundary check
        if self.loop_state.enabled.load(Ordering::Relaxed) {
            let end_us = self.loop_state.end_us.load(Ordering::Relaxed);
            let end_frame = (end_us as f64 / 1_000_000.0 * self.sample_rate as f64) as u64;
            if end_frame > 0 {
                if self.current_frame < end_frame {
                    self.inside_loop_region = true;
                } else if self.inside_loop_region {
                    let start_us = self.loop_state.start_us.load(Ordering::Relaxed);
                    self.seek_to(start_us as f64 / 1_000_000.0);
                }
            }
        }

        // Refill buffer if exhausted
        if self.buf_pos >= self.sample_buf.len() {
            if !self.fill_buf() {
                if self.loop_state.enabled.load(Ordering::Relaxed) {
                    let start_us = self.loop_state.start_us.load(Ordering::Relaxed);
                    self.seek_to(start_us as f64 / 1_000_000.0);
                    self.inside_loop_region = false;
                    if !self.fill_buf() {
                        self.ended.store(true, Ordering::SeqCst);
                        return None;
                    }
                } else {
                    self.ended.store(true, Ordering::SeqCst);
                    return None;
                }
            }
        }

        let sample = self.sample_buf[self.buf_pos];
        self.buf_pos += 1;
        if self.channels > 0 && self.buf_pos % self.channels as usize == 0 {
            self.current_frame += 1;
            self.frame_counter.store(self.current_frame, Ordering::Relaxed);
        }
        Some(sample)
    }
}

impl Source for StreamingSource {
    fn current_frame_len(&self) -> Option<usize> { None }
    fn channels(&self) -> u16 { self.channels }
    fn sample_rate(&self) -> u32 { self.sample_rate }
    fn total_duration(&self) -> Option<Duration> { None }
}

// ── RubberbandSource — used when pitch/speed ≠ default, or after background decode ──
pub struct RubberbandSource {
    audio: Arc<DecodedAudio>,
    read_pos: usize,

    rb: Option<RbHandle>,
    input_done: bool,
    output_buf: Vec<f32>,
    out_pos: usize,

    loop_state: Arc<LoopState>,
    frame_counter: Arc<AtomicU64>,
    ended: Arc<AtomicBool>,
    inside_loop_region: bool,
}

unsafe impl Send for RubberbandSource {}

impl RubberbandSource {
    fn new(
        audio: Arc<DecodedAudio>,
        start_frame: usize,
        semitones: i32,
        speed: f64,
        loop_state: Arc<LoopState>,
        frame_counter: Arc<AtomicU64>,
        ended: Arc<AtomicBool>,
    ) -> Self {
        let ch = audio.channels as usize;
        let read_pos = (start_frame * ch).min(audio.samples.len());
        frame_counter.store(start_frame as u64, Ordering::SeqCst);
        ended.store(false, Ordering::SeqCst);

        let rb = if semitones != 0 || (speed - 1.0).abs() > 1e-4 {
            let pitch_scale = 2f64.powf(semitones as f64 / 12.0);
            let time_ratio = 1.0 / speed;
            let options = RB_OPT_REALTIME | RB_OPT_THREADING_NEVER;
            let ptr = unsafe {
                rubberband_new(audio.sample_rate, audio.channels as u32,
                               options, time_ratio, pitch_scale)
            };
            if ptr.is_null() { None } else { Some(RbHandle(ptr)) }
        } else {
            None
        };

        Self {
            audio,
            read_pos,
            rb,
            input_done: false,
            output_buf: Vec::new(),
            out_pos: 0,
            loop_state,
            frame_counter,
            ended,
            inside_loop_region: false,
        }
    }

    fn check_loop(&mut self) {
        if !self.loop_state.enabled.load(Ordering::Relaxed) { return; }
        let sr = self.audio.sample_rate as f64;
        let ch = (self.audio.channels as usize).max(1);
        let end_us = self.loop_state.end_us.load(Ordering::Relaxed);
        let end_sample = (end_us as f64 / 1_000_000.0 * sr) as usize * ch;
        if end_sample == 0 { return; }

        if self.read_pos < end_sample {
            self.inside_loop_region = true;
            return;
        }

        if !self.inside_loop_region { return; }

        let start_us = self.loop_state.start_us.load(Ordering::Relaxed);
        let start_sample = (start_us as f64 / 1_000_000.0 * sr) as usize * ch;
        self.read_pos = start_sample.min(self.audio.samples.len());
        let start_frame = start_sample / ch;
        self.frame_counter.store(start_frame as u64, Ordering::SeqCst);
        self.inside_loop_region = false;
        self.rb_reset();
    }

    fn rb_reset(&mut self) {
        if let Some(rb) = &self.rb {
            unsafe { rubberband_reset(rb.0); }
        }
        self.input_done = false;
        self.output_buf.clear();
        self.out_pos = 0;
    }

    fn handle_end(&mut self) {
        if self.loop_state.enabled.load(Ordering::Relaxed) {
            let sr = self.audio.sample_rate as f64;
            let ch = (self.audio.channels as usize).max(1);
            let start_us = self.loop_state.start_us.load(Ordering::Relaxed);
            let start_sample = (start_us as f64 / 1_000_000.0 * sr) as usize * ch;
            self.read_pos = start_sample.min(self.audio.samples.len());
            let start_frame = start_sample / ch;
            self.frame_counter.store(start_frame as u64, Ordering::SeqCst);
            self.rb_reset();
        } else {
            self.ended.store(true, Ordering::SeqCst);
        }
    }

    fn process_block(&mut self) {
        let rb_ptr = match &self.rb {
            Some(r) => r.0,
            None => return,
        };
        let ch = (self.audio.channels as usize).max(1);

        self.check_loop();

        if !self.input_done {
            let required = unsafe { rubberband_get_samples_required(rb_ptr) } as usize;
            let total = self.audio.samples.len();
            let avail_frames = total.saturating_sub(self.read_pos) / ch;

            if required == 0 && avail_frames > 0 {
                // RB has enough buffered; just retrieve
            } else {
                let feed_frames = required.min(avail_frames);
                let is_final = avail_frames <= required;

                if feed_frames > 0 {
                    let ch_bufs: Vec<Vec<f32>> = (0..ch)
                        .map(|c| {
                            (0..feed_frames)
                                .map(|f| self.audio.samples[self.read_pos + f * ch + c])
                                .collect()
                        })
                        .collect();
                    self.read_pos += feed_frames * ch;
                    // Track source position (not output frames) so position/fraction
                    // are correct at any playback speed.
                    self.frame_counter.store((self.read_pos / ch) as u64, Ordering::Relaxed);
                    let ptrs: Vec<*const f32> = ch_bufs.iter().map(|b| b.as_ptr()).collect();
                    unsafe {
                        rubberband_process(
                            rb_ptr, ptrs.as_ptr(), feed_frames as u32, is_final as i32,
                        );
                    }
                } else if is_final && avail_frames == 0 {
                    unsafe { rubberband_process(rb_ptr, std::ptr::null(), 0, 1); }
                }

                if is_final { self.input_done = true; }
            }
        }

        let avail = unsafe { rubberband_available(rb_ptr) };
        if avail > 0 {
            let avail = avail as usize;
            let mut out_bufs: Vec<Vec<f32>> = (0..ch).map(|_| vec![0.0f32; avail]).collect();
            let out_ptrs: Vec<*mut f32> = out_bufs.iter_mut().map(|b| b.as_mut_ptr()).collect();
            let got = unsafe {
                rubberband_retrieve(rb_ptr, out_ptrs.as_ptr(), avail as u32)
            } as usize;
            self.output_buf.clear();
            self.output_buf.reserve(got * ch);
            for f in 0..got {
                for c in 0..ch {
                    self.output_buf.push(out_bufs[c][f]);
                }
            }
            self.out_pos = 0;
        }
    }
}

impl Iterator for RubberbandSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        let ch = (self.audio.channels as usize).max(1);

        if self.rb.is_some() {
            for _ in 0..256u16 {
                if self.out_pos < self.output_buf.len() {
                    let sample = self.output_buf[self.out_pos];
                    self.out_pos += 1;
                    return Some(sample);
                }
                let rb_ptr = self.rb.as_ref().unwrap().0;
                if self.input_done && unsafe { rubberband_available(rb_ptr) } <= 0 {
                    self.handle_end();
                    if self.ended.load(Ordering::SeqCst) {
                        return None;
                    }
                }
                self.process_block();
            }
            None
        } else {
            loop {
                self.check_loop();
                if self.read_pos < self.audio.samples.len() { break; }
                self.handle_end();
                if self.ended.load(Ordering::SeqCst) { return None; }
            }
            let sample = self.audio.samples[self.read_pos];
            self.read_pos += 1;
            if self.read_pos % ch == 0 {
                self.frame_counter.fetch_add(1, Ordering::Relaxed);
            }
            Some(sample)
        }
    }
}

impl Source for RubberbandSource {
    fn current_frame_len(&self) -> Option<usize> { None }
    fn channels(&self) -> u16 { self.audio.channels }
    fn sample_rate(&self) -> u32 { self.audio.sample_rate }
    fn total_duration(&self) -> Option<Duration> { None }
}

// ── AudioEngine ───────────────────────────────────────────────────────────────
pub struct AudioEngine {
    _stream: SendStream,
    handle: OutputStreamHandle,
    sink: Arc<Mutex<Option<Sink>>>,
    // Raw compressed bytes — for streaming playback and Decoder reconstruction
    raw_bytes: Mutex<Option<Arc<[u8]>>>,
    // Fully decoded samples — populated by background decode thread after play starts
    pub(crate) decoded_slot: Arc<Mutex<Option<Arc<DecodedAudio>>>>,
    // Incremented on every new track load; background threads abort if stale
    decode_generation: Arc<AtomicU64>,
    duration_us: Arc<AtomicU64>,
    is_playing: Arc<AtomicBool>,
    loop_state: Arc<LoopState>,
    frame_counter: Arc<AtomicU64>,
    audio_sr: Arc<AtomicU32>,
    audio_ch: Arc<AtomicU32>,
    ended: Arc<AtomicBool>,
    pub prefetch: Arc<Mutex<Option<PrefetchEntry>>>,
    app: AppHandle,
}

impl AudioEngine {
    pub fn new(app: AppHandle) -> Result<Self, String> {
        let (stream, handle) = OutputStream::try_default()
            .map_err(|e| format!("Audio output init failed: {e}"))?;

        let sink_arc: Arc<Mutex<Option<Sink>>> = Arc::new(Mutex::new(None));
        let duration_us = Arc::new(AtomicU64::new(0));
        let is_playing = Arc::new(AtomicBool::new(false));
        let loop_state = LoopState::new();
        let frame_counter = Arc::new(AtomicU64::new(0));
        let audio_sr = Arc::new(AtomicU32::new(0));
        let audio_ch = Arc::new(AtomicU32::new(0));
        let ended = Arc::new(AtomicBool::new(false));
        let decoded_slot: Arc<Mutex<Option<Arc<DecodedAudio>>>> = Arc::new(Mutex::new(None));
        let decode_generation = Arc::new(AtomicU64::new(0));

        {
            let sink = sink_arc.clone();
            let dur = duration_us.clone();
            let playing = is_playing.clone();
            let counter = frame_counter.clone();
            let sr_arc = audio_sr.clone();
            let ended_flag = ended.clone();
            let app_progress = app.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(16));
                if !playing.load(Ordering::Relaxed) { continue; }

                let is_empty = sink.lock().as_ref().map_or(false, |s| s.empty());
                let dur_s = dur.load(Ordering::Relaxed) as f64 / 1_000_000.0;
                if dur_s <= 0.0 { continue; }

                if is_empty {
                    if ended_flag.load(Ordering::SeqCst) {
                        ended_flag.store(false, Ordering::SeqCst);
                        playing.store(false, Ordering::SeqCst);
                        let _ = app_progress.emit("playback_ended", serde_json::json!({}));
                    }
                } else {
                    let sr = sr_arc.load(Ordering::Relaxed);
                    let pos_s = if sr > 0 {
                        counter.load(Ordering::Relaxed) as f64 / sr as f64
                    } else { 0.0 };
                    let _ = app_progress.emit("playback_progress", serde_json::json!({
                        "position": pos_s,
                        "duration": dur_s,
                        "fraction": (pos_s / dur_s).min(1.0)
                    }));
                }
            });
        }

        Ok(Self {
            _stream: SendStream { _stream: stream },
            handle,
            sink: sink_arc,
            raw_bytes: Mutex::new(None),
            decoded_slot,
            decode_generation,
            duration_us,
            is_playing,
            loop_state,
            frame_counter,
            audio_sr,
            audio_ch,
            ended,
            prefetch: Arc::new(Mutex::new(None)),
            app,
        })
    }

    pub fn load(&self, bytes: Vec<u8>, track_id: Option<String>) -> Result<LoadResult, String> {
        self.load_impl(bytes, None, None, None, track_id)
    }

    pub fn load_cached(
        &self,
        bytes: Vec<u8>,
        peaks: Vec<f32>,
        duration: f64,
        sample_rate: u32,
        track_id: Option<String>,
    ) -> Result<LoadResult, String> {
        self.load_impl(bytes, Some(peaks), Some(duration), Some(sample_rate), track_id)
    }

    pub fn apply_prefetch_entry(&self, entry: PrefetchEntry) -> LoadResult {
        // Prefetch has both raw bytes and decoded audio — seek works instantly
        *self.raw_bytes.lock() = Some(Arc::clone(&entry.raw_bytes));
        *self.decoded_slot.lock() = Some(Arc::clone(&entry.audio));
        self.decode_generation.fetch_add(1, Ordering::SeqCst);
        self.duration_us.store((entry.duration * 1_000_000.0) as u64, Ordering::SeqCst);
        self.audio_sr.store(entry.audio.sample_rate, Ordering::SeqCst);
        self.audio_ch.store(entry.audio.channels as u32, Ordering::SeqCst);
        LoadResult {
            duration: entry.duration,
            sample_rate: entry.audio.sample_rate,
            peaks: entry.peaks,
        }
    }

    fn load_impl(
        &self,
        bytes: Vec<u8>,
        cached_peaks: Option<Vec<f32>>,
        cached_duration: Option<f64>,
        cached_sample_rate: Option<u32>,
        track_id: Option<String>,
    ) -> Result<LoadResult, String> {
        let raw: Arc<[u8]> = bytes.into();

        // Probe format for sr/channels/duration via symphonia (handles all formats, no panics).
        let (sample_rate, channels, duration) = {
            let (sr, ch, dur) = probe_symphonia(&raw)
                .map_err(|e| format!("Audio probe failed: {e}"))?;
            let sr = cached_sample_rate.unwrap_or(sr);
            let dur = cached_duration.unwrap_or(dur);
            (sr, ch, dur)
        };

        let peaks = cached_peaks.clone().unwrap_or_default();
        let emit_peaks = cached_peaks.is_none();

        // Store raw bytes; clear stale decoded audio
        *self.raw_bytes.lock() = Some(Arc::clone(&raw));
        *self.decoded_slot.lock() = None;
        let gen = self.decode_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.duration_us.store((duration * 1_000_000.0) as u64, Ordering::SeqCst);
        self.audio_sr.store(sample_rate, Ordering::SeqCst);
        self.audio_ch.store(channels as u32, Ordering::SeqCst);

        // Background: full decode for seek support + peaks/duration for new tracks
        let decoded_slot = Arc::clone(&self.decoded_slot);
        let gen_arc = Arc::clone(&self.decode_generation);
        let dur_arc = Arc::clone(&self.duration_us);
        let app_bg = self.app.clone();
        std::thread::spawn(move || {
            let bytes_vec: Vec<u8> = (*raw).to_vec();
            let Ok((samples, ch, sr)) = decode_to_samples(bytes_vec) else { return };
            if gen_arc.load(Ordering::SeqCst) != gen { return; }
            if ch == 0 || sr == 0 { return; }
            let total_frames = samples.len() / ch as usize;
            let bg_duration = total_frames as f64 / sr as f64;
            dur_arc.store((bg_duration * 1_000_000.0) as u64, Ordering::SeqCst);
            if emit_peaks {
                let bg_peaks = compute_peaks(&samples, ch as usize, 600);
                let _ = app_bg.emit("peaks_ready", serde_json::json!({
                    "track_id": track_id,
                    "duration": bg_duration,
                    "peaks": bg_peaks,
                }));
            }
            *decoded_slot.lock() = Some(Arc::new(DecodedAudio { samples, channels: ch, sample_rate: sr }));
            log::info!("[stagehand] background decode complete, dur={:.1}s", bg_duration);
        });

        log::info!("[stagehand] load_impl: streaming ready, duration={:.1}s, peaks_cached={}", duration, !emit_peaks);
        Ok(LoadResult { duration, sample_rate, peaks })
    }

    pub fn play_with_params(
        &self,
        offset_secs: f64,
        semitones: i32,
        speed: f64,
        volume: f32,
    ) -> Result<(), String> {
        self.stop_sink();
        self.ended.store(false, Ordering::SeqCst);

        let sr = self.audio_sr.load(Ordering::Relaxed);
        let ch = self.audio_ch.load(Ordering::Relaxed) as u16;
        if sr == 0 || ch == 0 {
            return Err("Audio format not ready (sample_rate or channels unknown)".into());
        }

        let use_rb = semitones != 0 || (speed - 1.0).abs() > 1e-4;

        if use_rb {
            // Need fully decoded audio — wait for background decode if in progress
            let decoded = {
                let d = self.decoded_slot.lock().clone();
                if let Some(d) = d {
                    d
                } else {
                    drop(d);
                    let mut waited_ms = 0u32;
                    loop {
                        std::thread::sleep(Duration::from_millis(50));
                        waited_ms += 50;
                        let d = self.decoded_slot.lock().clone();
                        if let Some(d) = d { break d; }
                        if waited_ms >= 5000 {
                            return Err("Audio decode timeout".into());
                        }
                    }
                }
            };
            let sr = decoded.sample_rate;
            let start_frame = (offset_secs * sr as f64) as usize;
            let source = RubberbandSource::new(
                decoded, start_frame, semitones, speed,
                self.loop_state.clone(), self.frame_counter.clone(), self.ended.clone(),
            );
            let sink = Sink::try_new(&self.handle).map_err(|e| e.to_string())?;
            sink.set_volume(volume);
            sink.append(source);
            *self.sink.lock() = Some(sink);
        } else {
            // Streaming mode — immediate, no decode wait
            let raw = self.raw_bytes.lock().clone().ok_or("No track loaded")?;
            // sr/ch already validated non-zero above
            // If decoded is already available, use RubberbandSource for instant seek support
            if let Some(decoded) = self.decoded_slot.lock().clone() {
                let start_frame = (offset_secs * decoded.sample_rate as f64) as usize;
                let source = RubberbandSource::new(
                    decoded, start_frame, 0, 1.0,
                    self.loop_state.clone(), self.frame_counter.clone(), self.ended.clone(),
                );
                let sink = Sink::try_new(&self.handle).map_err(|e| e.to_string())?;
                sink.set_volume(volume);
                sink.append(source);
                *self.sink.lock() = Some(sink);
            } else {
                // Try streaming first; if it fails (e.g. M4A — rodio 0.19 seek-at-init panic),
                // wait for the symphonia background decode and play from memory instead.
                let stream_result = StreamingSource::new(
                    Arc::clone(&raw), offset_secs, sr, ch,
                    self.loop_state.clone(), self.frame_counter.clone(), self.ended.clone(),
                );
                match stream_result {
                    Ok(source) => {
                        let sink = Sink::try_new(&self.handle).map_err(|e| e.to_string())?;
                        sink.set_volume(volume);
                        sink.append(source);
                        *self.sink.lock() = Some(sink);
                    }
                    Err(e) => {
                        log::info!("[stagehand] streaming failed ({e}), checking decoded slot");
                        if let Some(decoded) = self.decoded_slot.lock().clone() {
                            let start_frame = (offset_secs * decoded.sample_rate as f64) as usize;
                            let source = RubberbandSource::new(
                                decoded, start_frame, 0, 1.0,
                                self.loop_state.clone(), self.frame_counter.clone(), self.ended.clone(),
                            );
                            let sink = Sink::try_new(&self.handle).map_err(|e| e.to_string())?;
                            sink.set_volume(volume);
                            sink.append(source);
                            *self.sink.lock() = Some(sink);
                        } else {
                            // Background decode still in progress — caller must retry
                            return Err("decode_pending".into());
                        }
                    }
                }
            }
        }

        self.is_playing.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn play(&self, volume: f32, offset_secs: f64) -> Result<(), String> {
        self.play_with_params(offset_secs, 0, 1.0, volume)
    }

    pub fn seek(
        &self,
        offset_secs: f64,
        semitones: i32,
        speed: f64,
        volume: f32,
    ) -> Result<(), String> {
        self.play_with_params(offset_secs, semitones, speed, volume)
    }

    pub fn set_semitones(
        &self,
        semitones: i32,
        speed: f64,
        volume: f32,
    ) -> Result<(), String> {
        let pos = self.current_position_secs();
        self.play_with_params(pos, semitones, speed, volume)
    }

    pub fn set_speed(
        &self,
        speed: f64,
        semitones: i32,
        volume: f32,
    ) -> Result<(), String> {
        let pos = self.current_position_secs();
        self.play_with_params(pos, semitones, speed, volume)
    }

    pub fn set_loop(&self, enabled: bool, start_secs: f64, end_secs: f64) {
        self.loop_state.enabled.store(enabled, Ordering::Relaxed);
        self.loop_state.start_us.store((start_secs * 1_000_000.0) as u64, Ordering::Relaxed);
        self.loop_state.end_us.store((end_secs * 1_000_000.0) as u64, Ordering::Relaxed);
    }

    pub fn pause(&self) -> f64 {
        let pos = self.current_position_secs();
        let guard = self.sink.lock();
        if let Some(s) = guard.as_ref() {
            s.pause();
        }
        drop(guard);
        self.is_playing.store(false, Ordering::SeqCst);
        pos
    }

    pub fn resume(&self) {
        let guard = self.sink.lock();
        if let Some(s) = guard.as_ref() {
            s.play();
        }
        drop(guard);
        self.is_playing.store(true, Ordering::SeqCst);
    }

    pub fn stop(&self) {
        self.ended.store(false, Ordering::SeqCst);
        self.stop_sink();
        self.is_playing.store(false, Ordering::SeqCst);
    }

    pub fn set_volume(&self, volume: f32) {
        if let Some(s) = self.sink.lock().as_ref() {
            s.set_volume(volume);
        }
    }

    fn current_position_secs(&self) -> f64 {
        let sr = self.audio_sr.load(Ordering::Relaxed);
        if sr == 0 { return 0.0; }
        self.frame_counter.load(Ordering::Relaxed) as f64 / sr as f64
    }

    pub fn set_output_device(&mut self, name: &str, is_asio: bool) -> Result<(), String> {
        use cpal::traits::{DeviceTrait, HostTrait};
        self.stop_sink();

        #[cfg(target_os = "windows")]
        if is_asio {
            let asio_host = cpal::host_from_id(cpal::HostId::Asio)
                .map_err(|e| format!("ASIO host unavailable: {e}"))?;
            let device = asio_host
                .output_devices()
                .map_err(|e| format!("Cannot enumerate ASIO devices: {e}"))?
                .find(|d| d.name().map(|n| n == name).unwrap_or(false))
                .ok_or_else(|| format!("ASIO device not found: {name}"))?;
            let (stream, handle) = OutputStream::try_from_device(&device)
                .map_err(|e| format!("Cannot open ASIO device '{name}': {e}"))?;
            self._stream = SendStream { _stream: stream };
            self.handle = handle;
            return Ok(());
        }
        let _ = is_asio; // suppress unused warning on non-Windows

        let host = cpal::default_host();
        let device = if name.is_empty() {
            host.default_output_device()
                .ok_or_else(|| "No default output device".to_string())?
        } else {
            host.output_devices()
                .map_err(|e| format!("Cannot enumerate devices: {e}"))?
                .find(|d| d.name().map(|n| n == name).unwrap_or(false))
                .ok_or_else(|| format!("Device not found: {name}"))?
        };
        let (stream, handle) = OutputStream::try_from_device(&device)
            .map_err(|e| format!("Cannot open device '{name}': {e}"))?;
        self._stream = SendStream { _stream: stream };
        self.handle = handle;
        Ok(())
    }

    fn stop_sink(&self) {
        let mut guard = self.sink.lock();
        if let Some(sink) = guard.take() {
            sink.stop();
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Sniff bytes to build a Symphonia Hint. Detects M4A via `ftyp` box at offset 4.
fn make_hint(bytes: &[u8]) -> symphonia::core::probe::Hint {
    let mut hint = symphonia::core::probe::Hint::new();
    if bytes.len() >= 8 && &bytes[4..8] == b"ftyp" {
        hint.with_extension("m4a");
    }
    hint
}

/// Decode audio to interleaved f32 samples using Symphonia directly.
/// Bypasses rodio's Decoder, which panics on M4A/AAC (rodio 0.19 seek-at-init bug).
pub fn decode_to_samples(bytes: Vec<u8>) -> Result<(Vec<f32>, u16, u32), String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
    use symphonia::core::errors::Error as SE;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;

    let hint = make_hint(&bytes);
    let mss = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    let mut probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("Probe failed: {e}"))?;

    let track = probed.format.tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("No audio track found")?;

    let track_id = track.id;
    let sr = track.codec_params.sample_rate.unwrap_or(44100);
    let ch = track.codec_params.channels.map(|c| c.count() as u16).unwrap_or(2);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Codec init failed: {e}"))?;

    let mut samples: Vec<f32> = Vec::new();
    loop {
        let packet = match probed.format.next_packet() {
            Ok(p) => p,
            Err(SE::IoError(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SE::ResetRequired) => { decoder.reset(); continue; }
            Err(e) => return Err(format!("Packet error: {e}")),
        };
        if packet.track_id() != track_id { continue; }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SE::DecodeError(_)) => continue,
            Err(e) => return Err(format!("Decode error: {e}")),
        };
        let spec = *decoded.spec();
        let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buf.copy_interleaved_ref(decoded);
        samples.extend_from_slice(buf.samples());
    }

    if samples.is_empty() {
        return Err("Decoded zero samples — codec may not support this file".into());
    }

    Ok((samples, ch, sr))
}

/// Probe audio metadata (sample_rate, channels, duration) via Symphonia directly.
/// Used as fallback when rodio's Decoder::new() panics (M4A/AAC rodio 0.19 bug).
pub(crate) fn probe_symphonia(bytes: &[u8]) -> Result<(u32, u16, f64), String> {
    use symphonia::core::codecs::CODEC_TYPE_NULL;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;

    let hint = make_hint(bytes);
    let mss = MediaSourceStream::new(Box::new(Cursor::new(bytes.to_vec())), Default::default());
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("Symphonia probe failed: {e}"))?;

    let track = probed.format.tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("No audio track")?;

    let sr = track.codec_params.sample_rate.unwrap_or(44100);
    let ch = track.codec_params.channels.map(|c| c.count() as u16).unwrap_or(2);

    // Use time_base for correct duration when available (important for AAC/M4A).
    // time_base is typically 1/sample_rate, so the fallback n_frames/sr is equivalent.
    let dur = match (track.codec_params.n_frames, track.codec_params.time_base) {
        (Some(frames), Some(tb)) => frames as f64 * tb.numer as f64 / tb.denom as f64,
        (Some(frames), None) => frames as f64 / sr as f64,
        _ => 0.0,
    };

    Ok((sr, ch, dur))
}

pub fn compute_peaks(samples: &[f32], channels: usize, n: usize) -> Vec<f32> {
    let total_frames = samples.len() / channels.max(1);
    let bucket = (total_frames / n).max(1);
    (0..n)
        .map(|i| {
            let s = i * bucket * channels;
            let e = ((i + 1) * bucket * channels).min(samples.len());
            if s < samples.len() {
                samples[s..e].iter().map(|v| v.abs()).fold(0.0f32, f32::max)
            } else {
                0.0
            }
        })
        .collect()
}

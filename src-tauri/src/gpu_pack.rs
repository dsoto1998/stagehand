//! Optional "GPU pack" for guitar removal.
//!
//! The installer ships CPU-only torch inside the frozen sidecar (the CUDA build
//! is ~2GB more, and GitHub caps a release asset at 2GB). Users with an NVIDIA
//! GPU can opt in from Settings: we download the official PyTorch CUDA wheel for
//! the EXACT torch version frozen into the sidecar, verify its SHA-256, extract
//! the `torch` package into `<APPDATA>/gpu/<PACK_DIR>/`, and `stem_separate`
//! imports torch from there (`--torch-dir`) instead of its bundled CPU copy.
//!
//! The version pin must match `sidecar/requirements.txt` — the frozen build's
//! numpy/sympy/typing_extensions etc. are resolved against that torch version.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

pub const TORCH_VERSION: &str = "2.11.0+cu130";
const PACK_DIR: &str = "torch-2.11.0-cu130";
const WHEEL_URL: &str =
    "https://download.pytorch.org/whl/cu130/torch-2.11.0%2Bcu130-cp310-cp310-win_amd64.whl";
const WHEEL_SHA256: &str = "5b603a44f34816e18df254443a1fbfb4eef7d57128e5c7f6655f7fab45071f6e";
pub const WHEEL_SIZE: u64 = 1_915_188_422;
/// CUDA 13.0 needs an R580+ driver.
pub const MIN_DRIVER: f64 = 580.0;
/// Top-level wheel entries worth extracting (skip the .dist-info metadata).
const KEEP_TOP: [&str; 3] = ["torch", "functorch", "torchgen"];
/// Written once the pack passed the CUDA probe; holds the probe JSON.
const MARKER: &str = "INSTALLED.json";
const EXTRACTED: &str = ".extracted";

#[derive(Clone, Default, Serialize)]
pub struct Progress {
    pub installing: bool,
    /// downloading | verifying | extracting | probing | done | error
    pub stage: String,
    pub done: u64,
    pub total: u64,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct GpuPackState {
    progress: Arc<Mutex<Progress>>,
    cancel: Arc<AtomicBool>,
}

fn gpu_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("gpu"))
}

fn pack_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(gpu_root(app)?.join(PACK_DIR))
}

/// The torch dir `stem_separate --torch-dir` should use, if the pack is
/// installed and passed its CUDA probe.
pub fn active_torch_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = pack_dir(app).ok()?;
    dir.join(MARKER).exists().then_some(dir)
}

/// (gpu name, driver version) from nvidia-smi, if an NVIDIA driver is present.
pub fn detect_nvidia() -> Option<(String, String)> {
    let mut cmd = std::process::Command::new("nvidia-smi");
    cmd.args(["--query-gpu=name,driver_version", "--format=csv,noheader"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?.trim().to_string();
    let (name, driver) = line.rsplit_once(',')?;
    Some((name.trim().to_string(), driver.trim().to_string()))
}

impl GpuPackState {
    pub fn progress(&self) -> Progress {
        self.progress.lock().clone()
    }
}

pub fn status_json(app: &AppHandle, progress: Progress) -> serde_json::Value {
    let nvidia = detect_nvidia();
    let driver_ok = nvidia
        .as_ref()
        .and_then(|(_, d)| d.split('.').next()?.parse::<f64>().ok())
        .map(|major| major >= MIN_DRIVER);
    let probe = pack_dir(app)
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join(MARKER)).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    json!({
        "installed": probe.is_some(),
        "probe": probe,
        "progress": progress,
        "gpuName": nvidia.as_ref().map(|(n, _)| n.clone()),
        "driver": nvidia.as_ref().map(|(_, d)| d.clone()),
        "driverOk": driver_ok,
        "minDriver": MIN_DRIVER,
        "sizeBytes": WHEEL_SIZE,
        "torchVersion": TORCH_VERSION,
    })
}

pub fn start_install(app: AppHandle, state: &GpuPackState) -> Result<(), String> {
    {
        let mut p = state.progress.lock();
        if p.installing {
            return Ok(());
        }
        *p = Progress { installing: true, stage: "downloading".into(), total: WHEEL_SIZE, ..Default::default() };
    }
    state.cancel.store(false, Ordering::SeqCst);
    let progress = state.progress.clone();
    let cancel = state.cancel.clone();
    std::thread::Builder::new()
        .name("gpu-pack-install".into())
        .spawn(move || {
            let result = install(&app, &progress, &cancel);
            let mut p = progress.lock();
            p.installing = false;
            match result {
                Ok(()) => { p.stage = "done".into(); p.error = None; }
                Err(e) => {
                    log::warn!("[stagehand] gpu pack install failed: {e}");
                    p.stage = "error".into();
                    p.error = Some(e);
                }
            }
            let snapshot = p.clone();
            drop(p);
            let _ = app.emit("gpu_pack_progress", &snapshot);
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn cancel(state: &GpuPackState) {
    state.cancel.store(true, Ordering::SeqCst);
}

pub fn remove(app: &AppHandle, state: &GpuPackState) -> Result<(), String> {
    if state.progress.lock().installing {
        return Err("install in progress".into());
    }
    let root = gpu_root(app)?;
    if root.exists() {
        std::fs::remove_dir_all(&root).map_err(|e| format!("remove {}: {e}", root.display()))?;
    }
    *state.progress.lock() = Progress::default();
    Ok(())
}

fn report(app: &AppHandle, progress: &Arc<Mutex<Progress>>, stage: &str, done: u64, total: u64) {
    let snapshot = {
        let mut p = progress.lock();
        p.stage = stage.into();
        p.done = done;
        p.total = total;
        p.clone()
    };
    let _ = app.emit("gpu_pack_progress", &snapshot);
}

fn install(app: &AppHandle, progress: &Arc<Mutex<Progress>>, cancel: &AtomicBool) -> Result<(), String> {
    let root = gpu_root(app)?;
    let dir = pack_dir(app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    // A previous attempt may have extracted fine but failed the probe (e.g. an
    // old driver, since updated) — skip straight to re-probing.
    if !dir.join(EXTRACTED).exists() {
        let wheel = root.join("torch.whl.part");
        download(app, progress, cancel, &wheel)?;
        report(app, progress, "extracting", 0, 1);
        let tmp = root.join(format!("{PACK_DIR}.tmp"));
        let _ = std::fs::remove_dir_all(&tmp);
        extract(app, progress, cancel, &wheel, &tmp)?;
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::rename(&tmp, &dir).map_err(|e| format!("finalize: {e}"))?;
        std::fs::write(dir.join(EXTRACTED), TORCH_VERSION).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&wheel);
    }

    report(app, progress, "probing", 0, 1);
    let probe = probe(app, &dir)?;
    if probe.get("cuda").and_then(|v| v.as_bool()) != Some(true) {
        return Err(format!(
            "GPU pack installed, but CUDA is not available — update your NVIDIA driver to {MIN_DRIVER:.0} or newer, then retry"
        ));
    }
    std::fs::write(dir.join(MARKER), probe.to_string()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Resumable download with streaming SHA-256.
fn download(app: &AppHandle, progress: &Arc<Mutex<Progress>>, cancel: &AtomicBool, dest: &Path) -> Result<(), String> {
    let mut hasher = Sha256::new();
    let mut have = 0u64;
    if let Ok(mut f) = std::fs::File::open(dest) {
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = f.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            hasher.update(&buf[..n]);
            have += n as u64;
        }
    }

    if have < WHEEL_SIZE {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(20))
            .timeout_read(std::time::Duration::from_secs(60))
            .build();
        let mut req = agent.get(WHEEL_URL);
        if have > 0 {
            req = req.set("Range", &format!("bytes={have}-"));
        }
        let resp = req.call().map_err(|e| format!("download: {e}"))?;
        let mut file = if resp.status() == 206 {
            std::fs::OpenOptions::new().append(true).open(dest)
        } else {
            // Server ignored the Range — start over.
            hasher = Sha256::new();
            have = 0;
            std::fs::File::create(dest)
        }
        .map_err(|e| e.to_string())?;

        let mut reader = resp.into_reader();
        let mut buf = vec![0u8; 1 << 20];
        let mut last_emit = 0u64;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            let n = reader.read(&mut buf).map_err(|e| format!("download: {e}"))?;
            if n == 0 { break; }
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            hasher.update(&buf[..n]);
            have += n as u64;
            if have - last_emit >= 8 << 20 {
                last_emit = have;
                report(app, progress, "downloading", have, WHEEL_SIZE);
            }
        }
        file.flush().map_err(|e| e.to_string())?;
    }

    report(app, progress, "verifying", have, WHEEL_SIZE);
    let digest: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if digest != WHEEL_SHA256 {
        let _ = std::fs::remove_file(dest);
        return Err(format!("download corrupted (sha256 {digest}) — please retry"));
    }
    Ok(())
}

fn extract(app: &AppHandle, progress: &Arc<Mutex<Progress>>, cancel: &AtomicBool, wheel: &Path, out: &Path) -> Result<(), String> {
    let file = std::fs::File::open(wheel).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("open wheel: {e}"))?;
    let total = zip.len() as u64;
    for i in 0..zip.len() {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else { continue };
        let top = rel.components().next().and_then(|c| c.as_os_str().to_str()).unwrap_or("");
        if !KEEP_TOP.contains(&top) {
            continue;
        }
        let path = out.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut f = std::fs::File::create(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        std::io::copy(&mut entry, &mut f).map_err(|e| format!("{}: {e}", path.display()))?;
        if i % 200 == 0 {
            report(app, progress, "extracting", i as u64, total);
        }
    }
    Ok(())
}

/// Ask the sidecar itself whether it can import the pack and see CUDA.
fn probe(app: &AppHandle, torch_dir: &Path) -> Result<serde_json::Value, String> {
    let mut cmd = crate::click_track::sidecar_command(app, "stem_separate", "STAGEHAND_STEM_SEPARATE")?;
    cmd.arg("--probe").arg("--torch-dir").arg(torch_dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| format!("probe: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("probe failed").trim().to_string();
        return Err(format!("GPU pack check failed: {msg}"));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .find(|v| v.get("stage").and_then(|s| s.as_str()) == Some("probe"))
        .ok_or_else(|| "GPU pack check produced no result".to_string())
}

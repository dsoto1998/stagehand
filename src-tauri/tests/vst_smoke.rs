//! Live VST3 smoke test — exercises the per-plugin UI worker architecture against
//! a real installed plugin. Ignored by default (requires the plugin on disk and a
//! desktop session for the editor window).
//!
//! Run explicitly:
//!   cargo test --test vst_smoke -- --ignored --nocapture

use stagehand_lib::vst_host::VstHost;

const PLUGIN: &str = r"C:\Program Files\Common Files\VST3\Lindell 80 Channel.vst3";

#[test]
#[ignore]
fn worker_lifecycle_open_close_revive_sr() {
    if !std::path::Path::new(PLUGIN).exists() {
        eprintln!("SKIP: {PLUGIN} not installed");
        return;
    }

    // 1. Load on the persistent worker thread.
    let mut host = VstHost::spawn_and_load(PLUGIN, 48000.0).expect("spawn_and_load failed");
    let lat48 = host.latency_samples;
    eprintln!("loaded: {} latency={}smp @48k", host.name(), lat48);

    // 2. Open the editor via the worker; attached() must return kResultOk.
    let rx = host.request_open_gui().expect("request_open_gui send failed");
    rx.recv().expect("worker died").expect("attached() failed");
    assert!(host.is_gui_open(), "gui_open flag not set after open");
    eprintln!("editor opened OK");

    // Let the pump run briefly (renders a few frames).
    std::thread::sleep(std::time::Duration::from_millis(500));

    // 3. Close the editor; must complete (not hang) and clear the flag.
    let rx = host.request_close_gui().expect("close channel");
    rx.recv().expect("close reply lost");
    assert!(!host.is_gui_open(), "gui_open flag still set after close");
    eprintln!("editor closed OK");

    // 4. Simulate park→revive at a different sample rate (review fix #1).
    host.ensure_sample_rate(44100.0).expect("ensure_sample_rate failed");
    eprintln!("SR reconfigure 48k→44.1k OK, latency now {}smp", host.latency_samples);

    // 5. Editor must still open after the SR reconfigure.
    let rx = host.request_open_gui().expect("request_open_gui after SR change");
    rx.recv().expect("worker died").expect("attached() after SR change failed");
    eprintln!("editor re-opened after SR change OK");
    let rx = host.request_close_gui().expect("close channel");
    rx.recv().expect("close reply lost");

    // 6. No-op path: same SR must return without touching the plugin.
    host.ensure_sample_rate(44100.0).expect("no-op ensure_sample_rate failed");

    // 7. Drop = Exit + join worker + COM release + FreeLibrary. Must not hang.
    drop(host);
    eprintln!("drop clean — worker joined");
}

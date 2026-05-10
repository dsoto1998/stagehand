//! VST3 plugin host for Stagehand — Stage 1: load, instantiate, silence test.
//!
//! All unsafe code in this file; every unsafe block carries a one-line safety comment.
//! No unsafe code should exist elsewhere in the crate.
#![allow(non_snake_case, non_upper_case_globals, non_camel_case_types)]

use std::ffi::{c_char, c_void, CStr};
use std::mem::ManuallyDrop;
use std::path::Path;
use std::ptr;

use serde::Serialize;
use vst3::{
    com_scrape_types::{Class, ComWrapper, Interface},
    ComPtr,
    Steinberg::{
        kNotImplemented, kResultFalse, kResultOk,
        tresult,
        FIDString, FUnknown, IPlugFrame, IPlugFrameTrait, IPlugView, IPluginFactory,
        ViewRect, TUID,
        Vst::{
            AudioBusBuffers, AudioBusBuffers__type0, BusDirections_, IAudioProcessor,
            IAudioProcessorTrait, IComponent, IComponentHandler, IComponentHandlerTrait,
            IComponentTrait, IHostApplication, IHostApplicationTrait, MediaTypes_,
            ParamID, ParamValue, ProcessData, ProcessModes_,
            ProcessSetup, SpeakerArr, String128, SymbolicSampleSizes_,
        },
    },
};
use vst3::com_scrape_types::ComRef;
use vst3::Steinberg::{IPluginBaseTrait, IPluginFactoryTrait};
use vst3::Steinberg::int32;

// ── Block size constant ───────────────────────────────────────────────────────

const MAX_BLOCK_SIZE: i32 = 512;

// ── Win32 DLL loading (Windows only) ─────────────────────────────────────────

#[cfg(target_os = "windows")]
extern "system" {
    fn LoadLibraryW(lpLibFileName: *const u16) -> *mut c_void;
    fn GetProcAddress(hModule: *mut c_void, lpProcName: *const u8) -> *mut c_void;
    fn FreeLibrary(hModule: *mut c_void) -> i32;
}

type GetPluginFactoryFn = unsafe extern "system" fn() -> *mut IPluginFactory;

// ── String helpers ────────────────────────────────────────────────────────────

fn copy_wstring(src: &str, dst: &mut [u16]) {
    let mut len = 0;
    for (ch, slot) in src.encode_utf16().zip(dst.iter_mut()) {
        *slot = ch;
        len += 1;
    }
    if len < dst.len() {
        dst[len] = 0;
    } else if let Some(last) = dst.last_mut() {
        *last = 0;
    }
}

fn cstring_to_string(src: &[c_char]) -> String {
    // Safety: src is a null-terminated C string from the VST3 factory.
    unsafe {
        CStr::from_ptr(src.as_ptr())
            .to_string_lossy()
            .into_owned()
    }
}

// ── Host-side COM objects ─────────────────────────────────────────────────────

struct StagehandHostApp;

impl Class for StagehandHostApp {
    type Interfaces = (IHostApplication,);
}

impl IHostApplicationTrait for StagehandHostApp {
    unsafe fn getName(&self, name: *mut String128) -> tresult {
        // Identify this host to plugins that query the host name.
        copy_wstring("Stagehand", &mut *name);
        kResultOk
    }

    unsafe fn createInstance(
        &self,
        _cid: *mut TUID,
        _iid: *mut TUID,
        _obj: *mut *mut c_void,
    ) -> tresult {
        kNotImplemented
    }
}

struct StagehandCompHandler;

impl Class for StagehandCompHandler {
    type Interfaces = (IComponentHandler,);
}

impl IComponentHandlerTrait for StagehandCompHandler {
    unsafe fn beginEdit(&self, _id: ParamID) -> tresult {
        kResultOk
    }
    unsafe fn performEdit(&self, _id: ParamID, _value: ParamValue) -> tresult {
        kResultOk
    }
    unsafe fn endEdit(&self, _id: ParamID) -> tresult {
        kResultOk
    }
    unsafe fn restartComponent(&self, _flags: int32) -> tresult {
        kResultOk
    }
}

/// IPlugFrame stub — fully implemented in Stage 3 for GUI window resizing.
struct StagehandPlugFrame;

impl Class for StagehandPlugFrame {
    type Interfaces = (IPlugFrame,);
}

impl IPlugFrameTrait for StagehandPlugFrame {
    unsafe fn resizeView(&self, _view: *mut IPlugView, _newSize: *mut ViewRect) -> tresult {
        kResultOk
    }
}

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct VstPluginInfo {
    pub name: String,
    pub path: String,
}

// ── VstHost ───────────────────────────────────────────────────────────────────

/// Hosts a single VST3 plugin instance.
///
/// Fields are ordered to ensure correct drop sequence when `Drop::drop` runs:
/// ComPtrs must be released before `lib_handle` is freed.
/// `ManuallyDrop` wrappers give us explicit control over that sequence.
pub struct VstHost {
    lib_handle: *mut c_void,
    component: ManuallyDrop<ComPtr<IComponent>>,
    processor: ManuallyDrop<ComPtr<IAudioProcessor>>,
    pub latency_samples: u32,
    pub bypassed: bool,
    sample_rate: f64,
    // Preallocated planar block buffers — VST3 wants pointer-to-channel-pointers.
    in_l: Vec<f32>,
    in_r: Vec<f32>,
    out_l: Vec<f32>,
    out_r: Vec<f32>,
    // Keep host-side COM objects alive for the plugin's lifetime.
    _host_app: ComWrapper<StagehandHostApp>,
    _comp_handler: ComWrapper<StagehandCompHandler>,
}

// VstHost lives inside a parking_lot::Mutex in Tauri state — never accessed concurrently.
unsafe impl Send for VstHost {}
unsafe impl Sync for VstHost {}

impl VstHost {
    /// Scan `dir_path` for .vst3 bundles and return name + path for each found.
    pub fn scan(dir_path: &str) -> Vec<VstPluginInfo> {
        let mut results = Vec::new();
        let path = Path::new(dir_path);
        if !path.is_dir() {
            return results;
        }
        let entries = match std::fs::read_dir(path) {
            Ok(e) => e,
            Err(_) => return results,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            let ext = p.extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if ext != "vst3" {
                continue;
            }
            if resolve_dll_path(&p.to_string_lossy()).is_none() {
                continue;
            }
            let name = p.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            results.push(VstPluginInfo {
                name,
                path: p.to_string_lossy().into_owned(),
            });
        }
        results
    }

    /// Load a VST3 plugin from a .vst3 path (file or bundle directory).
    /// Returns an initialized, processing-ready VstHost or a descriptive error.
    pub fn load(path: &str, sample_rate: f64) -> Result<Self, String> {
        let dll_path = resolve_dll_path(path)
            .ok_or_else(|| format!("Cannot locate .vst3 DLL at: {path}"))?;

        // Safety: LoadLibraryW requires a valid null-terminated UTF-16 string;
        // `to_utf16_null` produces exactly that from a valid Rust str.
        let lib_handle = unsafe { win32_load_library(&dll_path)? };

        // Safety: GetProcAddress on "GetPluginFactory" is the standard VST3 DLL entry point.
        let factory_raw = unsafe { get_plugin_factory(lib_handle)? };

        // Wrap factory in ComRef — non-owning, won't call Release on drop.
        // Per VST3 convention many hosts never Release the factory; we do the same.
        // Safety: factory_raw is a valid IPluginFactory* returned by GetPluginFactory.
        let factory = unsafe {
            ComRef::<IPluginFactory>::from_raw(factory_raw)
                .ok_or("GetPluginFactory returned null")?
        };

        let (cid, _plugin_name) = unsafe { find_audio_class(&factory)? };

        // Safety: createInstance with a valid CID and IComponent IID returns a COM object
        // with refcount 1 per VST3 spec.
        let component = unsafe { create_component(&factory, &cid)? };

        // Query IAudioProcessor from the same object that implements IComponent.
        // Safety: queryInterface on a valid COM object is safe; None means not supported.
        let processor = component
            .cast::<IAudioProcessor>()
            .ok_or("Plugin does not implement IAudioProcessor")?;

        let host_app = ComWrapper::new(StagehandHostApp);
        let comp_handler = ComWrapper::new(StagehandCompHandler);

        // Get IHostApplication ComPtr to pass as FUnknown context to initialize().
        let host_com = host_app
            .to_com_ptr::<IHostApplication>()
            .ok_or("Failed to acquire IHostApplication interface")?;
        // Safety: IHostApplication inherits FUnknown; pointer cast preserves vtable layout.
        let host_raw = host_com.as_com_ref().as_ptr() as *mut FUnknown;

        // Safety: initialize() is required before any other IComponent call per VST3 spec.
        let res = unsafe { component.initialize(host_raw) };
        if res != kResultOk {
            unsafe { win32_free_library(lib_handle) };
            return Err(format!("IComponent::initialize failed: 0x{res:08X}"));
        }

        // Safety: setBusArrangements on a valid processor with stereo arrangement is safe.
        unsafe { setup_buses(&processor)? };

        // Safety: setupProcessing with positive sample_rate and MAX_BLOCK_SIZE is valid.
        unsafe { setup_processing(&processor, sample_rate)? };

        // Activate input + output audio buses. Required by VST3 spec before setActive;
        // many plugins (incl. Helix Native) reject setProcessing if buses are inactive.
        // Safety: activateBus on the index-0 audio bus that we previously configured stereo.
        unsafe {
            let _ = component.activateBus(
                MediaTypes_::kAudio,
                BusDirections_::kInput,
                0,
                1u8,
            );
            let _ = component.activateBus(
                MediaTypes_::kAudio,
                BusDirections_::kOutput,
                0,
                1u8,
            );
        }

        // VST3 lifecycle: setActive before setProcessing.
        // Safety: setActive(1) transitions component to active state per VST3 spec §4.3.
        let res = unsafe { component.setActive(1u8) };
        if res != kResultOk {
            unsafe { win32_free_library(lib_handle) };
            return Err(format!("IComponent::setActive failed: 0x{res:08X}"));
        }

        // Safety: setProcessing(1) enables audio processing per VST3 spec §4.3.
        // Plugins that don't track processing state may return kNotImplemented — accept it.
        let res = unsafe { processor.setProcessing(1u8) };
        if res != kResultOk && res != kResultFalse && res != kNotImplemented {
            unsafe { win32_free_library(lib_handle) };
            return Err(format!("IAudioProcessor::setProcessing failed: 0x{res:08X}"));
        }
        if res == kNotImplemented {
            log::info!("[vst] setProcessing returned kNotImplemented (plugin does not track state — OK)");
        }

        // Safety: getLatencySamples is valid after setupProcessing succeeds.
        let latency_samples = unsafe { processor.getLatencySamples() };

        log::info!(
            "[vst] loaded: {} — latency={}smp sr={:.0}Hz",
            _plugin_name,
            latency_samples,
            sample_rate
        );

        let block = MAX_BLOCK_SIZE as usize;
        Ok(Self {
            lib_handle,
            component: ManuallyDrop::new(component),
            processor: ManuallyDrop::new(processor),
            latency_samples,
            bypassed: false,
            sample_rate,
            in_l: vec![0.0; block],
            in_r: vec![0.0; block],
            out_l: vec![0.0; block],
            out_r: vec![0.0; block],
            _host_app: host_app,
            _comp_handler: comp_handler,
        })
    }

    /// Push one block of silence through the plugin.
    /// Stage 1 completion condition: returns Ok(()) without crash.
    pub fn process_test(&mut self) -> Result<(), String> {
        let n = MAX_BLOCK_SIZE as usize;
        let mut in_l = vec![0.0f32; n];
        let mut in_r = vec![0.0f32; n];
        let mut out_l = vec![0.0f32; n];
        let mut out_r = vec![0.0f32; n];

        let mut in_ptrs = [in_l.as_mut_ptr(), in_r.as_mut_ptr()];
        let mut out_ptrs = [out_l.as_mut_ptr(), out_r.as_mut_ptr()];

        let mut input_bus = AudioBusBuffers {
            numChannels: 2,
            silenceFlags: u64::MAX, // all channels flagged as silence
            __field0: AudioBusBuffers__type0 {
                channelBuffers32: in_ptrs.as_mut_ptr(),
            },
        };
        let mut output_bus = AudioBusBuffers {
            numChannels: 2,
            silenceFlags: 0,
            __field0: AudioBusBuffers__type0 {
                channelBuffers32: out_ptrs.as_mut_ptr(),
            },
        };

        let mut data = ProcessData {
            processMode: ProcessModes_::kRealtime,
            symbolicSampleSize: SymbolicSampleSizes_::kSample32,
            numSamples: MAX_BLOCK_SIZE,
            numInputs: 1,
            numOutputs: 1,
            inputs: &mut input_bus,
            outputs: &mut output_bus,
            inputParameterChanges: ptr::null_mut(),
            outputParameterChanges: ptr::null_mut(),
            inputEvents: ptr::null_mut(),
            outputEvents: ptr::null_mut(),
            processContext: ptr::null_mut(),
        };

        // Safety: process() with valid ProcessData; optional fields (params/events/context)
        // are null, which the VST3 spec permits when there are no parameter changes or events.
        let res = unsafe { self.processor.process(&mut data) };
        if res != kResultOk && res != kResultFalse {
            return Err(format!("IAudioProcessor::process failed: 0x{res:08X}"));
        }

        log::info!("[vst] process_test: OK (silence block passed through without crash)");
        Ok(())
    }

    pub fn get_latency(&self) -> u32 {
        self.latency_samples
    }

    pub fn set_bypass(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }

    /// Process a stereo interleaved block through the plugin.
    /// `input` and `output` must be equal length and a multiple of 2 frames.
    /// Block frame count must not exceed `MAX_BLOCK_SIZE` (caller responsibility).
    pub fn process_block(&mut self, input: &[f32], output: &mut [f32]) {
        let len = input.len().min(output.len());
        if self.bypassed || len == 0 {
            output[..len].copy_from_slice(&input[..len]);
            return;
        }

        let frames = len / 2;
        let max = MAX_BLOCK_SIZE as usize;
        if frames == 0 || frames > max {
            output[..len].copy_from_slice(&input[..len]);
            return;
        }

        // Deinterleave input L,R,L,R → planar L[..], R[..]. Zero remaining slots
        // so a partial block doesn't feed stale samples to the plugin.
        for i in 0..frames {
            self.in_l[i] = input[i * 2];
            self.in_r[i] = input[i * 2 + 1];
        }
        for i in frames..max {
            self.in_l[i] = 0.0;
            self.in_r[i] = 0.0;
        }
        for i in 0..max {
            self.out_l[i] = 0.0;
            self.out_r[i] = 0.0;
        }

        let mut in_ptrs = [self.in_l.as_mut_ptr(), self.in_r.as_mut_ptr()];
        let mut out_ptrs = [self.out_l.as_mut_ptr(), self.out_r.as_mut_ptr()];

        let mut input_bus = AudioBusBuffers {
            numChannels: 2,
            silenceFlags: 0,
            __field0: AudioBusBuffers__type0 { channelBuffers32: in_ptrs.as_mut_ptr() },
        };
        let mut output_bus = AudioBusBuffers {
            numChannels: 2,
            silenceFlags: 0,
            __field0: AudioBusBuffers__type0 { channelBuffers32: out_ptrs.as_mut_ptr() },
        };

        let mut data = ProcessData {
            processMode: ProcessModes_::kRealtime,
            symbolicSampleSize: SymbolicSampleSizes_::kSample32,
            // numSamples = ACTUAL frames in this call (≤ MAX_BLOCK_SIZE).
            // Telling the plugin a higher count makes it process trailing zeros and
            // corrupt its internal state (filter memory, reverb tails) → robotic output.
            numSamples: frames as i32,
            numInputs: 1,
            numOutputs: 1,
            inputs: &mut input_bus,
            outputs: &mut output_bus,
            inputParameterChanges: ptr::null_mut(),
            outputParameterChanges: ptr::null_mut(),
            inputEvents: ptr::null_mut(),
            outputEvents: ptr::null_mut(),
            processContext: ptr::null_mut(),
        };

        // Safety: process() with valid ProcessData; input/output buses point to
        // owned, properly-sized planar buffers; optional fields are null per VST3 spec.
        let res = unsafe { self.processor.process(&mut data) };
        if res != kResultOk && res != kResultFalse {
            // Plugin returned an error — fail safe to passthrough for this block.
            output[..len].copy_from_slice(&input[..len]);
            return;
        }

        // Reinterleave processed planar L/R → output L,R,L,R.
        for i in 0..frames {
            output[i * 2] = self.out_l[i];
            output[i * 2 + 1] = self.out_r[i];
        }
    }
}

impl Drop for VstHost {
    fn drop(&mut self) {
        // Tear down in reverse VST3 lifecycle order before releasing COM objects.
        // Safety: setProcessing(0) and setActive(0) are valid on an active processor/component.
        unsafe {
            let _ = self.processor.setProcessing(0u8);
            let _ = self.component.setActive(0u8);
            let _ = self.component.terminate();
        }

        // Explicitly release COM objects before FreeLibrary — the vtables live in the DLL.
        // Safety: each ManuallyDrop field has not been dropped yet; this is the only drop site.
        unsafe {
            ManuallyDrop::drop(&mut self.processor);
            ManuallyDrop::drop(&mut self.component);
        }

        // Now safe to unload the DLL — no more vtable references exist.
        // Safety: lib_handle is valid (non-null) and all COM objects referencing it are released.
        if !self.lib_handle.is_null() {
            unsafe { win32_free_library(self.lib_handle) };
        }
    }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/// Resolve the path to the actual DLL from a .vst3 path (file or bundle dir).
/// Windows VST3 bundles: `Name.vst3/Contents/x86_64-win/Name.dll`
/// Flat files: `Name.vst3` is itself the DLL.
pub fn resolve_dll_path(vst3_path: &str) -> Option<String> {
    let p = Path::new(vst3_path);

    if p.is_file() {
        // Flat .vst3 DLL
        return Some(vst3_path.to_owned());
    }

    if p.is_dir() {
        // Bundle: Contents/x86_64-win/*.dll
        let arch_dir = p.join("Contents").join("x86_64-win");
        if let Ok(entries) = std::fs::read_dir(&arch_dir) {
            for entry in entries.flatten() {
                let ep = entry.path();
                if ep.extension().map(|e| e == "dll").unwrap_or(false) {
                    return Some(ep.to_string_lossy().into_owned());
                }
            }
        }
    }

    None
}

/// Load a DLL by path and return the HMODULE, or an error string.
#[cfg(target_os = "windows")]
unsafe fn win32_load_library(path: &str) -> Result<*mut c_void, String> {
    // Encode as null-terminated UTF-16 for LoadLibraryW.
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    // Safety: wide is a valid null-terminated UTF-16 string allocated on the stack frame.
    let handle = LoadLibraryW(wide.as_ptr());
    if handle.is_null() {
        Err(format!("LoadLibraryW failed for: {path}"))
    } else {
        Ok(handle)
    }
}

#[cfg(not(target_os = "windows"))]
unsafe fn win32_load_library(_path: &str) -> Result<*mut c_void, String> {
    Err("VST3 hosting is only supported on Windows in this build".into())
}

#[cfg(target_os = "windows")]
unsafe fn win32_free_library(handle: *mut c_void) {
    // Safety: handle is a valid HMODULE previously returned by LoadLibraryW.
    FreeLibrary(handle);
}

#[cfg(not(target_os = "windows"))]
unsafe fn win32_free_library(_handle: *mut c_void) {}

/// Call GetPluginFactory and return the raw factory pointer.
#[cfg(target_os = "windows")]
unsafe fn get_plugin_factory(lib: *mut c_void) -> Result<*mut IPluginFactory, String> {
    // Safety: lib is a valid HMODULE; "GetPluginFactory" is the required VST3 DLL export.
    let proc = GetProcAddress(lib, b"GetPluginFactory\0".as_ptr());
    if proc.is_null() {
        return Err("DLL does not export GetPluginFactory — not a VST3 plugin".into());
    }
    // Safety: proc points to a function with the VST3-specified signature.
    let f: GetPluginFactoryFn = std::mem::transmute(proc);
    let factory = f();
    if factory.is_null() {
        Err("GetPluginFactory returned null".into())
    } else {
        Ok(factory)
    }
}

#[cfg(not(target_os = "windows"))]
unsafe fn get_plugin_factory(_lib: *mut c_void) -> Result<*mut IPluginFactory, String> {
    Err("VST3 hosting requires Windows".into())
}

/// Find the first "Audio Module Class" in the factory and return its CID and name.
unsafe fn find_audio_class(
    factory: &ComRef<IPluginFactory>,
) -> Result<(TUID, String), String> {
    let count = factory.countClasses();
    if count <= 0 {
        return Err("Plugin factory has no classes".into());
    }

    for i in 0..count {
        let mut info: vst3::Steinberg::PClassInfo = std::mem::zeroed();
        // Safety: getClassInfo fills info with valid data for index i < count.
        let res = factory.getClassInfo(i, &mut info);
        if res != kResultOk {
            continue;
        }
        let category = cstring_to_string(&info.category);
        if category == "Audio Module Class" {
            let name = cstring_to_string(&info.name);
            return Ok((info.cid, name));
        }
    }

    Err("No 'Audio Module Class' found in plugin factory".into())
}

/// Create an IComponent instance from the factory using the given class ID.
unsafe fn create_component(
    factory: &ComRef<IPluginFactory>,
    cid: &TUID,
) -> Result<ComPtr<IComponent>, String> {
    let mut obj: *mut c_void = ptr::null_mut();
    // Safety: createInstance with valid CID and IComponent IID; obj receives the new instance.
    let res = factory.createInstance(
        cid.as_ptr() as FIDString,
        IComponent::IID.as_ptr() as *const i8,
        &mut obj,
    );

    if res != kResultOk {
        return Err(format!("IPluginFactory::createInstance failed: 0x{res:08X}"));
    }
    if obj.is_null() {
        return Err("createInstance returned null object".into());
    }

    // Safety: obj is a valid IComponent* with refcount 1 per COM/VST3 convention.
    ComPtr::<IComponent>::from_raw(obj as *mut IComponent)
        .ok_or_else(|| "createInstance returned non-null but invalid pointer".into())
}

/// Configure stereo in / stereo out buses on the processor.
unsafe fn setup_buses(processor: &ComPtr<IAudioProcessor>) -> Result<(), String> {
    let mut in_arr = SpeakerArr::kStereo;
    let mut out_arr = SpeakerArr::kStereo;
    // Safety: setBusArrangements with valid stereo speaker arrangements.
    let res = processor.setBusArrangements(&mut in_arr, 1, &mut out_arr, 1);
    if res != kResultOk && res != kResultFalse {
        return Err(format!(
            "IAudioProcessor::setBusArrangements failed: 0x{res:08X}"
        ));
    }
    Ok(())
}

/// Call setupProcessing with the given sample rate and MAX_BLOCK_SIZE.
unsafe fn setup_processing(
    processor: &ComPtr<IAudioProcessor>,
    sample_rate: f64,
) -> Result<(), String> {
    let mut setup = ProcessSetup {
        processMode: ProcessModes_::kRealtime,
        symbolicSampleSize: SymbolicSampleSizes_::kSample32,
        maxSamplesPerBlock: MAX_BLOCK_SIZE,
        sampleRate: sample_rate,
    };
    // Safety: setupProcessing with a valid ProcessSetup struct.
    let res = processor.setupProcessing(&mut setup);
    if res != kResultOk && res != kResultFalse {
        return Err(format!(
            "IAudioProcessor::setupProcessing failed: 0x{res:08X}"
        ));
    }
    Ok(())
}

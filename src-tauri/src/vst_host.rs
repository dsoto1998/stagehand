//! VST3 plugin host for Stagehand — Stage 1: load, instantiate, silence test.
//!
//! All unsafe code in this file; every unsafe block carries a one-line safety comment.
//! No unsafe code should exist elsewhere in the crate.
#![allow(non_snake_case, non_upper_case_globals, non_camel_case_types)]

use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::mem::ManuallyDrop;
use std::path::Path;
use std::ptr;
use std::sync::Arc;
use std::sync::Once;

use parking_lot::Mutex;
use serde::Serialize;
use vst3::{
    com_scrape_types::{Class, ComWrapper, Interface},
    ComPtr,
    Steinberg::{
        kInvalidArgument, kNotImplemented, kPlatformTypeHWND, kResultFalse, kResultOk,
        tresult,
        FIDString, FUnknown, IBStream, IBStreamTrait, IBStream_::IStreamSeekMode_,
        IPlugFrame, IPlugFrameTrait, IPlugView, IPlugViewTrait, IPluginFactory,
        ViewRect, TUID,
        Vst::{
            AudioBusBuffers, AudioBusBuffers__type0, BusDirections_, IAttributeList,
            IAttributeListTrait, IAttributeList_::AttrID, IAudioProcessor,
            IAudioProcessorTrait, IComponent, IComponentHandler, IComponentHandlerTrait,
            IComponentTrait, IConnectionPoint, IConnectionPointTrait, IEditController,
            IEditControllerTrait, IHostApplication, IHostApplicationTrait, IMessage,
            IMessageTrait, MediaTypes_, ParamID, ParamValue, ProcessData, ProcessModes_,
            ProcessSetup, SpeakerArr, String128, SymbolicSampleSizes_, TChar, ViewType,
        },
    },
};
use vst3::com_scrape_types::ComRef;
use vst3::Steinberg::{IPluginBaseTrait, IPluginFactoryTrait};
use vst3::Steinberg::{int32, int64};

// ── Block size constant ───────────────────────────────────────────────────────

const MAX_BLOCK_SIZE: i32 = 512;

// ── Win32 DLL loading (Windows only) ─────────────────────────────────────────

#[cfg(target_os = "windows")]
extern "system" {
    fn LoadLibraryW(lpLibFileName: *const u16) -> *mut c_void;
    fn GetProcAddress(hModule: *mut c_void, lpProcName: *const u8) -> *mut c_void;
    fn FreeLibrary(hModule: *mut c_void) -> i32;
    fn SetUnhandledExceptionFilter(filter: ExceptionFilterFn) -> ExceptionFilterFn;
    fn GetModuleFileNameW(hModule: *mut c_void, lpFilename: *mut u16, nSize: u32) -> u32;
    fn GetModuleHandleExW(flags: u32, lpModuleName: *const u16, hModule: *mut *mut c_void) -> i32;
}

#[cfg(target_os = "windows")]
type ExceptionFilterFn = unsafe extern "system" fn(*mut EXCEPTION_POINTERS) -> i32;

#[cfg(target_os = "windows")]
#[repr(C)]
struct EXCEPTION_POINTERS {
    exception_record: *mut EXCEPTION_RECORD,
    context_record: *mut c_void,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct EXCEPTION_RECORD {
    exception_code: u32,
    exception_flags: u32,
    exception_record: *mut EXCEPTION_RECORD,
    exception_address: *mut c_void,
    number_parameters: u32,
    exception_information: [usize; 15],
}

#[cfg(target_os = "windows")]
const GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS: u32 = 0x00000004;
#[cfg(target_os = "windows")]
const GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT: u32 = 0x00000002;
#[cfg(target_os = "windows")]
const EXCEPTION_CONTINUE_SEARCH: i32 = 0;

/// Unhandled exception filter — logs the faulting address + module name to stderr
/// before the process dies. Helps identify whether the crash is in our code or
/// inside a plugin DLL.
#[cfg(target_os = "windows")]
unsafe extern "system" fn crash_filter(info: *mut EXCEPTION_POINTERS) -> i32 {
    if info.is_null() || (*info).exception_record.is_null() {
        eprintln!("[vst] CRASH: unknown exception (null info)");
        return EXCEPTION_CONTINUE_SEARCH;
    }
    let rec = &*(*info).exception_record;
    let code = rec.exception_code;
    let addr = rec.exception_address;

    let mut module: *mut c_void = ptr::null_mut();
    let mut module_name = String::from("(unknown)");
    if GetModuleHandleExW(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        addr as *const u16,
        &mut module,
    ) != 0
        && !module.is_null()
    {
        let mut name_buf = [0u16; 512];
        let len = GetModuleFileNameW(module, name_buf.as_mut_ptr(), name_buf.len() as u32);
        if len > 0 {
            module_name = String::from_utf16_lossy(&name_buf[..len as usize]);
        }
    }

    eprintln!(
        "[vst] CRASH: code=0x{code:08X} addr={addr:p} module={module_name}"
    );
    log::error!(
        "[vst] CRASH: code=0x{code:08X} addr={addr:p} module={module_name}"
    );
    EXCEPTION_CONTINUE_SEARCH
}

/// Install the crash filter once per process.
#[cfg(target_os = "windows")]
fn install_crash_filter() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        SetUnhandledExceptionFilter(crash_filter);
    });
}

#[cfg(not(target_os = "windows"))]
fn install_crash_filter() {}

type GetPluginFactoryFn = unsafe extern "system" fn() -> *mut IPluginFactory;

// ── Win32 GUI FFI (Stage 3 — floating plugin window) ─────────────────────────

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Clone, Copy)]
struct RECT {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct WNDCLASSEXW {
    cbSize: u32,
    style: u32,
    lpfnWndProc: WndProc,
    cbClsExtra: i32,
    cbWndExtra: i32,
    hInstance: *mut c_void,
    hIcon: *mut c_void,
    hCursor: *mut c_void,
    hbrBackground: *mut c_void,
    lpszMenuName: *const u16,
    lpszClassName: *const u16,
    hIconSm: *mut c_void,
}

#[cfg(target_os = "windows")]
type WndProc =
    unsafe extern "system" fn(hwnd: *mut c_void, msg: u32, wparam: usize, lparam: isize) -> isize;

#[cfg(target_os = "windows")]
extern "system" {
    fn CreateWindowExW(
        dwExStyle: u32,
        lpClassName: *const u16,
        lpWindowName: *const u16,
        dwStyle: u32,
        x: i32,
        y: i32,
        nWidth: i32,
        nHeight: i32,
        hWndParent: *mut c_void,
        hMenu: *mut c_void,
        hInstance: *mut c_void,
        lpParam: *mut c_void,
    ) -> *mut c_void;
    fn DestroyWindow(hwnd: *mut c_void) -> i32;
    fn SetWindowPos(
        hwnd: *mut c_void,
        hwnd_after: *mut c_void,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
    fn ShowWindow(hwnd: *mut c_void, cmd: i32) -> i32;
    fn GetModuleHandleW(name: *const u16) -> *mut c_void;
    fn RegisterClassExW(class: *const WNDCLASSEXW) -> u16;
    fn DefWindowProcW(hwnd: *mut c_void, msg: u32, wparam: usize, lparam: isize) -> isize;
    fn AdjustWindowRectEx(rect: *mut RECT, style: u32, menu: i32, ex_style: u32) -> i32;
    fn LoadCursorW(instance: *mut c_void, name: *const u16) -> *mut c_void;
}

#[cfg(target_os = "windows")]
const WS_OVERLAPPEDWINDOW: u32 = 0x00CF0000;
#[cfg(target_os = "windows")]
const SW_SHOW: i32 = 5;
#[cfg(target_os = "windows")]
const SWP_NOMOVE: u32 = 0x0002;
#[cfg(target_os = "windows")]
const SWP_NOZORDER: u32 = 0x0004;
#[cfg(target_os = "windows")]
const SWP_NOACTIVATE: u32 = 0x0010;
#[cfg(target_os = "windows")]
const IDC_ARROW: usize = 32512;

#[cfg(target_os = "windows")]
static REGISTER_CLASS_ONCE: Once = Once::new();

/// Register the StagehandVstHost window class once per process.
#[cfg(target_os = "windows")]
fn ensure_window_class_registered() {
    REGISTER_CLASS_ONCE.call_once(|| {
        let class_name: Vec<u16> = "StagehandVstHost"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // Safety: GetModuleHandleW(null) returns the current process module handle.
        let hinstance = unsafe { GetModuleHandleW(ptr::null()) };
        // Safety: LoadCursorW with IDC_ARROW returns the standard arrow cursor.
        let cursor = unsafe { LoadCursorW(ptr::null_mut(), IDC_ARROW as *const u16) };
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: 0,
            lpfnWndProc: DefWindowProcW,
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: ptr::null_mut(),
            hCursor: cursor,
            hbrBackground: ptr::null_mut(),
            lpszMenuName: ptr::null(),
            lpszClassName: class_name.as_ptr(),
            hIconSm: ptr::null_mut(),
        };
        // Safety: WNDCLASSEXW is fully initialized; class_name lives until call returns.
        let atom = unsafe { RegisterClassExW(&class) };
        if atom == 0 {
            log::warn!("[vst] RegisterClassExW failed for StagehandVstHost class");
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn ensure_window_class_registered() {}

/// Create a top-level floating window owned by `parent_hwnd`. Returns the new HWND.
#[cfg(target_os = "windows")]
unsafe fn create_floating_window(
    parent_hwnd: *mut c_void,
    client_w: i32,
    client_h: i32,
) -> Result<*mut c_void, String> {
    let class_name: Vec<u16> = "StagehandVstHost"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let title: Vec<u16> = "VST Plugin".encode_utf16().chain(std::iter::once(0)).collect();

    // Adjust client size to total window size (account for chrome).
    let mut rect = RECT { left: 0, top: 0, right: client_w, bottom: client_h };
    AdjustWindowRectEx(&mut rect, WS_OVERLAPPEDWINDOW, 0, 0);
    let total_w = rect.right - rect.left;
    let total_h = rect.bottom - rect.top;

    let hinstance = GetModuleHandleW(ptr::null());

    // Safety: class is registered, parent is a valid HWND or null, sizes are positive.
    let hwnd = CreateWindowExW(
        0,
        class_name.as_ptr(),
        title.as_ptr(),
        WS_OVERLAPPEDWINDOW,
        100, // CW_USEDEFAULT could be -2147483648; explicit position keeps it predictable
        100,
        total_w,
        total_h,
        parent_hwnd,
        ptr::null_mut(),
        hinstance,
        ptr::null_mut(),
    );
    if hwnd.is_null() {
        return Err("CreateWindowExW failed for plugin GUI container".into());
    }
    Ok(hwnd)
}

#[cfg(not(target_os = "windows"))]
unsafe fn create_floating_window(
    _parent_hwnd: *mut c_void,
    _client_w: i32,
    _client_h: i32,
) -> Result<*mut c_void, String> {
    Err("Plugin GUI is Windows-only in this build".into())
}

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
        iid: *mut TUID,
        obj: *mut *mut c_void,
    ) -> tresult {
        if iid.is_null() || obj.is_null() {
            return kInvalidArgument;
        }
        let iid_bytes = &*(iid as *const [i8; 16]);

        // IMessage — required for plugins that use IConnectionPoint::notify (incl. Helix).
        if tuid_eq_to_iid(iid_bytes, IMessage::IID.as_ptr()) {
            let msg = ComWrapper::new(StagehandMessage::new());
            if let Some(p) = msg.to_com_ptr::<IMessage>() {
                *obj = p.into_raw() as *mut c_void;
                return kResultOk;
            }
        }
        // IAttributeList — sometimes requested directly without wrapping IMessage.
        if tuid_eq_to_iid(iid_bytes, IAttributeList::IID.as_ptr()) {
            let attrs = ComWrapper::new(StagehandAttributeList::new());
            if let Some(p) = attrs.to_com_ptr::<IAttributeList>() {
                *obj = p.into_raw() as *mut c_void;
                return kResultOk;
            }
        }

        // Log unhandled interface requests so we know what else to implement.
        let iid_hex = format!("{:02X?}", iid_bytes.map(|b| b as u8));
        log::warn!("[vst] HostApp.createInstance unsupported iid={iid_hex} — returning kNotImplemented");
        kNotImplemented
    }
}

/// Compare TUID bytes against an Interface IID (Guid). TUID is `[i8; 16]`,
/// Guid is `[u8; 16]` — same memory layout, just a sign reinterpret.
fn tuid_eq_to_iid(tuid: &[i8; 16], iid: *const u8) -> bool {
    // Safety: iid points to a 16-byte Guid constant.
    unsafe {
        for i in 0..16 {
            if tuid[i] as u8 != *iid.add(i) {
                return false;
            }
        }
    }
    true
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

/// IPlugFrame implementation — receives resize requests from the plugin's view.
/// Holds a shared reference to the floating window's HWND so it can resize that
/// window when the plugin requests a different size.
///
/// `container_hwnd` is filled by `VstHost::open_gui` after CreateWindowExW and
/// cleared by `close_gui`/Drop. `try_lock` ensures the plugin's UI thread never
/// blocks waiting for the host.
struct StagehandPlugFrame {
    container_hwnd: Arc<Mutex<Option<usize>>>, // store as usize so the Arc is Send + Sync
}

impl Class for StagehandPlugFrame {
    type Interfaces = (IPlugFrame,);
}

impl IPlugFrameTrait for StagehandPlugFrame {
    unsafe fn resizeView(&self, _view: *mut IPlugView, newSize: *mut ViewRect) -> tresult {
        if newSize.is_null() {
            return kResultOk;
        }
        let r = &*newSize;
        let w = r.right - r.left;
        let h = r.bottom - r.top;

        #[cfg(target_os = "windows")]
        {
            if let Some(guard) = self.container_hwnd.try_lock() {
                if let Some(hwnd_usize) = *guard {
                    let hwnd = hwnd_usize as *mut c_void;
                    // Convert client size → total window size (chrome).
                    let mut rect = RECT { left: 0, top: 0, right: w, bottom: h };
                    AdjustWindowRectEx(&mut rect, WS_OVERLAPPEDWINDOW, 0, 0);
                    let total_w = rect.right - rect.left;
                    let total_h = rect.bottom - rect.top;
                    SetWindowPos(
                        hwnd,
                        ptr::null_mut(),
                        0,
                        0,
                        total_w,
                        total_h,
                        SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
                    );
                }
            }
        }
        kResultOk
    }
}

/// Minimal in-memory IBStream backed by a Vec<u8>.
/// Used for component → controller state transfer (and Stage 4 preset persistence).
struct MemoryStream {
    buf: Mutex<MemoryStreamInner>,
}

struct MemoryStreamInner {
    data: Vec<u8>,
    pos: usize,
}

impl MemoryStream {
    fn new() -> Self {
        Self {
            buf: Mutex::new(MemoryStreamInner { data: Vec::new(), pos: 0 }),
        }
    }
    fn rewind(&self) {
        self.buf.lock().pos = 0;
    }
    fn into_bytes(self) -> Vec<u8> {
        self.buf.into_inner().data
    }
    fn from_bytes(bytes: Vec<u8>) -> Self {
        Self {
            buf: Mutex::new(MemoryStreamInner { data: bytes, pos: 0 }),
        }
    }
}

impl Class for MemoryStream {
    type Interfaces = (IBStream,);
}

impl IBStreamTrait for MemoryStream {
    unsafe fn read(
        &self,
        buffer: *mut c_void,
        numBytes: int32,
        numBytesRead: *mut int32,
    ) -> tresult {
        if buffer.is_null() || numBytes < 0 {
            return kResultFalse;
        }
        let mut g = self.buf.lock();
        let n = (g.data.len().saturating_sub(g.pos)).min(numBytes as usize);
        if n > 0 {
            // Safety: buffer points to at least numBytes ≥ n bytes per caller contract.
            std::ptr::copy_nonoverlapping(g.data.as_ptr().add(g.pos), buffer as *mut u8, n);
            g.pos += n;
        }
        if !numBytesRead.is_null() {
            *numBytesRead = n as int32;
        }
        kResultOk
    }

    unsafe fn write(
        &self,
        buffer: *mut c_void,
        numBytes: int32,
        numBytesWritten: *mut int32,
    ) -> tresult {
        if buffer.is_null() || numBytes < 0 {
            return kResultFalse;
        }
        let n = numBytes as usize;
        let mut g = self.buf.lock();
        // Grow vec to hold pos + n bytes.
        let needed = g.pos + n;
        if g.data.len() < needed {
            g.data.resize(needed, 0);
        }
        // Safety: buffer points to at least n readable bytes per caller contract.
        let pos = g.pos;
        std::ptr::copy_nonoverlapping(buffer as *const u8, g.data.as_mut_ptr().add(pos), n);
        g.pos += n;
        if !numBytesWritten.is_null() {
            *numBytesWritten = n as int32;
        }
        kResultOk
    }

    unsafe fn seek(&self, pos: int64, mode: int32, result: *mut int64) -> tresult {
        let mut g = self.buf.lock();
        let new_pos: i64 = match mode {
            m if m == IStreamSeekMode_::kIBSeekSet => pos,
            m if m == IStreamSeekMode_::kIBSeekCur => g.pos as i64 + pos,
            m if m == IStreamSeekMode_::kIBSeekEnd => g.data.len() as i64 + pos,
            _ => return kResultFalse,
        };
        if new_pos < 0 {
            return kResultFalse;
        }
        g.pos = new_pos as usize;
        if !result.is_null() {
            *result = new_pos;
        }
        kResultOk
    }

    unsafe fn tell(&self, pos: *mut int64) -> tresult {
        if pos.is_null() {
            return kResultFalse;
        }
        *pos = self.buf.lock().pos as int64;
        kResultOk
    }
}

// ── IAttributeList + IMessage (host-provided per VST3 spec §3.5) ──────────────
// Helix Native (and most plugins with separate component+controller) calls
// host.createInstance(IMessage::IID) to allocate messages it sends via
// IConnectionPoint::notify(). Returning kNotImplemented makes plugin deref a
// null pointer → STATUS_ACCESS_VIOLATION.

#[derive(Clone)]
enum AttrValue {
    Int(i64),
    Float(f64),
    Wstr(Vec<u16>),
    Bin(Vec<u8>),
}

struct StagehandAttributeList {
    attrs: Mutex<HashMap<Vec<u8>, AttrValue>>,
    /// Storage for the most recent getBinary result so the returned pointer stays valid
    /// until the next call. Plugins typically copy the bytes immediately.
    last_binary_out: Mutex<Vec<u8>>,
}

impl StagehandAttributeList {
    fn new() -> Self {
        Self {
            attrs: Mutex::new(HashMap::new()),
            last_binary_out: Mutex::new(Vec::new()),
        }
    }
}

impl Class for StagehandAttributeList {
    type Interfaces = (IAttributeList,);
}

unsafe fn cstr_key(id: AttrID) -> Vec<u8> {
    if id.is_null() {
        return Vec::new();
    }
    CStr::from_ptr(id).to_bytes().to_vec()
}

unsafe fn wstr_len(s: *const TChar) -> usize {
    let mut n = 0;
    while !s.is_null() && *s.add(n) != 0 {
        n += 1;
    }
    n
}

impl IAttributeListTrait for StagehandAttributeList {
    unsafe fn setInt(&self, id: AttrID, value: int64) -> tresult {
        self.attrs.lock().insert(cstr_key(id), AttrValue::Int(value));
        kResultOk
    }
    unsafe fn getInt(&self, id: AttrID, value: *mut int64) -> tresult {
        if value.is_null() {
            return kInvalidArgument;
        }
        match self.attrs.lock().get(&cstr_key(id)) {
            Some(AttrValue::Int(v)) => {
                *value = *v;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
    unsafe fn setFloat(&self, id: AttrID, value: f64) -> tresult {
        self.attrs.lock().insert(cstr_key(id), AttrValue::Float(value));
        kResultOk
    }
    unsafe fn getFloat(&self, id: AttrID, value: *mut f64) -> tresult {
        if value.is_null() {
            return kInvalidArgument;
        }
        match self.attrs.lock().get(&cstr_key(id)) {
            Some(AttrValue::Float(v)) => {
                *value = *v;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
    unsafe fn setString(&self, id: AttrID, string: *const TChar) -> tresult {
        let n = wstr_len(string);
        let mut v = Vec::with_capacity(n);
        for i in 0..n {
            v.push(*string.add(i));
        }
        self.attrs.lock().insert(cstr_key(id), AttrValue::Wstr(v));
        kResultOk
    }
    unsafe fn getString(&self, id: AttrID, string: *mut TChar, sizeInBytes: u32) -> tresult {
        if string.is_null() {
            return kInvalidArgument;
        }
        let max_chars = (sizeInBytes as usize) / std::mem::size_of::<TChar>();
        if max_chars == 0 {
            return kInvalidArgument;
        }
        match self.attrs.lock().get(&cstr_key(id)) {
            Some(AttrValue::Wstr(v)) => {
                let n = v.len().min(max_chars - 1);
                for i in 0..n {
                    *string.add(i) = v[i];
                }
                *string.add(n) = 0;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
    unsafe fn setBinary(&self, id: AttrID, data: *const c_void, sizeInBytes: u32) -> tresult {
        if data.is_null() && sizeInBytes > 0 {
            return kInvalidArgument;
        }
        let mut v = vec![0u8; sizeInBytes as usize];
        if sizeInBytes > 0 {
            std::ptr::copy_nonoverlapping(data as *const u8, v.as_mut_ptr(), sizeInBytes as usize);
        }
        self.attrs.lock().insert(cstr_key(id), AttrValue::Bin(v));
        kResultOk
    }
    unsafe fn getBinary(
        &self,
        id: AttrID,
        data: *mut *const c_void,
        sizeInBytes: *mut u32,
    ) -> tresult {
        if data.is_null() || sizeInBytes.is_null() {
            return kInvalidArgument;
        }
        let bytes = match self.attrs.lock().get(&cstr_key(id)) {
            Some(AttrValue::Bin(b)) => b.clone(),
            _ => return kResultFalse,
        };
        let mut buf = self.last_binary_out.lock();
        *buf = bytes;
        *data = buf.as_ptr() as *const c_void;
        *sizeInBytes = buf.len() as u32;
        kResultOk
    }
}

struct StagehandMessage {
    /// Stable storage for the message ID — pointer returned by getMessageID stays
    /// valid until next setMessageID call.
    id: Mutex<CString>,
    attrs: ComWrapper<StagehandAttributeList>,
}

impl StagehandMessage {
    fn new() -> Self {
        Self {
            id: Mutex::new(CString::default()),
            attrs: ComWrapper::new(StagehandAttributeList::new()),
        }
    }
}

impl Class for StagehandMessage {
    type Interfaces = (IMessage,);
}

impl IMessageTrait for StagehandMessage {
    unsafe fn getMessageID(&self) -> FIDString {
        // Pointer into our CString allocation. Stable until next setMessageID.
        // VST3 contract: caller copies the string before calling setMessageID again.
        let g = self.id.lock();
        g.as_ptr()
    }
    unsafe fn setMessageID(&self, id: FIDString) {
        let new_id = if id.is_null() {
            CString::default()
        } else {
            CStr::from_ptr(id).to_owned()
        };
        *self.id.lock() = new_id;
    }
    unsafe fn getAttributes(&self) -> *mut IAttributeList {
        // Pointer into our embedded ComWrapper — alive for the message's lifetime.
        match self.attrs.as_com_ref::<IAttributeList>() {
            Some(r) => r.as_ptr(),
            None => ptr::null_mut(),
        }
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
    /// Kept alive so we can lazily createInstance the IEditController later
    /// for separate-component plugins (Helix Native). ManuallyDrop so we control
    /// release order vs the DLL unload.
    factory: ManuallyDrop<ComPtr<IPluginFactory>>,
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
    // Stage 3 — plugin GUI state.
    /// Resolved on first open_gui. May be the same object as `component` (single-
    /// component plugins) OR a separate instance created via the factory.
    edit_controller: Option<ComPtr<IEditController>>,
    /// Alive while the GUI window is open. Drop releases the view.
    plug_view: Option<ComPtr<IPlugView>>,
    /// Shared with `_plug_frame` so resizeView can resize the floating window.
    /// Stored as usize so the Arc is unconditionally Send + Sync.
    container_hwnd: Arc<Mutex<Option<usize>>>,
    // Keep host-side COM objects alive for the plugin's lifetime.
    _host_app: ComWrapper<StagehandHostApp>,
    _comp_handler: ComWrapper<StagehandCompHandler>,
    _plug_frame: ComWrapper<StagehandPlugFrame>,
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
        // Catch unhandled SEH exceptions and log faulting address + module before death.
        install_crash_filter();

        let dll_path = resolve_dll_path(path)
            .ok_or_else(|| format!("Cannot locate .vst3 DLL at: {path}"))?;

        // Safety: LoadLibraryW requires a valid null-terminated UTF-16 string;
        // `to_utf16_null` produces exactly that from a valid Rust str.
        let lib_handle = unsafe { win32_load_library(&dll_path)? };

        // Safety: GetProcAddress on "GetPluginFactory" is the standard VST3 DLL entry point.
        let factory_raw = unsafe { get_plugin_factory(lib_handle)? };

        // Wrap factory in owning ComPtr — kept alive on VstHost so we can lazily
        // create the IEditController later for separate-component plugins.
        // Safety: factory_raw is a valid IPluginFactory* returned by GetPluginFactory
        // with refcount 1 per COM convention.
        let factory = unsafe {
            ComPtr::<IPluginFactory>::from_raw(factory_raw)
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
        let container_hwnd: Arc<Mutex<Option<usize>>> = Arc::new(Mutex::new(None));
        let plug_frame = ComWrapper::new(StagehandPlugFrame {
            container_hwnd: container_hwnd.clone(),
        });

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

        // Resolve IEditController NOW (before activation) per VST3 spec §3.2:
        //  - Single-component: cast IComponent → IEditController.
        //  - Separate-component (Helix Native): getControllerClassId + factory.createInstance.
        // Then connect, sync state, set handler — all while component is still inactive.
        // Doing this lazily on open_gui causes Helix to crash during paint because
        // controller state isn't synchronized while audio thread is already running.
        let edit_controller = unsafe {
            setup_controller(
                &factory,
                &component,
                &host_app,
                &comp_handler,
            )?
        };

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
            factory: ManuallyDrop::new(factory),
            component: ManuallyDrop::new(component),
            processor: ManuallyDrop::new(processor),
            latency_samples,
            bypassed: false,
            sample_rate,
            in_l: vec![0.0; block],
            in_r: vec![0.0; block],
            out_l: vec![0.0; block],
            out_r: vec![0.0; block],
            edit_controller,
            plug_view: None,
            container_hwnd,
            _host_app: host_app,
            _comp_handler: comp_handler,
            _plug_frame: plug_frame,
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

    /// Open the plugin's editor GUI as a floating Win32 window owned by `parent_hwnd`.
    /// MUST be called from the main UI thread (use `app.run_on_main_thread()`).
    /// Idempotent — calling while already open returns Ok.
    pub fn open_gui(&mut self, parent_hwnd: *mut c_void) -> Result<(), String> {
        if self.plug_view.is_some() {
            return Ok(());
        }

        // Controller resolved + initialized + connected during load(). If it's None
        // here, the plugin doesn't expose an editor.
        let ec = self
            .edit_controller
            .clone()
            .ok_or("Plugin has no editor (no IEditController available)")?;

        // 2. createView("editor"). Returns null if plugin has no GUI.
        // Safety: createView with the standard ViewType::kEditor C string is valid.
        let view_raw = unsafe { ec.createView(ViewType::kEditor) };
        if view_raw.is_null() {
            return Err("Plugin returned null view from createView(\"editor\")".into());
        }
        // Safety: view_raw is a valid IPlugView* with refcount 1.
        let view = unsafe {
            ComPtr::<IPlugView>::from_raw(view_raw)
                .ok_or("createView returned non-null but invalid pointer")?
        };

        // 3. Verify HWND platform supported by this plugin.
        // Safety: isPlatformTypeSupported is a const-string query, no side effects.
        let supported = unsafe { view.isPlatformTypeSupported(kPlatformTypeHWND) };
        if supported != kResultOk {
            return Err("Plugin does not support HWND platform (Windows)".into());
        }

        // 4. Get plugin's preferred initial size. If getSize fails or returns zero,
        //    fall back to a reasonable default.
        let mut rect = ViewRect { left: 0, top: 0, right: 800, bottom: 600 };
        // Safety: getSize fills rect; we ignore the return value and use default on zero.
        unsafe {
            view.getSize(&mut rect);
        }
        let mut w = rect.right - rect.left;
        let mut h = rect.bottom - rect.top;
        if w <= 0 {
            w = 800;
        }
        if h <= 0 {
            h = 600;
        }

        // 5. Register class once + create floating window.
        ensure_window_class_registered();
        // Safety: parent_hwnd is a valid HWND from Tauri (caller's responsibility);
        // sizes validated positive above.
        let hwnd = unsafe { create_floating_window(parent_hwnd, w, h)? };
        *self.container_hwnd.lock() = Some(hwnd as usize);

        // 6. Set our IPlugFrame on the view so the plugin can request resizes.
        let frame_com = self
            ._plug_frame
            .to_com_ptr::<IPlugFrame>()
            .ok_or("Failed to acquire IPlugFrame interface for the host frame")?;
        // Safety: frame_com points to a live ComWrapper held by VstHost; same lifetime as plugin.
        let frame_raw = frame_com.as_com_ref().as_ptr();
        // Safety: setFrame stores the host frame pointer for later resizeView callbacks.
        unsafe {
            view.setFrame(frame_raw);
        }

        // 7. attached(parent, "HWND") — plugin creates its child controls inside our window.
        // Safety: hwnd is a valid HWND we just created; kPlatformTypeHWND is the correct C string.
        let res = unsafe { view.attached(hwnd, kPlatformTypeHWND) };
        if res != kResultOk {
            #[cfg(target_os = "windows")]
            unsafe {
                DestroyWindow(hwnd);
            }
            *self.container_hwnd.lock() = None;
            return Err(format!("IPlugView::attached failed: 0x{res:08X}"));
        }

        // 8. Show the window. The plugin has now drawn its initial UI inside it.
        #[cfg(target_os = "windows")]
        unsafe {
            ShowWindow(hwnd, SW_SHOW);
        }

        self.plug_view = Some(view);
        log::info!("[vst] plugin GUI opened (initial size {}x{})", w, h);
        Ok(())
    }

    /// Close the plugin's GUI. MUST be called from the main UI thread.
    /// Safe to call when GUI is not open (no-op).
    pub fn close_gui(&mut self) {
        if let Some(view) = self.plug_view.take() {
            // Safety: removed() releases plugin's grip on the parent HWND. Must be called
            // before DestroyWindow per VST3 spec — otherwise plugin may access freed window.
            unsafe {
                let _ = view.removed();
            }
            // ComPtr drops here → plugin Releases its view object.
        }
        let hwnd_opt = self.container_hwnd.lock().take();
        if let Some(hwnd_usize) = hwnd_opt {
            let hwnd = hwnd_usize as *mut c_void;
            #[cfg(target_os = "windows")]
            // Safety: hwnd was created by CreateWindowExW and not yet destroyed.
            unsafe {
                DestroyWindow(hwnd);
            }
            log::info!("[vst] plugin GUI closed");
        }
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
        // Close the GUI first if open — plugin must release its view + the HWND
        // before we tear down the audio components or unload the DLL.
        self.close_gui();
        // Drop edit_controller before component (controller may hold component ref).
        self.edit_controller = None;

        // Tear down in reverse VST3 lifecycle order before releasing COM objects.
        // Safety: setProcessing(0) and setActive(0) are valid on an active processor/component.
        unsafe {
            let _ = self.processor.setProcessing(0u8);
            let _ = self.component.setActive(0u8);
            let _ = self.component.terminate();
        }

        // Explicitly release COM objects before FreeLibrary — the vtables live in the DLL.
        // Order: processor → component → factory (controllers/views released by close_gui above).
        // Safety: each ManuallyDrop field has not been dropped yet; this is the only drop site.
        unsafe {
            ManuallyDrop::drop(&mut self.processor);
            ManuallyDrop::drop(&mut self.component);
            ManuallyDrop::drop(&mut self.factory);
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
    factory: &ComPtr<IPluginFactory>,
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
    factory: &ComPtr<IPluginFactory>,
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

/// Resolve, initialize, and connect an IEditController for a freshly-loaded plugin.
/// Returns Some(controller) for plugins with an editor, None if plugin has no GUI/controller.
unsafe fn setup_controller(
    factory: &ComPtr<IPluginFactory>,
    component: &ComPtr<IComponent>,
    host_app: &ComWrapper<StagehandHostApp>,
    comp_handler: &ComWrapper<StagehandCompHandler>,
) -> Result<Option<ComPtr<IEditController>>, String> {
    // Path A — single-component plugin.
    let ec = if let Some(ec) = component.cast::<IEditController>() {
        ec
    } else {
        // Path B — separate-component plugin (Helix Native).
        let mut ctrl_cid: TUID = [0i8; 16];
        let res = component.getControllerClassId(ctrl_cid.as_mut_ptr() as *mut _);
        if res != kResultOk {
            // Plugin has no editor (e.g. processor-only). Not an error.
            log::info!("[vst] plugin has no separate controller (0x{res:08X}) — GUI unavailable");
            return Ok(None);
        }

        let mut obj: *mut c_void = ptr::null_mut();
        let res = factory.createInstance(
            ctrl_cid.as_ptr() as FIDString,
            IEditController::IID.as_ptr() as *const i8,
            &mut obj,
        );
        if res != kResultOk || obj.is_null() {
            return Err(format!("Failed to create IEditController instance: 0x{res:08X}"));
        }
        ComPtr::<IEditController>::from_raw(obj as *mut IEditController)
            .ok_or("createInstance returned non-null but invalid IEditController pointer")?
    };

    // Initialize controller with the same host context as the component.
    let host_com = host_app
        .to_com_ptr::<IHostApplication>()
        .ok_or("Failed to acquire IHostApplication for controller init")?;
    let host_raw = host_com.as_com_ref().as_ptr() as *mut FUnknown;
    let res = ec.initialize(host_raw);
    if res != kResultOk && res != kResultFalse {
        return Err(format!("IEditController::initialize failed: 0x{res:08X}"));
    }

    // Bidirectional IConnectionPoint between component and controller.
    // Required by VST3 spec for separate-component plugins. Helix Native crashes
    // during paint without this connection.
    if let (Some(comp_cp), Some(ctrl_cp)) = (
        component.cast::<IConnectionPoint>(),
        ec.cast::<IConnectionPoint>(),
    ) {
        let _ = comp_cp.connect(ctrl_cp.as_com_ref().as_ptr());
        let _ = ctrl_cp.connect(comp_cp.as_com_ref().as_ptr());
    }

    // Sync component state → controller. Without this, controller has no parameter
    // values and Helix's UI dereferences invalid params on first paint.
    let stream = ComWrapper::new(MemoryStream::new());
    if let Some(stream_ptr) = stream.to_com_ptr::<IBStream>() {
        let stream_raw = stream_ptr.as_com_ref().as_ptr();
        let _ = component.getState(stream_raw);
        // Rewind so controller reads from byte 0.
        let ms: &MemoryStream = &stream;
        ms.rewind();
        let _ = ec.setComponentState(stream_raw);
    }

    // Set our component handler so the plugin can post param edits.
    let handler_com = comp_handler
        .to_com_ptr::<IComponentHandler>()
        .ok_or("Failed to acquire IComponentHandler interface")?;
    let handler_raw = handler_com.as_com_ref().as_ptr();
    let _ = ec.setComponentHandler(handler_raw);

    Ok(Some(ec))
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

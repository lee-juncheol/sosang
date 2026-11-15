//! Windows Portable Devices (WPD) transport. The camera stays on Windows' own MTP driver; PTP
//! operations go through the MTP vendor-extension commands (`WPD_CATEGORY_MTP_EXT_VENDOR_OPERATIONS`).
//!
//! All COM objects live on one worker thread per session (COM is initialised there); callers
//! send it jobs and wait on a channel with a timeout, like the macOS transport does with the
//! main thread.
//!
//! PnP device IDs can contain the camera's serial number, so they never go into an error
//! message or a log.

use crate::PtpError;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ::windows::core::{w, PCWSTR, PWSTR};
use ::windows::Win32::Devices::PortableDevices::*;
use ::windows::Win32::Foundation::PROPERTYKEY;
use ::windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use ::windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use ::windows::Win32::System::Variant::VT_UI4;

/// One session at a time across the process. Cleared by the worker thread when it has closed
/// the device, so a new session never races the previous one.
static SESSION_ACTIVE: AtomicBool = AtomicBool::new(false);

const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const SECURITY_IMPERSONATION: u32 = 0x0002_0000;
/// Used when the driver does not report an optimal transfer size.
const DEFAULT_CHUNK: usize = 256 * 1024;

type Reply = Result<(u16, Vec<u8>), String>;

struct Job {
    op: u16,
    params: Vec<u32>,
    out: Option<Vec<u8>>,
    reply: Sender<Reply>,
}

/// WPD lists devices on demand, so there is nothing to start in the background.
pub(crate) fn start_discovery() {}

/// An open session. Dropping it closes the device on the worker thread.
pub(crate) struct Session {
    jobs: Mutex<Option<Sender<Job>>>,
    closed: Mutex<Receiver<()>>,
}

impl Session {
    pub(crate) fn open(hint: &str, timeout: Duration) -> Result<Session, PtpError> {
        if SESSION_ACTIVE.swap(true, Ordering::SeqCst) {
            return Err(PtpError::Session("another camera session is already open".into()));
        }
        let (open_tx, open_rx) = channel::<Result<(), PtpError>>();
        let (job_tx, job_rx) = channel::<Job>();
        let (closed_tx, closed_rx) = channel::<()>();
        let hint = hint.to_string();
        let spawned = std::thread::Builder::new()
            .name("lumix-ptp-wpd".into())
            .spawn(move || worker(&hint, timeout, open_tx, job_rx, closed_tx));
        if let Err(e) = spawned {
            SESSION_ACTIVE.store(false, Ordering::SeqCst);
            return Err(PtpError::Io(e));
        }
        match open_rx.recv_timeout(timeout + Duration::from_secs(20)) {
            Ok(Ok(())) => Ok(Session { jobs: Mutex::new(Some(job_tx)), closed: Mutex::new(closed_rx) }),
            Ok(Err(e)) => Err(e),
            // The worker is still trying; it clears SESSION_ACTIVE itself when it gives up.
            Err(_) => Err(PtpError::Timeout("the session to open")),
        }
    }

    /// Run one PTP transaction. Returns the response code and the data-in phase.
    pub(crate) fn transaction(&self, op: u16, params: &[u32], out: Option<Vec<u8>>, timeout: Duration) -> Result<(u16, Vec<u8>), PtpError> {
        let (tx, rx) = channel();
        let job = Job { op, params: params.to_vec(), out, reply: tx };
        let sent = self.jobs.lock().unwrap().as_ref().map(|j| j.send(job).is_ok()).unwrap_or(false);
        if !sent {
            return Err(PtpError::Transport("camera is gone".into()));
        }
        rx.recv_timeout(timeout).map_err(|_| PtpError::Timeout("the camera to answer"))?.map_err(PtpError::Transport)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // Closing the job channel ends the worker loop, which closes the device.
        self.jobs.lock().unwrap().take();
        let _ = self.closed.lock().unwrap().recv_timeout(Duration::from_secs(5));
    }
}

fn worker(hint: &str, timeout: Duration, open_tx: Sender<Result<(), PtpError>>, jobs: Receiver<Job>, closed_tx: Sender<()>) {
    let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if let Err(e) = com.ok() {
        SESSION_ACTIVE.store(false, Ordering::SeqCst);
        let _ = open_tx.send(Err(PtpError::Session(format!("COM initialisation failed: {e}"))));
        return;
    }
    {
        match find_and_open(hint, timeout) {
            Err(e) => {
                SESSION_ACTIVE.store(false, Ordering::SeqCst);
                let _ = open_tx.send(Err(e));
            }
            Ok(device) => {
                let _ = open_tx.send(Ok(()));
                for job in jobs {
                    let r = transaction(&device, job.op, &job.params, job.out.as_deref());
                    let _ = job.reply.send(r);
                }
                unsafe {
                    let _ = device.Close();
                }
                drop(device);
                SESSION_ACTIVE.store(false, Ordering::SeqCst);
                let _ = closed_tx.send(());
            }
        }
    }
    unsafe { CoUninitialize() };
}

/// Find a Panasonic camera (preferring one whose name contains `hint`) and open it.
fn find_and_open(hint: &str, timeout: Duration) -> Result<IPortableDevice, PtpError> {
    let manager: IPortableDeviceManager =
        unsafe { CoCreateInstance(&PortableDeviceManager, None, CLSCTX_INPROC_SERVER) }.map_err(|e| PtpError::Session(format!("WPD is not available: {e}")))?;
    let deadline = Instant::now() + timeout;
    loop {
        unsafe {
            let _ = manager.RefreshDeviceList();
        }
        let mut chosen = None;
        let mut fallback = None;
        for id in device_ids(&manager) {
            let id_ptr = PCWSTR(id.as_ptr());
            let manufacturer = read_string(|buf, len| unsafe { manager.GetDeviceManufacturer(id_ptr, buf, len) });
            if !manufacturer.to_ascii_lowercase().contains("panasonic") {
                continue;
            }
            let name = read_string(|buf, len| unsafe { manager.GetDeviceFriendlyName(id_ptr, buf, len) });
            let description = read_string(|buf, len| unsafe { manager.GetDeviceDescription(id_ptr, buf, len) });
            if name.contains(hint) || description.contains(hint) {
                chosen = Some(id);
                break;
            }
            if fallback.is_none() {
                fallback = Some(id);
            }
        }
        // The Windows name of a body need not contain the hint (it may be "LUMIX S1II" or
        // "DC-S1M2"), so any Panasonic device is accepted; the caller checks DeviceInfo.
        if let Some(id) = chosen.or(fallback) {
            return open_device(&id);
        }
        if Instant::now() >= deadline {
            return Err(PtpError::NoCamera);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// PnP IDs of all WPD devices, each NUL-terminated.
fn device_ids(manager: &IPortableDeviceManager) -> Vec<Vec<u16>> {
    let mut count = 0u32;
    if unsafe { manager.GetDevices(std::ptr::null_mut(), &mut count) }.is_err() || count == 0 {
        return Vec::new();
    }
    let mut ptrs = vec![PWSTR::null(); count as usize];
    if unsafe { manager.GetDevices(ptrs.as_mut_ptr(), &mut count) }.is_err() {
        return Vec::new();
    }
    ptrs.truncate(count as usize);
    ptrs.into_iter()
        .filter(|p| !p.is_null())
        .map(|p| {
            let mut id = unsafe { p.as_wide() }.to_vec();
            id.push(0);
            unsafe { CoTaskMemFree(Some(p.0 as *const _)) };
            id
        })
        .collect()
}

/// Call a WPD "fill this buffer" getter twice: once for the length, once for the text.
fn read_string(get: impl Fn(PWSTR, *mut u32) -> ::windows::core::Result<()>) -> String {
    let mut len = 0u32;
    if get(PWSTR::null(), &mut len).is_err() || len == 0 {
        return String::new();
    }
    let mut buf = vec![0u16; len as usize];
    if get(PWSTR(buf.as_mut_ptr()), &mut len).is_err() {
        return String::new();
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

fn open_device(id: &[u16]) -> Result<IPortableDevice, PtpError> {
    let err = |what: &str, e: ::windows::core::Error| PtpError::Session(format!("{what}: {e}"));
    let client = new_values().map_err(|e| err("client info", e))?;
    unsafe {
        client.SetStringValue(&WPD_CLIENT_NAME, w!("sosang")).map_err(|e| err("client info", e))?;
        client.SetUnsignedIntegerValue(&WPD_CLIENT_MAJOR_VERSION, 1).map_err(|e| err("client info", e))?;
        client.SetUnsignedIntegerValue(&WPD_CLIENT_MINOR_VERSION, 0).map_err(|e| err("client info", e))?;
        client.SetUnsignedIntegerValue(&WPD_CLIENT_REVISION, 0).map_err(|e| err("client info", e))?;
        client.SetUnsignedIntegerValue(&WPD_CLIENT_SECURITY_QUALITY_OF_SERVICE, SECURITY_IMPERSONATION).map_err(|e| err("client info", e))?;
        client.SetUnsignedIntegerValue(&WPD_CLIENT_DESIRED_ACCESS, GENERIC_READ | GENERIC_WRITE).map_err(|e| err("client info", e))?;
    }
    let device: IPortableDevice = unsafe { CoCreateInstance(&PortableDeviceFTM, None, CLSCTX_INPROC_SERVER) }.map_err(|e| err("create device", e))?;
    unsafe { device.Open(PCWSTR(id.as_ptr()), &client) }.map_err(|e| err("open device", e))?;
    Ok(device)
}

fn new_values() -> ::windows::core::Result<IPortableDeviceValues> {
    unsafe { CoCreateInstance(&PortableDeviceValues, None, CLSCTX_INPROC_SERVER) }
}

/// Parameters for one WPD command.
fn command(cmd: &PROPERTYKEY) -> Result<IPortableDeviceValues, String> {
    let v = new_values().map_err(|e| format!("command parameters: {e}"))?;
    unsafe {
        v.SetGuidValue(&WPD_PROPERTY_COMMON_COMMAND_CATEGORY, &cmd.fmtid).map_err(|e| format!("command parameters: {e}"))?;
        v.SetUnsignedIntegerValue(&WPD_PROPERTY_COMMON_COMMAND_ID, cmd.pid).map_err(|e| format!("command parameters: {e}"))?;
    }
    Ok(v)
}

/// Send a command and check both the call and the driver's own result.
fn send(device: &IPortableDevice, what: &str, params: &IPortableDeviceValues) -> Result<IPortableDeviceValues, String> {
    let results = unsafe { device.SendCommand(0, params) }.map_err(|e| format!("{what}: {e}"))?;
    let hr = unsafe { results.GetErrorValue(&WPD_PROPERTY_COMMON_HRESULT) }.map_err(|e| format!("{what}: no result ({e})"))?;
    hr.ok().map_err(|e| format!("{what}: {e}"))?;
    Ok(results)
}

/// The operation code and its parameters (each a VT_UI4).
fn set_operation(v: &IPortableDeviceValues, op: u16, params: &[u32]) -> Result<(), String> {
    let e = |e: ::windows::core::Error| format!("operation parameters: {e}");
    let list: IPortableDevicePropVariantCollection = unsafe { CoCreateInstance(&PortableDevicePropVariantCollection, None, CLSCTX_INPROC_SERVER) }.map_err(e)?;
    for &p in params {
        let mut pv = PROPVARIANT::default();
        unsafe {
            (*pv.Anonymous.Anonymous).vt = VT_UI4;
            (*pv.Anonymous.Anonymous).Anonymous.ulVal = p;
            list.Add(&pv).map_err(e)?;
        }
    }
    unsafe {
        v.SetUnsignedIntegerValue(&WPD_PROPERTY_MTP_EXT_OPERATION_CODE, op as u32).map_err(e)?;
        v.SetIPortableDevicePropVariantCollectionValue(&WPD_PROPERTY_MTP_EXT_OPERATION_PARAMS, &list).map_err(e)?;
    }
    Ok(())
}

fn take_string(p: PWSTR) -> Vec<u16> {
    let mut s = unsafe { p.as_wide() }.to_vec();
    s.push(0);
    unsafe { CoTaskMemFree(Some(p.0 as *const _)) };
    s
}

/// Transfer context and chunk size returned by a command that starts a data phase.
fn transfer_start(results: &IPortableDeviceValues) -> Result<(Vec<u16>, usize), String> {
    let ctx = unsafe { results.GetStringValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_CONTEXT) }.map_err(|e| format!("transfer context: {e}"))?;
    let chunk = unsafe { results.GetUnsignedIntegerValue(&WPD_PROPERTY_MTP_EXT_OPTIMAL_TRANSFER_BUFFER_SIZE) }.ok().filter(|&n| n > 0).map_or(DEFAULT_CHUNK, |n| n as usize);
    Ok((take_string(ctx), chunk))
}

fn with_context(cmd: &PROPERTYKEY, ctx: &[u16]) -> Result<IPortableDeviceValues, String> {
    let v = command(cmd)?;
    unsafe { v.SetStringValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_CONTEXT, PCWSTR(ctx.as_ptr())) }.map_err(|e| format!("transfer context: {e}"))?;
    Ok(v)
}

/// Finish a data phase and return the PTP response code.
fn end_transfer(device: &IPortableDevice, ctx: &[u16]) -> Result<u16, String> {
    let v = with_context(&WPD_COMMAND_MTP_EXT_END_DATA_TRANSFER, ctx)?;
    let r = send(device, "end of transfer", &v)?;
    let code = unsafe { r.GetUnsignedIntegerValue(&WPD_PROPERTY_MTP_EXT_RESPONSE_CODE) }.map_err(|e| format!("response code: {e}"))?;
    Ok(code as u16)
}

/// One PTP transaction. Every operation sent here has a data phase: data-out when `out` is
/// given (the settings write), otherwise data-in (GetDeviceInfo and the settings read).
fn transaction(device: &IPortableDevice, op: u16, params: &[u32], out: Option<&[u8]>) -> Reply {
    match out {
        Some(data) => {
            let v = command(&WPD_COMMAND_MTP_EXT_EXECUTE_COMMAND_WITH_DATA_TO_WRITE)?;
            set_operation(&v, op, params)?;
            unsafe { v.SetUnsignedLargeIntegerValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_TOTAL_DATA_SIZE, data.len() as u64) }.map_err(|e| format!("transfer size: {e}"))?;
            let r = send(device, "start of write", &v)?;
            let (ctx, chunk) = transfer_start(&r)?;
            let sent = (|| -> Result<(), String> {
                for part in data.chunks(chunk) {
                    let w = with_context(&WPD_COMMAND_MTP_EXT_WRITE_DATA, &ctx)?;
                    unsafe {
                        w.SetUnsignedIntegerValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_NUM_BYTES_TO_WRITE, part.len() as u32).map_err(|e| format!("write data: {e}"))?;
                        w.SetBufferValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_DATA, part).map_err(|e| format!("write data: {e}"))?;
                    }
                    let wr = send(device, "write data", &w)?;
                    let n = unsafe { wr.GetUnsignedIntegerValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_NUM_BYTES_WRITTEN) }.map_err(|e| format!("write data: {e}"))?;
                    if n as usize != part.len() {
                        return Err(format!("write data: {n} of {} bytes accepted", part.len()));
                    }
                }
                Ok(())
            })();
            // Always end the transfer so the device is not left mid-transaction.
            let code = end_transfer(device, &ctx);
            sent?;
            Ok((code?, Vec::new()))
        }
        None => {
            let v = command(&WPD_COMMAND_MTP_EXT_EXECUTE_COMMAND_WITH_DATA_TO_READ)?;
            set_operation(&v, op, params)?;
            let r = send(device, "start of read", &v)?;
            let (ctx, chunk) = transfer_start(&r)?;
            let received = (|| -> Result<Vec<u8>, String> {
                let total = unsafe { r.GetUnsignedLargeIntegerValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_TOTAL_DATA_SIZE) }.map_err(|e| format!("transfer size: {e}"))? as usize;
                let mut data = Vec::with_capacity(total);
                let scratch = vec![0u8; chunk];
                while data.len() < total {
                    let want = chunk.min(total - data.len());
                    let rd = with_context(&WPD_COMMAND_MTP_EXT_READ_DATA, &ctx)?;
                    unsafe {
                        rd.SetUnsignedIntegerValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_NUM_BYTES_TO_READ, want as u32).map_err(|e| format!("read data: {e}"))?;
                        rd.SetBufferValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_DATA, &scratch[..want]).map_err(|e| format!("read data: {e}"))?;
                    }
                    let rr = send(device, "read data", &rd)?;
                    let n = unsafe { rr.GetUnsignedIntegerValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_NUM_BYTES_READ) }.map_err(|e| format!("read data: {e}"))? as usize;
                    let mut buf: *mut u8 = std::ptr::null_mut();
                    let mut len = 0u32;
                    unsafe { rr.GetBufferValue(&WPD_PROPERTY_MTP_EXT_TRANSFER_DATA, &mut buf, &mut len) }.map_err(|e| format!("read data: {e}"))?;
                    if !buf.is_null() {
                        let got = n.min(len as usize);
                        data.extend_from_slice(unsafe { std::slice::from_raw_parts(buf, got) });
                        unsafe { CoTaskMemFree(Some(buf as *const _)) };
                    }
                    if n == 0 {
                        break;
                    }
                }
                if data.len() != total {
                    return Err(format!("received {} of {total} bytes", data.len()));
                }
                Ok(data)
            })();
            let code = end_transfer(device, &ctx);
            let data = received?;
            Ok((code?, data))
        }
    }
}

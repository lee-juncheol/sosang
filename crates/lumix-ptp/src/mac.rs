//! ImageCaptureCore transport. All ImageCaptureCore objects live on the main thread (kept in a
//! thread-local there); callers block on channels from another thread.

use crate::PtpError;
use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AllocAnyThread, MainThreadMarker, Message};
use objc2_core_graphics::CGImage;
use objc2_foundation::{NSArray, NSData, NSDictionary, NSError, NSObject, NSObjectProtocol};
use objc2_image_capture_core::{
    ICCameraDevice, ICCameraDeviceDelegate, ICCameraItem, ICDevice, ICDeviceBrowser, ICDeviceBrowserDelegate, ICDeviceDelegate,
    ICDeviceLocationTypeMask, ICDeviceTypeMask,
};
use std::cell::RefCell;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

enum Event {
    Opened(Result<(), String>),
    Closed,
    Removed,
}

/// Where delegate callbacks report to: the sender of the session currently being used.
static EVENTS: Mutex<Option<Sender<Event>>> = Mutex::new(None);
/// One session at a time across the process.
static SESSION_ACTIVE: AtomicBool = AtomicBool::new(false);

fn send(e: Event) {
    if let Some(tx) = EVENTS.lock().unwrap().as_ref() {
        let _ = tx.send(e);
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "LumixLutBrowserDelegate"]
    struct BrowserDelegate;

    unsafe impl NSObjectProtocol for BrowserDelegate {}

    unsafe impl ICDeviceBrowserDelegate for BrowserDelegate {
        #[unsafe(method(deviceBrowser:didAddDevice:moreComing:))]
        fn did_add(&self, _browser: &ICDeviceBrowser, device: &ICDevice, _more: bool) {
            let Some(camera) = device.downcast_ref::<ICCameraDevice>() else { return };
            STATE.with(|s| {
                if let Some(state) = s.borrow_mut().as_mut() {
                    state.cameras.push(camera.retain());
                }
            });
            try_open_pending();
        }

        #[unsafe(method(deviceBrowser:didRemoveDevice:moreGoing:))]
        fn did_remove(&self, _browser: &ICDeviceBrowser, device: &ICDevice, _more: bool) {
            let ptr = device as *const ICDevice as *const ICCameraDevice;
            let was_active = STATE.with(|s| {
                let mut s = s.borrow_mut();
                let Some(state) = s.as_mut() else { return false };
                state.cameras.retain(|c| !std::ptr::eq(&**c, ptr));
                if state.active.as_deref().is_some_and(|c| std::ptr::eq(c, ptr)) {
                    state.active = None;
                    return true;
                }
                false
            });
            if was_active {
                send(Event::Removed);
            }
        }
    }
);

impl BrowserDelegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "LumixLutDeviceDelegate"]
    struct DeviceDelegate;

    unsafe impl NSObjectProtocol for DeviceDelegate {}

    unsafe impl ICDeviceDelegate for DeviceDelegate {
        #[unsafe(method(didRemoveDevice:))]
        fn did_remove_device(&self, _device: &ICDevice) {
            send(Event::Removed);
        }

        #[unsafe(method(device:didOpenSessionWithError:))]
        fn did_open(&self, _device: &ICDevice, error: Option<&NSError>) {
            let r = match error {
                None => Ok(()),
                Some(e) => Err(e.localizedDescription().to_string()),
            };
            send(Event::Opened(r));
        }

        #[unsafe(method(device:didCloseSessionWithError:))]
        fn did_close(&self, _device: &ICDevice, _error: Option<&NSError>) {
            send(Event::Closed);
        }
    }

    unsafe impl ICCameraDeviceDelegate for DeviceDelegate {
        #[unsafe(method(cameraDevice:didAddItems:))]
        fn did_add_items(&self, _c: &ICCameraDevice, _items: &NSArray<ICCameraItem>) {}

        #[unsafe(method(cameraDevice:didRemoveItems:))]
        fn did_remove_items(&self, _c: &ICCameraDevice, _items: &NSArray<ICCameraItem>) {}

        #[unsafe(method(cameraDevice:didReceiveThumbnail:forItem:error:))]
        fn did_thumb(&self, _c: &ICCameraDevice, _t: Option<&CGImage>, _i: &ICCameraItem, _e: Option<&NSError>) {}

        #[unsafe(method(cameraDevice:didReceiveMetadata:forItem:error:))]
        fn did_meta(&self, _c: &ICCameraDevice, _m: Option<&NSDictionary>, _i: &ICCameraItem, _e: Option<&NSError>) {}

        #[unsafe(method(cameraDevice:didRenameItems:))]
        fn did_rename(&self, _c: &ICCameraDevice, _items: &NSArray<ICCameraItem>) {}

        #[unsafe(method(cameraDeviceDidChangeCapability:))]
        fn did_change_cap(&self, _c: &ICCameraDevice) {}

        #[unsafe(method(cameraDevice:didReceivePTPEvent:))]
        fn did_event(&self, _c: &ICCameraDevice, _e: &NSData) {}

        #[unsafe(method(deviceDidBecomeReadyWithCompleteContentCatalog:))]
        fn did_ready(&self, _c: &ICCameraDevice) {}

        #[unsafe(method(cameraDeviceDidRemoveAccessRestriction:))]
        fn did_unrestrict(&self, _d: &ICDevice) {}

        #[unsafe(method(cameraDeviceDidEnableAccessRestriction:))]
        fn did_restrict(&self, _d: &ICDevice) {}
    }
);

impl DeviceDelegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

/// Main-thread state. The browser keeps running for the life of the process: a browser that is
/// stopped and started again does not report an already-connected camera a second time.
struct MainState {
    _browser: Retained<ICDeviceBrowser>,
    _browser_delegate: Retained<BrowserDelegate>,
    device_delegate: Retained<DeviceDelegate>,
    /// Every camera the browser has reported and not yet removed.
    cameras: Vec<Retained<ICCameraDevice>>,
    /// Name hint of a session waiting for a camera.
    pending: Option<String>,
    /// The camera with an open (or opening) session.
    active: Option<Retained<ICCameraDevice>>,
}

thread_local! {
    static STATE: RefCell<Option<MainState>> = const { RefCell::new(None) };
}

static TRANSACTION_ID: AtomicU32 = AtomicU32::new(1);

fn on_main(f: impl FnOnce() + Send + 'static) {
    DispatchQueue::main().exec_async(f);
}

/// Main thread: start the browser once.
fn ensure_browser() {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        if s.is_some() {
            return;
        }
        let browser_delegate = BrowserDelegate::new();
        let browser = unsafe { ICDeviceBrowser::new() };
        unsafe {
            browser.setDelegate(Some(ProtocolObject::from_ref(&*browser_delegate)));
            browser.setBrowsedDeviceTypeMask(ICDeviceTypeMask(ICDeviceTypeMask::Camera.0 | ICDeviceLocationTypeMask::Local.0));
        }
        *s = Some(MainState {
            _browser: browser.clone(),
            _browser_delegate: browser_delegate,
            device_delegate: DeviceDelegate::new(),
            cameras: Vec::new(),
            pending: None,
            active: None,
        });
        drop(s);
        unsafe { browser.start() };
    });
}

/// Start looking for cameras now, so the first session does not wait for a cold browser.
pub(crate) fn start_discovery() {
    on_main(ensure_browser);
}

/// Main thread: if a session is waiting and a matching camera is known, open it.
fn try_open_pending() {
    let camera = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let state = s.as_mut()?;
        let hint = state.pending.as_ref()?;
        let camera = state.cameras.iter().find(|c| unsafe { c.name() }.is_some_and(|n| n.to_string().contains(hint.as_str())))?.clone();
        unsafe { camera.setDelegate(Some(ProtocolObject::from_ref(&*state.device_delegate))) };
        state.pending = None;
        state.active = Some(camera.clone());
        Some(camera)
    });
    if let Some(camera) = camera {
        unsafe { camera.requestOpenSession() };
    }
}

/// An open session. Dropping it closes the session; the browser keeps running.
pub(crate) struct Session {
    events: Mutex<Receiver<Event>>,
}

impl Session {
    pub(crate) fn open(hint: &str, timeout: Duration) -> Result<Session, PtpError> {
        if MainThreadMarker::new().is_some() {
            return Err(PtpError::Transport("camera calls must not run on the main thread".into()));
        }
        if SESSION_ACTIVE.swap(true, Ordering::SeqCst) {
            return Err(PtpError::Session("another camera session is already open".into()));
        }
        let (tx, rx) = channel();
        *EVENTS.lock().unwrap() = Some(tx);
        // From here on, dropping `session` closes whatever was opened and releases SESSION_ACTIVE.
        let session = Session { events: Mutex::new(rx) };
        let hint = hint.to_string();
        on_main(move || {
            ensure_browser();
            STATE.with(|s| {
                if let Some(state) = s.borrow_mut().as_mut() {
                    state.pending = Some(hint);
                }
            });
            try_open_pending();
        });
        let got = session.events.lock().unwrap().recv_timeout(timeout + Duration::from_secs(20));
        match got {
            Ok(Event::Opened(Ok(()))) => Ok(session),
            Ok(Event::Opened(Err(e))) => Err(PtpError::Session(e)),
            Ok(_) => Err(PtpError::Session("camera disconnected".into())),
            Err(_) => {
                // Distinguish "never found" from "found but the session did not open".
                let (found_tx, found_rx) = channel();
                on_main(move || {
                    let found = STATE.with(|s| s.borrow().as_ref().is_some_and(|st| st.active.is_some()));
                    let _ = found_tx.send(found);
                });
                match found_rx.recv_timeout(Duration::from_secs(2)) {
                    Ok(true) => Err(PtpError::Timeout("the session to open")),
                    _ => Err(PtpError::NoCamera),
                }
            }
        }
    }

    /// Run one PTP transaction. Returns the response code and the data-in phase.
    pub(crate) fn transaction(&self, op: u16, params: &[u32], out: Option<Vec<u8>>, timeout: Duration) -> Result<(u16, Vec<u8>), PtpError> {
        let tid = TRANSACTION_ID.fetch_add(1, Ordering::SeqCst);
        let mut cmd = Vec::with_capacity(12 + 4 * params.len());
        cmd.extend(((12 + 4 * params.len()) as u32).to_le_bytes());
        cmd.extend(1u16.to_le_bytes());
        cmd.extend(op.to_le_bytes());
        cmd.extend(tid.to_le_bytes());
        for p in params {
            cmd.extend(p.to_le_bytes());
        }
        let (tx, rx) = channel::<Result<(u16, Vec<u8>), String>>();
        on_main(move || {
            let camera = STATE.with(|s| s.borrow().as_ref().and_then(|st| st.active.clone()));
            let Some(camera) = camera else {
                let _ = tx.send(Err("camera is gone".into()));
                return;
            };
            let command = NSData::with_bytes(&cmd);
            let data = out.as_deref().map(NSData::with_bytes);
            // The generated binding types both NSData arguments as non-null, but ImageCaptureCore
            // passes nil for the data-in phase of a write. Declare them nullable and send the
            // message directly so a nil never reaches a non-null Rust type.
            let done = RcBlock::new(move |in_data: *mut NSData, response: *mut NSData, error: *mut NSError| {
                let in_data = unsafe { in_data.as_ref() }.map(|d| d.to_vec()).unwrap_or_default();
                let response = unsafe { response.as_ref() }.map(|d| d.to_vec()).unwrap_or_default();
                let result = if let Some(e) = unsafe { error.as_ref() } {
                    Err(e.localizedDescription().to_string())
                } else if response.len() >= 8 {
                    Ok((u16::from_le_bytes([response[6], response[7]]), in_data))
                } else {
                    Err("short PTP response".into())
                };
                let _ = tx.send(result);
            });
            let block: &block2::Block<dyn Fn(*mut NSData, *mut NSData, *mut NSError)> = &done;
            let _: () = unsafe { msg_send![&*camera, requestSendPTPCommand: &*command, outData: data.as_deref(), completion: block] };
        });
        rx.recv_timeout(timeout).map_err(|_| PtpError::Timeout("the camera to answer"))?.map_err(PtpError::Transport)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        on_main(|| {
            let camera = STATE.with(|s| {
                let mut s = s.borrow_mut();
                let state = s.as_mut()?;
                state.pending = None;
                state.active.take()
            });
            match camera {
                Some(cam) => unsafe { cam.requestCloseSession() },
                None => send(Event::Closed),
            }
        });
        // Wait for the close to finish so the next session can open the camera again.
        let _ = self.events.lock().unwrap().recv_timeout(Duration::from_secs(5));
        *EVENTS.lock().unwrap() = None;
        SESSION_ACTIVE.store(false, Ordering::SeqCst);
    }
}

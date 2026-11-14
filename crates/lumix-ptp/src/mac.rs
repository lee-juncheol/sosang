//! ImageCaptureCore transport. All ImageCaptureCore objects live on the main thread (kept in a
//! thread-local there); callers block on channels from another thread.

use crate::PtpError;
use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass, MainThreadMarker, Message};
use objc2_core_graphics::CGImage;
use objc2_foundation::{NSArray, NSData, NSDictionary, NSError, NSObject, NSObjectProtocol};
use objc2_image_capture_core::{
    ICCameraDevice, ICCameraDeviceDelegate, ICCameraItem, ICDevice, ICDeviceBrowser, ICDeviceBrowserDelegate, ICDeviceDelegate,
    ICDeviceLocationTypeMask, ICDeviceTypeMask,
};
use std::cell::RefCell;

use std::sync::mpsc::{channel, Sender};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

enum Event {
    Found,
    Opened(Result<(), String>),
    Removed,
}

struct BrowserIvars {
    hint: String,
    events: Sender<Event>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "LumixLutBrowserDelegate"]
    #[ivars = BrowserIvars]
    struct BrowserDelegate;

    unsafe impl NSObjectProtocol for BrowserDelegate {}

    unsafe impl ICDeviceBrowserDelegate for BrowserDelegate {
        #[unsafe(method(deviceBrowser:didAddDevice:moreComing:))]
        fn did_add(&self, _browser: &ICDeviceBrowser, device: &ICDevice, _more: bool) {
            let Some(camera) = device.downcast_ref::<ICCameraDevice>() else { return };
            let name = unsafe { camera.name() }.map(|n| n.to_string()).unwrap_or_default();
            if !name.contains(&self.ivars().hint) {
                return;
            }
            let found = STATE.with(|s| {
                let mut s = s.borrow_mut();
                let Some(state) = s.as_mut() else { return false };
                if state.camera.is_some() {
                    return false;
                }
                unsafe { camera.setDelegate(Some(ProtocolObject::from_ref(&*state.device_delegate))) };
                state.camera = Some(camera.retain());
                true
            });
            if found {
                let _ = self.ivars().events.send(Event::Found);
            }
        }

        #[unsafe(method(deviceBrowser:didRemoveDevice:moreGoing:))]
        fn did_remove(&self, _browser: &ICDeviceBrowser, _device: &ICDevice, _more: bool) {}
    }
);

impl BrowserDelegate {
    fn new(ivars: BrowserIvars) -> Retained<Self> {
        let this = Self::alloc().set_ivars(ivars);
        unsafe { msg_send![super(this), init] }
    }
}

struct DeviceIvars {
    events: Sender<Event>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "LumixLutDeviceDelegate"]
    #[ivars = DeviceIvars]
    struct DeviceDelegate;

    unsafe impl NSObjectProtocol for DeviceDelegate {}

    unsafe impl ICDeviceDelegate for DeviceDelegate {
        #[unsafe(method(didRemoveDevice:))]
        fn did_remove_device(&self, _device: &ICDevice) {
            let _ = self.ivars().events.send(Event::Removed);
        }

        #[unsafe(method(device:didOpenSessionWithError:))]
        fn did_open(&self, _device: &ICDevice, error: Option<&NSError>) {
            let r = match error {
                None => Ok(()),
                Some(e) => Err(e.localizedDescription().to_string()),
            };
            let _ = self.ivars().events.send(Event::Opened(r));
        }

        #[unsafe(method(device:didCloseSessionWithError:))]
        fn did_close(&self, _device: &ICDevice, _error: Option<&NSError>) {}
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
    fn new(ivars: DeviceIvars) -> Retained<Self> {
        let this = Self::alloc().set_ivars(ivars);
        unsafe { msg_send![super(this), init] }
    }
}

struct MainState {
    browser: Retained<ICDeviceBrowser>,
    _browser_delegate: Retained<BrowserDelegate>,
    device_delegate: Retained<DeviceDelegate>,
    camera: Option<Retained<ICCameraDevice>>,
}

thread_local! {
    static STATE: RefCell<Option<MainState>> = const { RefCell::new(None) };
}

static TRANSACTION_ID: AtomicU32 = AtomicU32::new(1);

fn on_main(f: impl FnOnce() + Send + 'static) {
    DispatchQueue::main().exec_async(f);
}

/// An open session. Dropping it closes the session and stops the browser.
pub(crate) struct Session {
    events: std::sync::Mutex<std::sync::mpsc::Receiver<Event>>,
}

impl Session {
    pub(crate) fn open(hint: &str, timeout: Duration) -> Result<Session, PtpError> {
        if MainThreadMarker::new().is_some() {
            return Err(PtpError::Transport("camera calls must not run on the main thread".into()));
        }
        let (tx, rx) = channel();
        let hint = hint.to_string();
        let busy = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let busy2 = busy.clone();
        on_main(move || {
            STATE.with(|s| {
                let mut s = s.borrow_mut();
                if s.is_some() {
                    busy2.store(true, Ordering::SeqCst);
                    let _ = tx.send(Event::Removed);
                    return;
                }
                let device_delegate = DeviceDelegate::new(DeviceIvars { events: tx.clone() });
                let browser_delegate = BrowserDelegate::new(BrowserIvars { hint, events: tx });
                let browser = unsafe { ICDeviceBrowser::new() };
                unsafe {
                    browser.setDelegate(Some(ProtocolObject::from_ref(&*browser_delegate)));
                    browser.setBrowsedDeviceTypeMask(ICDeviceTypeMask(ICDeviceTypeMask::Camera.0 | ICDeviceLocationTypeMask::Local.0));
                }
                *s = Some(MainState { browser: browser.clone(), _browser_delegate: browser_delegate, device_delegate, camera: None });
                drop(s);
                unsafe { browser.start() };
            });
        });
        let session = Session { events: std::sync::Mutex::new(rx) };
        match session.wait(timeout, "the camera to appear")? {
            Event::Found => {}
            _ if busy.load(Ordering::SeqCst) => return Err(PtpError::Session("another camera session is already open".into())),
            _ => return Err(PtpError::NoCamera),
        }
        on_main(|| {
            STATE.with(|s| {
                if let Some(cam) = s.borrow().as_ref().and_then(|st| st.camera.clone()) {
                    unsafe { cam.requestOpenSession() };
                }
            })
        });
        match session.wait(Duration::from_secs(20), "the session to open")? {
            Event::Opened(Ok(())) => Ok(session),
            Event::Opened(Err(e)) => Err(PtpError::Session(e)),
            _ => Err(PtpError::Session("camera disconnected".into())),
        }
    }

    fn wait(&self, timeout: Duration, what: &'static str) -> Result<Event, PtpError> {
        self.events.lock().unwrap().recv_timeout(timeout).map_err(|_| PtpError::Timeout(what))
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
            let camera = STATE.with(|s| s.borrow().as_ref().and_then(|st| st.camera.clone()));
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
            STATE.with(|s| {
                if let Some(st) = s.borrow_mut().take() {
                    if let Some(cam) = &st.camera {
                        unsafe { cam.requestCloseSession() };
                    }
                    unsafe { st.browser.stop() };
                }
            })
        });
    }
}

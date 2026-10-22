//! The clipboard over `ext-data-control-v1`: [`watch`] receives every new
//! selection, [`serve`] owns the selection until something else replaces it.

use std::io::{Read, Write};
use std::os::fd::AsFd;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use wayland_client::globals::{GlobalList, GlobalListContents, registry_queue_init};
use wayland_client::protocol::{wl_registry, wl_seat::WlSeat};
use wayland_client::{Connection, Dispatch, EventQueue, Proxy, QueueHandle, event_created_child};
use wayland_protocols::ext::data_control::v1::client::{
    ext_data_control_device_v1::{self, ExtDataControlDeviceV1},
    ext_data_control_manager_v1::ExtDataControlManagerV1,
    ext_data_control_offer_v1::{self, ExtDataControlOfferV1},
    ext_data_control_source_v1::{self, ExtDataControlSourceV1},
};

use crate::{Error, Kind, Result, mime, store::MAX_BYTES};

/// One received selection.
pub struct Capture {
    pub kind: Kind,
    pub mime: String,
    pub data: Vec<u8>,
    /// When the selection arrived, not when its transfer finished, so a slow
    /// read cannot land ahead of a newer selection.
    pub at_ms: i64,
}

#[derive(Default)]
struct State {
    /// Watch mode: where received selections go.
    captures: Option<Sender<Capture>>,
    /// The offer behind the current selection, destroyed when it is replaced.
    current: Option<ExtDataControlOfferV1>,
    /// Serve mode: the payload and the mimes it is offered under.
    payload: Option<(Vec<String>, Arc<Vec<u8>>)>,
    /// Our source was replaced, or the compositor ended the data device.
    done: bool,
}

fn wl(e: impl std::fmt::Display) -> Error {
    Error::Wayland(e.to_string())
}

fn connect() -> Result<(Connection, GlobalList, EventQueue<State>)> {
    let conn = Connection::connect_to_env().map_err(wl)?;
    let (globals, queue) = registry_queue_init::<State>(&conn).map_err(wl)?;
    Ok((conn, globals, queue))
}

fn bind_device(
    globals: &GlobalList,
    qh: &QueueHandle<State>,
) -> Result<(ExtDataControlManagerV1, ExtDataControlDeviceV1)> {
    let manager: ExtDataControlManagerV1 =
        globals.bind(qh, 1..=1, ()).map_err(|_| Error::NoDataControl)?;
    let seat: WlSeat =
        globals.bind(qh, 1..=9, ()).map_err(|e| Error::Wayland(format!("no seat: {e}")))?;
    let device = manager.get_data_device(&seat, qh, ());
    Ok((manager, device))
}

/// Send every new clipboard selection to `captures` until the compositor ends
/// the data device. Each transfer is read on its own thread, so a source that
/// never closes its pipe stalls only itself.
pub fn watch(captures: Sender<Capture>) -> Result<()> {
    let (_conn, globals, mut queue) = connect()?;
    let (_manager, _device) = bind_device(&globals, &queue.handle())?;
    let mut state = State { captures: Some(captures), ..State::default() };
    while !state.done {
        queue.blocking_dispatch(&mut state).map_err(wl)?;
    }
    Err(Error::Wayland("the compositor finished the data device".into()))
}

/// Make `data` the clipboard selection and serve it until another selection
/// replaces it. `ready` runs once the compositor has accepted the selection.
pub fn serve(kind: Kind, mime: &str, data: Vec<u8>, ready: impl FnOnce()) -> Result<()> {
    let (_conn, globals, mut queue) = connect()?;
    let qh = queue.handle();
    let (manager, device) = bind_device(&globals, &qh)?;
    let mut mimes = vec![mime.to_string()];
    if kind == Kind::Text {
        let aliases = mime::PLAIN_TEXT.iter().filter(|a| !a.eq_ignore_ascii_case(mime));
        mimes.extend(aliases.map(|a| a.to_string()));
    }
    let source = manager.create_data_source(&qh, ());
    for m in &mimes {
        source.offer(m.clone());
    }
    device.set_selection(Some(&source));
    let mut state = State { payload: Some((mimes, Arc::new(data))), ..State::default() };
    queue.roundtrip(&mut state).map_err(wl)?;
    ready();
    while !state.done {
        queue.blocking_dispatch(&mut state).map_err(wl)?;
    }
    Ok(())
}

fn receive(offer: &ExtDataControlOfferV1, conn: &Connection, captures: &Sender<Capture>) {
    let offered = offer.data::<Mutex<Vec<String>>>().map(|m| m.lock().unwrap().clone());
    let Some((kind, mime)) =
        offered.as_deref().and_then(mime::best).map(|(k, m)| (k, m.to_string()))
    else {
        return;
    };
    let (mut reader, writer) = match std::io::pipe() {
        Ok(p) => p,
        Err(e) => return tracing::warn!("clipboard pipe: {e}"),
    };
    offer.receive(mime.clone(), writer.as_fd());
    drop(writer);
    if let Err(e) = conn.flush() {
        return tracing::warn!("clipboard flush: {e}");
    }
    let captures = captures.clone();
    let at_ms = tt_config::now_ms();
    std::thread::spawn(move || {
        let mut data = Vec::new();
        let limit = (MAX_BYTES + 1) as u64;
        match (&mut reader).take(limit).read_to_end(&mut data) {
            Ok(_) if data.len() <= MAX_BYTES => {
                let _ = captures.send(Capture { kind, mime, data, at_ms });
            }
            Ok(_) => tracing::info!("skipping a {mime} selection over {MAX_BYTES} bytes"),
            Err(e) => tracing::warn!("reading a {mime} selection: {e}"),
        }
    });
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<WlSeat, ()> for State {
    fn event(
        _: &mut Self,
        _: &WlSeat,
        _: <WlSeat as Proxy>::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ExtDataControlManagerV1, ()> for State {
    fn event(
        _: &mut Self,
        _: &ExtDataControlManagerV1,
        _: <ExtDataControlManagerV1 as Proxy>::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ExtDataControlDeviceV1, ()> for State {
    fn event(
        state: &mut Self,
        device: &ExtDataControlDeviceV1,
        event: ext_data_control_device_v1::Event,
        _: &(),
        conn: &Connection,
        _: &QueueHandle<Self>,
    ) {
        use ext_data_control_device_v1::Event;
        match event {
            Event::Selection { id } => {
                if let Some(old) = state.current.take() {
                    old.destroy();
                }
                if let (Some(offer), Some(captures)) = (&id, &state.captures) {
                    receive(offer, conn, captures);
                }
                state.current = id;
            }
            Event::PrimarySelection { id: Some(offer) } => offer.destroy(),
            Event::Finished => {
                device.destroy();
                state.done = true;
            }
            _ => {}
        }
    }

    event_created_child!(State, ExtDataControlDeviceV1, [
        ext_data_control_device_v1::EVT_DATA_OFFER_OPCODE => (ExtDataControlOfferV1, Mutex::new(Vec::new())),
    ]);
}

impl Dispatch<ExtDataControlOfferV1, Mutex<Vec<String>>> for State {
    fn event(
        _: &mut Self,
        _: &ExtDataControlOfferV1,
        event: ext_data_control_offer_v1::Event,
        mimes: &Mutex<Vec<String>>,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let ext_data_control_offer_v1::Event::Offer { mime_type } = event {
            mimes.lock().unwrap().push(mime_type);
        }
    }
}

impl Dispatch<ExtDataControlSourceV1, ()> for State {
    fn event(
        state: &mut Self,
        source: &ExtDataControlSourceV1,
        event: ext_data_control_source_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        use ext_data_control_source_v1::Event;
        match event {
            Event::Send { mime_type, fd } => {
                let Some((mimes, data)) = &state.payload else {
                    return;
                };
                if !mimes.contains(&mime_type) {
                    return;
                }
                // On its own thread, so a target that never reads stalls only itself;
                // one that closes early is its business, not an error here.
                let data = Arc::clone(data);
                std::thread::spawn(move || {
                    let _ = std::fs::File::from(fd).write_all(&data);
                });
            }
            Event::Cancelled => {
                source.destroy();
                state.done = true;
            }
            _ => {}
        }
    }
}

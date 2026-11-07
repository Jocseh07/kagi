use crate::assets::{AssetEvent, Assets};
use crate::engine::{CommandMessage, Engine, Message};
use crate::protocol::*;
use crate::theme;
use crate::resolution::Resolutions;
use rune::{TextEdit, Tx, Waker};
use rune_kit::Kit;
use serde_json::{Value, json};
use std::cell::Cell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct Destination { pub route: String, pub params: Value }
struct Pending { route_key: String, kind: PendingKind, cancelable: bool, cancel_requested: bool }
enum PendingKind { Navigate(Destination), Action(String, Option<Destination>), Progress, Cancel(u64) }

pub struct State {
    pub screen: Arc<Screen>,
    pub revision: u64,
    pub drafts: BTreeMap<String, TextEdit>,
    pub error: Option<String>,
    pub notice: Option<String>,
    pub failure: Option<String>,
    pub kit: Kit,
    pub reader_kit: Kit,
    appearance_changed: Cell<bool>,
    pub system_dark: Cell<bool>,
    pub fonts_ready: bool,
    pub font_error: Option<String>,
    pub assets: Option<Assets>,
    pub images: Option<Resolutions>,
    pub reader_top: f32,
    pub reader_height: f32,
    pub menu: bool,
    pub select: Option<String>,
    pub confirmation: Option<Action>,
    pub picking: bool,
    pub width: f32,
    pub height: f32,
    pub position: f64,
    pub reader_scroll: Rc<Cell<(f32, f32)>>,
    pub reader_restore: bool,
    pub dimmed: bool,
    pub reader_anchor: Option<String>,
    pub reader_content_ready: bool,
    pub closing: bool,
    pub restarting: bool,
    pub settings_open: bool,
    pub app_handle: Option<rune::AppHandle<State>>,
    engine: Option<Engine>,
    pending: HashMap<u64, Pending>,
    next_id: u64,
    navigation: Option<u64>,
    history: Vec<Destination>,
    destination: Destination,
    last_progress: Instant,
    sent_position: f64,
    progress_failed: bool,
    font_signature: Option<(Vec<String>, String, String, String)>,
    font_generation: u64,
    font_pending: bool,
    wake: Option<Waker>,
    shutdown_sent: bool,
    engine_stopped: bool,
    idle_started: Instant,
    last_input: Option<Instant>,
}

impl State {
    pub fn new() -> Self {
        Self {
            screen: Arc::new(Screen { route: "home".into(), title: "Home".into(), sections: vec![Section {
                id: "startup".into(), status: Some("loading".into()), ..Section::default()
            }], ..Screen::default() }),
            drafts: BTreeMap::new(), error: None, notice: None, failure: None,
            revision: 0,
            kit: Kit::neutral(false), assets: None, menu: false, select: None,
            confirmation: None, picking: false, width: theme::FRAME, height: theme::COMPACT,
            position: 0.0, reader_scroll: Rc::new(Cell::new((0.0, 0.0))), reader_restore: false,
            closing: false, settings_open: false, engine: None, pending: HashMap::new(), next_id: 1,
            navigation: None, history: Vec::new(), destination: Destination { route: "home".into(), params: json!({}) },
            last_progress: Instant::now(), sent_position: f64::NAN,
            progress_failed: false,
            font_signature: None, font_generation: 0, font_pending: false,
            system_dark: Cell::new(false), fonts_ready: false, font_error: None,
            reader_kit: Kit::neutral(false), appearance_changed: Cell::new(false),
            wake: None, shutdown_sent: false, images: None,
            reader_top: 0.0, reader_height: theme::COMPACT,
            app_handle: None, engine_stopped: false,
            dimmed: false, reader_anchor: None, reader_content_ready: false,
            idle_started: Instant::now(), last_input: None,
            restarting: false,
        }
    }

    pub fn setup(&mut self, wake: Waker) {
        self.assets = Some(Assets::start(wake.clone()));
        let engine = Engine::start(wake.clone());
        self.images = Some(Resolutions::new(engine.send.clone()));
        self.engine = Some(engine);
        self.wake = Some(wake);
        self.navigate("home", json!({}), false);
    }

    pub fn restart(&mut self) {
        if self.busy() || self.closing { return; }
        self.flush_progress();
        self.pending.clear();
        self.navigation = None;
        if !self.engine_stopped {
            self.restarting = true;
            self.failure = Some("Restarting engine".into());
            if let Some(engine) = &self.engine { let _ = engine.send.send(CommandMessage::Shutdown); }
        } else { self.launch_engine(); }
    }

    fn launch_engine(&mut self) {
        if let Some(wake) = self.wake.clone() {
            let engine = Engine::start(wake);
            self.images = Some(Resolutions::new(engine.send.clone()));
            self.engine = Some(engine);
            self.engine_stopped = false;
            self.restarting = false;
            self.failure = None;
            self.sent_position = f64::NAN;
            self.refresh();
        }
    }

    fn request(&mut self, method: &str, params: Value, kind: PendingKind) -> Option<u64> {
        let id = self.next_id;
        self.next_id += 1;
        let request = Request { id, method: method.into(), params };
        match self.engine.as_ref().map(|engine| engine.send.send(CommandMessage::Request(request))) {
            Some(Ok(())) => {
                self.pending.insert(id, Pending { route_key: self.screen.route_key.clone(), kind, cancelable: false, cancel_requested: false });
                Some(id)
            }
            _ => { self.failure = Some("The engine stopped. Restart Kagi to reconnect.".into()); None }
        }
    }

    pub fn busy(&self) -> bool {
        self.restarting || self.picking || self.pending.values().any(|pending| matches!(pending.kind, PendingKind::Action(..)))
    }

    pub fn action_pending(&self, id: &str) -> bool {
        self.pending.values().any(|pending| matches!(&pending.kind, PendingKind::Action(action, _) if action == id))
    }

    pub fn cancellation(&self) -> Option<(String, bool)> {
        self.pending.values().find_map(|pending| {
            if let PendingKind::Action(id, _) = &pending.kind {
                if pending.cancelable { return Some((id.clone(), pending.cancel_requested)); }
            }
            None
        })
    }

    pub fn cancel_action(&mut self, action_id: &str) {
        let request_id = self.pending.iter().find_map(|(id, pending)| {
            (pending.cancelable && !pending.cancel_requested && matches!(&pending.kind, PendingKind::Action(action, _) if action == action_id)).then_some(*id)
        });
        if let Some(request_id) = request_id {
            if self.request("cancel", json!({"requestId": request_id}), PendingKind::Cancel(request_id)).is_some() {
                if let Some(pending) = self.pending.get_mut(&request_id) { pending.cancel_requested = true; }
            }
        }
    }

    pub fn waker(&self) -> Option<Waker> { self.wake.clone() }

    fn anchor_reader(&self, tx: &mut Tx) {
        if let Some(reader) = &self.screen.reader {
            let key = if reader.kind == "novel" { self.reader_anchor.clone() }
                else { Some(format!("reader-page-{}", self.position.floor() as usize)) };
            if let Some(key) = key { tx.keep_on_screen(key); }
        }
    }

    pub fn wake_reader(&mut self) {
        self.dimmed = false;
        self.idle_started = Instant::now();
    }

    pub fn navigating(&self) -> bool { self.navigation.is_some() }

    pub fn navigate(&mut self, route: &str, params: Value, remember: bool) {
        if self.busy() || self.closing { return; }
        self.flush_progress();
        if remember { self.history.push(self.destination.clone()); }
        self.menu = false;
        self.select = None;
        self.error = None;
        let destination = Destination { route: route.into(), params };
        self.navigation = self.request("navigate", json!({"route": destination.route, "params": destination.params}), PendingKind::Navigate(destination));
    }

    pub fn back(&mut self) {
        if self.busy() { return; }
        if let Some(destination) = self.history.pop() { self.navigate(&destination.route, destination.params, false); }
        else if self.screen.route != "home" { self.navigate("home", json!({}), false); }
    }

    pub fn can_back(&self) -> bool { !self.history.is_empty() || self.screen.route != "home" }

    pub fn refresh(&mut self) {
        let destination = self.destination.clone();
        self.navigate(&destination.route, destination.params, false);
    }

    pub fn values(&self) -> Values { self.drafts.iter().map(|(key, edit)| (key.clone(), edit.text.clone())).collect() }

    pub fn activate(&mut self, action: Action, tx: &mut Tx) {
        if self.busy() || self.navigating() || self.closing || self.failure.is_some() { return; }
        if action.confirm.is_some() || action.variant.as_deref() == Some("danger") {
            self.confirmation = Some(action);
            return;
        }
        self.pick_or_send(action, tx);
    }

    pub fn pick_or_send(&mut self, action: Action, tx: &mut Tx) {
        self.confirmation = None;
        let Some(pick) = action.pick.clone() else { self.send_action(action, Vec::new()); return; };
        self.picking = true;
        let options = rune::FileDialogOptions {
            title: action.label.clone(),
            filters: if action.accept.is_empty() { Vec::new() } else { vec![(action.label.clone(), action.accept.iter().map(|extension| extension.trim_start_matches('.').to_owned()).collect())] },
            ..Default::default()
        };
        let answer = move |state: &mut Self, result: rune::FileDialogResult, _: &mut Tx| {
            state.picking = false;
            match result {
                Ok(Some(path)) => state.send_action(action.clone(), vec![path.to_string_lossy().into_owned()]),
                Ok(None) => { state.notice = Some("File selection canceled".into()); }
                Err(error) => state.error = Some(error.to_string()),
            }
        };
        match pick.as_str() {
            "file" => tx.open_file(options, answer),
            "folder" => tx.open_folder(options, answer),
            "save" => tx.save_file(options, answer),
            _ => { self.picking = false; self.error = Some("This file picker is not supported.".into()); }
        }
    }

    fn send_action(&mut self, action: Action, paths: Vec<String>) {
        if self.busy() { return; }
        self.error = None;
        self.notice = None;
        if self.screen.reader.is_some() { self.flush_progress(); }
        let destination = if action.method == "navigate" {
            action.params.as_ref().and_then(|params| params.get("route").and_then(Value::as_str).map(|route| {
                let mut values = params.clone();
                if let Some(values) = values.as_object_mut() { values.remove("route"); }
                Destination { route: route.into(), params: values }
            }))
        } else { None };
        let values = self.values();
        let mut params = json!({"action": action, "values": values});
        if !paths.is_empty() { params["selectedPaths"] = json!(paths); }
        if let Some(id) = self.request("action", params, PendingKind::Action(action.id, destination)) {
            if let Some(pending) = self.pending.get_mut(&id) { pending.cancelable = action.cancelable == Some(true); }
        }
    }

    fn seed_fields(&mut self, fields: &[Field], preserve: bool) {
        for field in fields {
            let changed = self.screen.sections.iter().flat_map(|section| &section.fields)
                .chain(self.screen.dialog.iter().flat_map(|dialog| &dialog.fields))
                .find(|previous| previous.id == field.id).is_some_and(|previous| previous.value != field.value);
            if !preserve || !self.drafts.contains_key(&field.id) || changed {
                let mut edit = TextEdit::new(field.value.clone());
                edit.set_secure(field.kind == "password");
                self.drafts.insert(field.id.clone(), edit);
            }
        }
    }

    fn has_edits(&self) -> bool {
        self.screen.sections.iter().flat_map(|section| &section.fields)
            .chain(self.screen.dialog.iter().flat_map(|dialog| &dialog.fields))
            .any(|field| self.drafts.get(&field.id).is_some_and(|draft| draft.text != field.value))
    }

    fn land_screen(&mut self, mut screen: Screen, keep_drafts: bool, tx: &mut Tx) {
        let same_reader = self.screen.reader.as_ref().zip(screen.reader.as_ref()).is_some_and(|(old, new)| old.chapter_id == new.chapter_id);
        if !same_reader { self.flush_progress(); }
        if self.screen.route == screen.route {
            let previous = Arc::make_mut(&mut self.screen);
            for next in &mut screen.sections {
                if let Some(old) = previous.sections.iter_mut().find(|old| old.id == next.id) { retain_section(next, old); }
            }
        }
        if !keep_drafts { self.drafts.clear(); }
        for section in &screen.sections { self.seed_fields(&section.fields, keep_drafts); }
        if let Some(dialog) = &screen.dialog { self.seed_fields(&dialog.fields, keep_drafts); }
        if !same_reader {
            self.position = screen.reader.as_ref().map_or(0.0, |reader| reader.position.max(0.0));
            self.reader_restore = screen.reader.is_some();
            self.reader_content_ready = false;
            self.reader_anchor = None;
            self.idle_started = Instant::now();
            self.last_input = rune::last_input();
            self.dimmed = false;
            self.reader_scroll.set((0.0, 0.0));
            self.sent_position = f64::NAN;
            self.progress_failed = false;
            self.settings_open = false;
        }
        if screen.route == "reader" {
            if let Some(reader) = &screen.reader { self.reader_destination(reader); }
        }
        self.screen = Arc::new(screen);
        self.revision = self.revision.wrapping_add(1);
        self.select = None;
        self.confirmation = None;
        self.failure = None;
        self.kit = theme::kit(&self.screen.theme, self.system_dark.get());
        self.reader_kit = theme::reader_kit(&self.screen.theme, self.screen.reader.as_ref().and_then(|reader| reader.surface.as_deref()), self.system_dark.get());
        self.sync_fonts();
        tx.instant();
    }

    fn reader_destination(&mut self, reader: &Reader) {
        if self.destination.route != "reader" { return; }
        if self.destination.params.get("chapterId").and_then(Value::as_str).is_some_and(|id| id != reader.chapter_id) {
            self.history.push(self.destination.clone());
        }
        self.destination = Destination { route: "reader".into(), params: json!({"mangaId": reader.series_id, "chapterId": reader.chapter_id}) };
    }

    fn sync_fonts(&mut self) {
        let family = |name: &str, fallback: &str| theme::token(&self.screen.theme, name).unwrap_or(fallback).to_owned();
        let sans = family("font-sans", "Inter");
        let mono = family("font-mono", "JetBrains Mono");
        let reading = self.screen.reader.as_ref().is_some_and(|reader| reader.kind == "novel");
        let reader = if reading {
            self.screen.reader.as_ref().and_then(|reader| reader.font_family.clone()).unwrap_or_else(|| family("font-serif", "Source Serif 4"))
        } else { sans.clone() };
        let first = |name: &str| name.split(',').next().unwrap_or(name).trim().trim_matches(|ch| ch == char::from(39) || ch == '"').to_owned();
        let names = [first(&sans), first(&mono), first(&reader)];
        let mut paths: Vec<String> = self.screen.fonts.iter().filter(|font| names.contains(&font.family)).map(|font| font.path.clone()).collect();
        paths.sort();
        paths.dedup();
        let signature = (paths, sans, mono, reader);
        if self.font_signature.as_ref() == Some(&signature) { return; }
        if reading && !self.screen.fonts.iter().any(|font| font.family == names[2]) {
            self.font_error = Some(format!("Missing font: {}. Retry font loading.", names[2]));
            self.fonts_ready = false;
            return;
        }
        if let Some(assets) = &self.assets {
            let generation = self.font_generation + 1;
            if assets.fonts(generation, signature.0.clone(), signature.1.clone(), signature.2.clone(), signature.3.clone()) {
                self.font_generation = generation;
                self.font_pending = true;
                if reading { self.reader_restore = true; self.reader_content_ready = false; }
                self.fonts_ready = false;
                self.font_error = None;
                self.font_signature = Some(signature);
            }
        }
    }

    pub fn retry_fonts(&mut self) { self.font_signature = None; self.sync_fonts(); }

    pub fn fonts_loading(&self) -> bool { self.font_pending }

    pub fn observe_appearance(&self, dark: bool) {
        if self.system_dark.replace(dark) != dark {
            self.appearance_changed.set(true);
            if let Some(wake) = &self.wake { wake(); }
        }
    }

    pub fn flush_progress(&mut self) {
        let Some(reader) = &self.screen.reader else { return; };
        if !self.reader_content_ready || self.reader_restore { return; }
        if reader.kind == "comic" {
            let Some(page) = reader.pages.get(self.position.floor() as usize) else { return; };
            if !crate::reader::image_ready(self, page.path.as_deref(), page.image_ref.as_ref()) { return; }
        }
        if self.sent_position == self.position { return; }
        let comic = reader.kind == "comic";
        let count = if comic { reader.pages.len() } else { theme::NOVEL_PROGRESS as usize };
        let position = if comic { self.position.floor() } else { self.position.round().clamp(0.0, theme::NOVEL_PROGRESS) };
        let offset = if comic { self.position.fract().clamp(0.0, 0.999) } else { 0.0 };
        let params = json!({"chapterId": reader.chapter_id, "position": position, "pageCount": count, "offset": offset});
        if self.request("reader.progress", params, PendingKind::Progress).is_some() {
            self.sent_position = self.position;
            self.progress_failed = false;
            self.last_progress = Instant::now();
        }
    }

    pub fn close(&mut self, tx: &mut Tx) {
        if self.engine_stopped { tx.quit(); return; }
        if self.closing { return; }
        self.flush_progress();
        let cancelable: Vec<String> = self.pending.values().filter_map(|pending| {
            if let PendingKind::Action(id, _) = &pending.kind {
                if pending.cancelable && !pending.cancel_requested { return Some(id.clone()); }
            }
            None
        }).collect();
        for id in cancelable { self.cancel_action(&id); }
        self.closing = true;
        tx.wake_after(Duration::from_millis(25));
    }

    pub fn poll(&mut self, tx: &mut Tx) -> bool {
        let mut changed = false;
        for _ in 0..64 {
            let message = self.engine.as_ref().and_then(|engine| engine.receive.try_recv().ok());
            let Some(message) = message else { break };
            changed = true;
            match message {
                Message::Incoming(Incoming::Event(event)) => match event {
                    Event::Section { route_key, mut section } if route_key == self.screen.route_key => {
                        self.seed_fields(&section.fields, true);
                        let screen = Arc::make_mut(&mut self.screen);
                        if let Some(old) = screen.sections.iter_mut().find(|old| old.id == section.id) {
                            retain_section(&mut section, old);
                            *old = section;
                        } else { screen.sections.push(section); }
                        self.revision = self.revision.wrapping_add(1);
                    }
                    Event::Reader { route_key, reader } if route_key == self.screen.route_key => {
                        let same = self.screen.reader.as_ref().is_some_and(|old| old.chapter_id == reader.chapter_id);
                        if !same {
                            self.flush_progress();
                            self.position = reader.position.max(0.0);
                            self.sent_position = f64::NAN;
                            self.progress_failed = false;
                            self.reader_restore = true;
                            self.reader_content_ready = false;
                            self.reader_anchor = None;
                            self.idle_started = Instant::now();
                            self.last_input = rune::last_input();
                            self.dimmed = false;
                            self.reader_scroll.set((0.0, 0.0));
                        }
                        self.reader_destination(&reader);
                        Arc::make_mut(&mut self.screen).reader = Some(reader);
                        self.revision = self.revision.wrapping_add(1);
                        self.reader_kit = theme::reader_kit(&self.screen.theme, self.screen.reader.as_ref().and_then(|reader| reader.surface.as_deref()), self.system_dark.get());
                        self.sync_fonts();
                        tx.instant();
                    }
                    Event::Notice { message } => self.notice = Some(message),
                    Event::Changed { topics } => {
                        if !topics.is_empty() && !self.busy() && !self.navigating() && self.screen.reader.is_none() && self.screen.dialog.is_none() && !self.has_edits() { self.refresh(); }
                    }
                    _ => {}
                },
                Message::Incoming(Incoming::Reply { id, ok, result, error }) => {
                    if self.images.as_ref().is_some_and(|images| images.accept(id, ok, &result, &error)) {
                        self.anchor_reader(tx);
                        continue;
                    }
                    let Some(pending) = self.pending.remove(&id) else { continue };
                    let active = match &pending.kind {
                        PendingKind::Navigate(_) => self.navigation == Some(id),
                        PendingKind::Progress => true,
                        _ => pending.route_key == self.screen.route_key,
                    };
                    if self.navigation == Some(id) { self.navigation = None; }
                    if !active { continue; }
                    if !ok {
                        let message = error.map_or_else(|| "The request failed. Try again.".into(), |error| format!("{} ({})", error.message, error.code));
                        self.error = Some(message);
                        if let PendingKind::Cancel(request_id) = &pending.kind {
                            if let Some(original) = self.pending.get_mut(request_id) { original.cancel_requested = false; }
                        }
                        if matches!(pending.kind, PendingKind::Progress) {
                            if pending.route_key == self.screen.route_key {
                                self.sent_position = f64::NAN;
                                self.progress_failed = true;
                            }
                        }
                        let unsaved = matches!(pending.kind, PendingKind::Progress)
                            || (matches!(pending.kind, PendingKind::Action(..)) && !pending.cancel_requested);
                        if self.closing && unsaved {
                            self.closing = false;
                            if let Some(handle) = &self.app_handle { handle.open(); }
                        }
                        continue;
                    }
                    if let PendingKind::Navigate(destination) = &pending.kind { self.destination = destination.clone(); }
                    if let PendingKind::Action(_, Some(destination)) = &pending.kind {
                        self.history.push(self.destination.clone());
                        self.destination = destination.clone();
                    }
                    if let Some(result) = result {
                        if let Some(screen) = result.screen {
                            let keep = matches!(pending.kind, PendingKind::Action(_, None)) && screen.route == self.screen.route;
                            self.land_screen(screen, keep, tx);
                        }
                        self.notice = result.notice.or(result.export_path.map(|path| format!("Export saved: {path}"))).or(self.notice.take());
                        if let Some(url) = result.external_url {
                            if let Err(error) = tx.open_url(&url) { self.error = Some(error.to_string()); }
                        }
                    }
                }
                Message::Failed(error) => { self.failure = Some(error); self.pending.clear(); self.navigation = None; }
                Message::OutputClosed => {
                    if !self.closing && self.failure.is_none() { self.failure = Some("The engine connection closed. Restart Kagi.".into()); }
                }
                Message::Stopped => {
                    self.engine_stopped = true;
                    if self.restarting && !self.closing {
                        self.pending.clear();
                        self.navigation = None;
                        self.launch_engine();
                        continue;
                    }
                    if self.closing { tx.quit(); }
                    else if !self.closing && self.failure.is_none() { self.failure = Some("The engine stopped. Restart Kagi to reconnect.".into()); }
                    self.pending.clear();
                    self.navigation = None;
                }
            }
        }
        for _ in 0..32 {
            let event = self.assets.as_ref().and_then(|assets| assets.events.try_recv().ok());
            let Some(event) = event else { break };
            changed = true;
            match event {
                AssetEvent::Image(path, image) => {
                    self.anchor_reader(tx);
                    if let Some(assets) = &self.assets { assets.insert(path, image); }
                }
                AssetEvent::Fonts(generation, result) if generation == self.font_generation => {
                    self.font_pending = false;
                    match result {
                        Ok(fonts) => {
                            tx.replace_font_set(fonts);
                            self.fonts_ready = true;
                            self.font_error = None;
                        }
                        Err(error) => { self.font_error = Some(format!("Could not load font: {error}")); self.fonts_ready = false; }
                    }
                }
                AssetEvent::Fonts(_, _) => {}
            }
        }
        if self.appearance_changed.replace(false) {
            self.kit = theme::kit(&self.screen.theme, self.system_dark.get());
            self.reader_kit = theme::reader_kit(&self.screen.theme, self.screen.reader.as_ref().and_then(|reader| reader.surface.as_deref()), self.system_dark.get());
            changed = true;
        }
        if let Some(reader) = &self.screen.reader {
            if reader.kind == "novel" && self.reader_content_ready {
                let (offset, maximum) = self.reader_scroll.get();
                if self.reader_restore {
                    tx.scroll_to_y("reader-scroll", maximum * self.position.clamp(0.0, theme::NOVEL_PROGRESS) as f32 / theme::NOVEL_PROGRESS as f32);
                    self.reader_restore = false;
                } else {
                    let position = if maximum <= 0.0 || offset >= maximum - theme::PROGRESS_END_TOLERANCE {
                        theme::NOVEL_PROGRESS
                    } else { ((offset / maximum) as f64 * theme::NOVEL_PROGRESS).round().clamp(0.0, theme::NOVEL_PROGRESS) };
                    if position != self.position { self.position = position; changed = true; }
                }
            } else if self.reader_restore && reader.mode == "continuous" && reader.kind == "comic" {
                let index = self.position.floor() as usize;
                if reader.pages.get(index).is_some() { tx.scroll_into_view_in("reader-scroll", format!("reader-page-{index}")); }
                else { self.reader_restore = false; }
            } else if reader.mode != "continuous" && reader.kind == "comic" { self.reader_restore = false; }
            if reader.dim_idle == Some(true) && !self.settings_open && self.screen.dialog.is_none() {
                let input = rune::last_input();
                if input != self.last_input {
                    self.last_input = input;
                    self.idle_started = input.unwrap_or_else(Instant::now);
                    if self.dimmed { self.dimmed = false; changed = true; }
                }
                let elapsed = self.idle_started.elapsed();
                if elapsed >= theme::DIM_AFTER {
                    if !self.dimmed { self.dimmed = true; changed = true; }
                } else { tx.wake_after(theme::DIM_AFTER - elapsed); }
            } else if self.dimmed { self.dimmed = false; changed = true; }
            if !self.reader_restore && !self.progress_failed && self.sent_position != self.position {
                let elapsed = self.last_progress.elapsed();
                if elapsed >= Duration::from_secs(2) { self.flush_progress(); }
                else { tx.wake_after(Duration::from_secs(2) - elapsed); }
            }
        }
        if self.closing {
            let unsettled = self.pending.values().any(|pending| matches!(pending.kind, PendingKind::Progress | PendingKind::Action(..)));
            if !self.shutdown_sent && !unsettled {
                if let Some(engine) = &self.engine {
                    let _ = engine.send.send(CommandMessage::Shutdown);
                    self.shutdown_sent = true;
                } else { tx.quit(); }
            }
        }
        changed
    }
}

impl Drop for State {
    fn drop(&mut self) {
        self.flush_progress();
        if let Some(engine) = &self.engine { let _ = engine.send.send(CommandMessage::Shutdown); }
    }
}

fn retain_section(next: &mut Section, old: &mut Section) {
    if matches!(next.status.as_deref(), Some("loading" | "error")) {
        if next.rows.is_empty() { next.rows = std::mem::take(&mut old.rows); }
        if next.fields.is_empty() { next.fields = std::mem::take(&mut old.fields); }
        if next.title.is_none() { next.title = old.title.take(); }
        if next.actions.is_empty() { next.actions = std::mem::take(&mut old.actions); }
        if next.layout.is_none() { next.layout = old.layout.take(); }
    }
}

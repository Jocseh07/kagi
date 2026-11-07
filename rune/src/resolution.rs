use crate::engine::CommandMessage;
use crate::protocol::{EngineError, ImageRef, Request, ResolvedImage, ResultData};
use serde_json::json;
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::Sender;
use std::sync::Arc;

const CAPACITY: usize = 192;
const IN_FLIGHT: usize = 12;

#[derive(Clone)]
pub enum ImageState { Loading, Ready(Arc<ResolvedImage>), Failed(String) }
struct Cache {
    entries: HashMap<Arc<str>, ImageState>,
    order: VecDeque<Arc<str>>,
    requests: HashMap<u64, Arc<str>>,
    next_id: u64,
}
pub struct Resolutions { send: Sender<CommandMessage>, cache: RefCell<Cache> }

impl Resolutions {
    pub fn new(send: Sender<CommandMessage>) -> Self {
        Self { send, cache: RefCell::new(Cache { entries: HashMap::new(), order: VecDeque::new(), requests: HashMap::new(), next_id: 1 << 40 }) }
    }

    pub fn get(&self, image: &ImageRef) -> ImageState {
        let mut cache = self.cache.borrow_mut();
        if let Some((key, state)) = cache.entries.get_key_value(image.key.as_str()) {
            let key = key.clone();
            let state = state.clone();
            cache.order.retain(|entry| entry.as_ref() != image.key.as_str());
            cache.order.push_back(key);
            return state;
        }
        if cache.requests.len() >= IN_FLIGHT { return ImageState::Loading; }
        while cache.entries.len() >= CAPACITY {
            let Some(key) = cache.order.pop_front() else { return ImageState::Loading };
            if matches!(cache.entries.get(&key), Some(ImageState::Loading)) { cache.order.push_back(key); break; }
            cache.entries.remove(&key);
        }
        if cache.entries.len() >= CAPACITY { return ImageState::Loading; }
        let id = cache.next_id;
        cache.next_id += 1;
        let request = Request { id, method: "image.resolve".into(), params: json!({"image": image}) };
        if self.send.send(CommandMessage::Request(request)).is_err() { return ImageState::Failed("The engine stopped. Restart Kagi.".into()); }
        let key: Arc<str> = image.key.as_str().into();
        cache.requests.insert(id, key.clone());
        cache.order.push_back(key.clone());
        cache.entries.insert(key, ImageState::Loading);
        ImageState::Loading
    }

    pub fn resolved(&self, image: &ImageRef) -> Option<Arc<ResolvedImage>> {
        match self.cache.borrow().entries.get(image.key.as_str()) {
            Some(ImageState::Ready(image)) => Some(image.clone()),
            _ => None,
        }
    }

    pub fn accept(&self, id: u64, ok: bool, result: &Option<ResultData>, error: &Option<EngineError>) -> bool {
        let mut cache = self.cache.borrow_mut();
        let Some(key) = cache.requests.remove(&id) else { return false };
        let state = if ok {
            result.as_ref().and_then(|result| result.image.clone())
                .filter(|image| image.key == key.as_ref() && !image.path.is_empty() && image.width.is_finite() && image.height.is_finite() && image.width > 0.0 && image.height > 0.0)
                .map(|image| ImageState::Ready(Arc::new(image))).unwrap_or_else(|| ImageState::Failed("The image could not be resolved. Retry loading.".into()))
        } else {
            ImageState::Failed(error.as_ref().map_or_else(|| "The image could not be loaded. Retry loading.".into(), |error| error.message.clone()))
        };
        cache.entries.insert(key, state);
        true
    }

    pub fn retry(&self, key: &str) {
        let mut cache = self.cache.borrow_mut();
        if !matches!(cache.entries.get(key), Some(ImageState::Loading)) {
            cache.entries.remove(key);
            cache.order.retain(|entry| entry.as_ref() != key);
        }
    }
}

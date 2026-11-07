use rune::{Image, ImageCache, Waker};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, mpsc};

const HANDLE_LIMIT: usize = 96;
const BYTE_LIMIT: usize = 192 * 1024 * 1024;
const DECODE_LIMIT: u64 = 256 * 1024 * 1024;
const TILE_EDGE: u32 = 4096;

pub struct ImageTile { pub image: Image, pub x: u32, pub y: u32, pub width: u32, pub height: u32 }
pub struct AssetImage { pub width: u32, pub height: u32, pub tiles: Vec<ImageTile> }

pub enum AssetEvent {
    Image(String, Result<(Arc<AssetImage>, usize), String>),
    Fonts(u64, Result<rune::text::FontSet, String>),
}
struct FontJob {
    generation: u64,
    paths: Vec<String>,
    sans: String,
    mono: String,
    reader: String,
}
enum Job { Image(String), Fonts(FontJob) }
struct Entry { image: Result<Arc<AssetImage>, String>, bytes: usize, handles: usize }
struct Entries {
    entries: HashMap<Arc<str>, Entry>,
    pending: HashSet<Arc<str>>,
    order: VecDeque<Arc<str>>,
    bytes: usize,
    handles: usize,
}

pub struct Assets {
    jobs: mpsc::SyncSender<Job>,
    pub events: mpsc::Receiver<AssetEvent>,
    entries: RefCell<Entries>,
}

fn font_bytes(path: &str) -> Result<Arc<[u8]>, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > 32 * 1024 * 1024 { return Err("Font exceeds the font size limit.".into()); }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    if bytes.starts_with(b"wOF2") || bytes.starts_with(b"wOFF") {
        let declared = bytes.get(16..20).and_then(|bytes| <[u8; 4]>::try_from(bytes).ok()).map(u32::from_be_bytes);
        if declared.is_none_or(|size| size > 64 * 1024 * 1024) { return Err("Font declares an invalid decoded size.".into()); }
    }
    let decoded = if bytes.starts_with(b"wOF2") {
        wuff::decompress_woff2(&bytes).map_err(|error| format!("WOFF2 decoding failed: {error:?}"))?
    } else if bytes.starts_with(b"wOFF") {
        wuff::decompress_woff1(&bytes).map_err(|error| format!("WOFF decoding failed: {error:?}"))?
    } else { bytes };
    if decoded.len() > 64 * 1024 * 1024 { return Err("Decoded font exceeds the font size limit.".into()); }
    Ok(decoded.into())
}

impl Assets {
    pub fn start(wake: Waker) -> Self {
        let (jobs, queue) = mpsc::sync_channel(32);
        let (events, receive) = mpsc::sync_channel(32);
        std::thread::Builder::new().name("kagi-assets".into()).spawn(move || {
            let cache = ImageCache::new(wake.clone());
            for job in queue {
                let event = match job {
                    Job::Image(path) => {
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            let mut reader = image::ImageReader::open(&path).map_err(|error| error.to_string())?
                                .with_guessed_format().map_err(|error| error.to_string())?;
                            let mut limits = image::Limits::default();
                            limits.max_alloc = Some(DECODE_LIMIT);
                            reader.limits(limits);
                            let pixels = reader.decode().map_err(|error| error.to_string())?.to_rgba8();
                            let width = pixels.width();
                            let height = pixels.height();
                            let bytes = pixels.len().saturating_mul(4) / 3;
                            let handles = width.div_ceil(TILE_EDGE) as usize * height.div_ceil(TILE_EDGE) as usize;
                            if bytes > BYTE_LIMIT || handles > HANDLE_LIMIT { return Err("Image exceeds the decoded image budget.".into()); }
                            let mut tiles = Vec::with_capacity(handles);
                            if handles == 1 {
                                let image = cache.rgba(width, height, pixels.into_raw());
                                image.wait().map_err(|error| error.to_string())?;
                                tiles.push(ImageTile { image, x: 0, y: 0, width, height });
                            } else {
                                for y in (0..height).step_by(TILE_EDGE as usize) {
                                    for x in (0..width).step_by(TILE_EDGE as usize) {
                                        let tile_width = TILE_EDGE.min(width - x);
                                        let tile_height = TILE_EDGE.min(height - y);
                                        let tile = image::imageops::crop_imm(&pixels, x, y, tile_width, tile_height).to_image();
                                        let image = cache.rgba(tile_width, tile_height, tile.into_raw());
                                        image.wait().map_err(|error| error.to_string())?;
                                        tiles.push(ImageTile { image, x, y, width: tile_width, height: tile_height });
                                    }
                                }
                            }
                            Ok((Arc::new(AssetImage { width, height, tiles }), bytes))
                        })).unwrap_or_else(|_| Err("Image decoding failed. Retry loading.".into()));
                        AssetEvent::Image(path, result)
                    }
                    Job::Fonts(job) => {
                        let prepared = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            job.paths.iter().map(|path| font_bytes(path)).collect::<Result<Vec<_>, _>>()
                                .and_then(|fonts| rune::text::FontSet::new(fonts, job.sans, job.mono, job.reader))
                        })).unwrap_or_else(|_| Err("Font decoding failed. Retry font loading.".into()));
                        AssetEvent::Fonts(job.generation, prepared)
                    }
                };
                if events.send(event).is_err() { break; }
                wake();
            }
        }).expect("asset worker thread");
        Self { jobs, events: receive, entries: RefCell::new(Entries {
            entries: HashMap::new(), pending: HashSet::new(), order: VecDeque::new(), bytes: 0, handles: 0,
        }) }
    }

    pub fn image(&self, path: &str) -> Option<Result<Arc<AssetImage>, String>> {
        let mut entries = self.entries.borrow_mut();
        if let Some((key, entry)) = entries.entries.get_key_value(path) {
            let key = key.clone();
            let result = entry.image.clone();
            entries.order.retain(|entry| entry.as_ref() != path);
            entries.order.push_back(key);
            return Some(result);
        }
        if !entries.pending.contains(path) && self.jobs.try_send(Job::Image(path.into())).is_ok() {
            entries.pending.insert(path.into());
        }
        None
    }

    pub fn is_ready(&self, path: &str) -> bool {
        self.entries.borrow().entries.get(path).is_some_and(|entry| entry.image.is_ok())
    }

    pub fn fonts(&self, generation: u64, paths: Vec<String>, sans: String, mono: String, reader: String) -> bool {
        self.jobs.try_send(Job::Fonts(FontJob { generation, paths, sans, mono, reader })).is_ok()
    }

    pub fn retry(&self, path: &str) {
        let mut entries = self.entries.borrow_mut();
        if let Some(entry) = entries.entries.remove(path) { entries.bytes = entries.bytes.saturating_sub(entry.bytes); entries.handles = entries.handles.saturating_sub(entry.handles); }
        entries.order.retain(|entry| entry.as_ref() != path);
    }

    pub fn insert(&self, path: String, result: Result<(Arc<AssetImage>, usize), String>) {
        let mut entries = self.entries.borrow_mut();
        entries.pending.remove(path.as_str());
        let path: Arc<str> = path.into();
        let entry = match result {
            Ok((image, bytes)) => { let handles = image.tiles.len(); Entry { image: Ok(image), bytes, handles } },
            Err(error) => Entry { image: Err(error), bytes: 0, handles: 0 },
        };
        while entries.entries.len() >= HANDLE_LIMIT || entries.handles.saturating_add(entry.handles) > HANDLE_LIMIT || entries.bytes.saturating_add(entry.bytes) > BYTE_LIMIT {
            let Some(key) = entries.order.pop_front() else { break };
            if let Some(old) = entries.entries.remove(&key) { entries.bytes = entries.bytes.saturating_sub(old.bytes); entries.handles = entries.handles.saturating_sub(old.handles); }
        }
        entries.bytes += entry.bytes;
        entries.handles += entry.handles;
        entries.order.push_back(path.clone());
        entries.entries.insert(path, entry);
    }
}

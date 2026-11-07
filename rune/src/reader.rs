use crate::protocol::{ImageRef, Page, Reader, TextBlock};
use crate::resolution::ImageState;
use crate::state::State;
use crate::theme::{self, BORDER, FRAME, GAP, GROUP, UNIT};
use rune::{Cx, El, Family, Key, KeyEvent, Link, ScrollSpec, Span, TextStyle, Tx, col, el, row, text};
use rune_kit::{Button, ButtonVariant};

const DEFAULT_FONT_SIZE: f32 = 19.0;
const DEFAULT_LINE_HEIGHT: f32 = 1.7;
const DEFAULT_MEASURE: f32 = 68.0;

fn reader(state: &State) -> &Reader { state.screen.reader.as_ref().expect("reader surface") }

fn image_dimensions(state: &State, path: Option<&str>, reference: Option<&ImageRef>) -> Option<(f32, f32)> {
    if let Some(reference) = reference {
        if let Some(ImageState::Ready(image)) = state.images.as_ref().map(|images| images.get(reference)) {
            return Some((image.width, image.height));
        }
    }
    if let Some(path) = path {
        if let Some(Ok(image)) = state.assets.as_ref().and_then(|assets| assets.image(path)) {
            return Some((image.width as f32, image.height as f32));
        }
    }
    None
}

pub fn image_ready(state: &State, path: Option<&str>, reference: Option<&ImageRef>) -> bool {
    let Some(assets) = &state.assets else { return false };
    if let Some(path) = path { return assets.is_ready(path); }
    reference.and_then(|reference| state.images.as_ref().and_then(|images| images.resolved(reference)))
        .is_some_and(|image| assets.is_ready(&image.path))
}

fn dimensions(state: &State, page: &Page) -> Option<(f32, f32)> {
    image_dimensions(state, page.path.as_deref(), page.image_ref.as_ref()).or_else(|| {
        page.width.zip(page.height).filter(|(width, height)| *width > 0.0 && *height > 0.0 && width.is_finite() && height.is_finite())
    })
}

fn page_size(state: &State, page: &Page) -> (f32, f32) {
    let reader = reader(state);
    let webtoon = reader.mode == "continuous" && reader.continuous_style.as_deref() == Some("webtoon");
    let available = if webtoon { state.width } else { state.width.min(FRAME) - GROUP * 2.0 };
    let available = available.max(UNIT);
    let (width, height) = dimensions(state, page).unwrap_or((available, available / theme::COVER_RATIO));
    let scale = if reader.fit.as_deref() == Some("screen") {
        (available / width).min(state.reader_height.max(GROUP) / height)
    } else { available / width };
    (width * scale, height * scale)
}

fn track(element: El, index: usize, key: String, ready: bool) -> El {
    element.key(&key).on_drawn_layout_tx(move |state: &mut State, rect, tx| {
        let top = state.reader_top;
        if rect[3] <= 0.0 { return; }
        if !ready { return; }
        if rect[1] + rect[3] > top && rect[1] < top + state.reader_height { state.reader_content_ready = true; }
        if state.screen.reader.as_ref().is_some_and(|reader| reader.kind == "novel") {
            if rect[1] <= top + BORDER && rect[1] + rect[3] > top && state.reader_anchor.as_deref() != Some(key.as_str()) { state.reader_anchor = Some(key.clone()); }
            return;
        }
        if state.reader_restore {
            if state.position.floor() as usize == index {
                tx.scroll_key_to(&key, -(state.position.fract() as f32 * rect[3]));
                state.reader_restore = false;
                tx.instant();
            }
            return;
        }
        if rect[1] <= top + BORDER && rect[1] + rect[3] > top {
            state.position = index as f64 + ((top - rect[1]) / rect[3]).clamp(0.0, 0.999) as f64;
        }
    })
}

fn comic_page(state: &State, index: usize) -> El {
    let page = &reader(state).pages[index];
    let (width, height) = page_size(state, page);
    let image = crate::view::image(state, page.path.as_deref(), page.image_ref.as_ref(), width, height, false);
    track(col().w_full().items_center().child(image), index, page.renderer_key.clone(), image_ready(state, page.path.as_deref(), page.image_ref.as_ref()))
}

fn prose_style(state: &State, block: &TextBlock) -> TextStyle {
    let reader = reader(state);
    let size = reader.font_size.filter(|size| size.is_finite()).unwrap_or(DEFAULT_FONT_SIZE).clamp(12.0, 32.0);
    let line_height = reader.line_height.filter(|height| height.is_finite()).unwrap_or(DEFAULT_LINE_HEIGHT).clamp(1.2, 2.4);
    let base = TextStyle { size, line_height: size * line_height, family: Family::Reader, ..state.reader_kit.ty.body };
    match block.kind.as_str() {
        "heading" => {
            let scale = heading_scale(block.level.unwrap_or(2));
            TextStyle { weight: state.reader_kit.ty.body_medium.weight, size: size * scale, line_height: base.line_height * scale, ..base }
        }
        "code" => base.family(Family::Mono),
        "quote" => base.italic(),
        _ => base,
    }
}

fn heading_scale(level: u8) -> f32 {
    match level { 1 => 2.0, 2 => 1.5, 3 => 1.25, _ => 1.0 }
}

fn novel_block(state: &State, index: usize, width: f32) -> El {
    let reader = reader(state);
    let block = &reader.blocks[index];
    let kit = &state.reader_kit;
    let key = block.renderer_key.clone();
    if block.kind == "rule" { return track(el().w(width).h(BORDER).fill(kit.c.border_base), index, key, true); }
    if block.kind == "image" {
        let height = image_dimensions(state, block.image.as_deref(), block.image_ref.as_ref())
            .map_or(width / theme::COVER_RATIO, |(image_width, image_height)| width * image_height / image_width);
        return track(crate::view::image(state, block.image.as_deref(), block.image_ref.as_ref(), width, height, false), index, key, image_ready(state, block.image.as_deref(), block.image_ref.as_ref()));
    }
    let style = prose_style(state, block);
    rune::memo(key.clone(), (state.revision, width.to_bits(), kit.c, style), || {
    let mut source = String::new();
    let mut spans = Vec::new();
    let mut links = Vec::new();
    if block.spans.is_empty() { source.push_str(block.text.as_deref().unwrap_or("")); }
    else {
        for span in &block.spans {
            let start = source.len();
            source.push_str(&span.text);
            let end = source.len();
            let mut mark = Span::new(start, end);
            if span.bold { mark = mark.bold(); }
            if span.italic { mark = mark.italic(); }
            if span.mono { mark = mark.mono().bg(kit.c.layer_02, UNIT); }
            if span.underline { mark = mark.underline(if span.href.is_some() { kit.c.text_accent } else { kit.c.text_base }); }
            if let Some(href) = &span.href {
                mark = mark.color(kit.c.text_accent);
                links.push(Link::new(start..end, href));
            }
            spans.push(mark);
        }
    }
    let mut paragraph = text(source).font(style).spans(spans).color(kit.c.text_base).wrap().w(width).selectable(true);
    if reader.justify == Some(true) && block.kind == "paragraph" { paragraph = paragraph.justify(); }
    for link in links { paragraph = paragraph.link(link); }
    paragraph = paragraph.on_link(|state: &mut State, url, tx| {
        if url.starts_with("#") {
            let target = url.trim_start_matches('#');
            tx.scroll_into_view_in("reader-scroll", format!("reader-block-{target}"));
        } else if let Err(error) = tx.open_url(url) { state.error = Some(error.to_string()); }
    });
    if block.kind == "quote" { paragraph = paragraph.padding(GAP).border(BORDER, kit.c.border_base); }
    if block.kind == "code" { paragraph = paragraph.padding(GAP).fill(kit.c.layer_02).radius(kit.radius.md).wrap_anywhere(); }
    if block.kind == "list" {
        paragraph = paragraph.px(block.level.unwrap_or(0) as f32 * GAP);
    }
    track(paragraph, index, key, true)
    })
}

pub fn step(state: &mut State, amount: i32, tx: &mut Tx) {
    let Some(reader) = &state.screen.reader else { return };
    if state.busy() || state.settings_open { return; }
    if reader.kind == "novel" || reader.mode == "continuous" {
        tx.scroll_page("reader-scroll", amount);
    } else {
        let maximum = reader.pages.len().saturating_sub(1) as f64;
        let next = (state.position.floor() + amount as f64).clamp(0.0, maximum);
        if next != state.position {
            state.flush_progress();
            state.position = next;
            state.reader_content_ready = false;
        }
    }
    tx.instant();
}

pub fn key(state: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
    if event.is_command('q') { state.close(tx); return true; }
    if state.dimmed { state.wake_reader(); return true; }
    if event.mods.alt && event.key == Key::Left { state.back(); return true; }
    if event.key == Key::Escape {
        if state.busy() { return true; }
        if state.confirmation.take().is_some() || state.select.take().is_some() { return true; }
        if state.menu { state.menu = false; return true; }
        if state.settings_open { state.settings_open = false; return true; }
        if state.screen.dialog.is_some() { std::sync::Arc::make_mut(&mut state.screen).dialog = None; return true; }
        if state.screen.reader.is_some() { state.back(); return true; }
    }
    let Some(reader) = &state.screen.reader else { return false };
    if state.screen.dialog.is_some() || state.menu || state.settings_open { return false; }
    let rtl = reader.mode == "paged-rtl";
    let amount = match &event.key {
        Key::Right => if rtl { -1 } else { 1 },
        Key::Left => if rtl { 1 } else { -1 },
        Key::PageDown | Key::Down => 1,
        Key::PageUp | Key::Up => -1,
        Key::Text(value) if value == " " => if event.mods.shift { -1 } else { 1 },
        Key::Home => {
            let comic = reader.kind == "comic";
            state.flush_progress();
            if comic { state.reader_content_ready = false; }
            state.position = 0.0;
            state.reader_restore = true;
            tx.scroll_to_y("reader-scroll", 0.0);
            return true;
        }
        Key::End => {
            let target = if reader.kind == "novel" { theme::NOVEL_PROGRESS } else { reader.pages.len().saturating_sub(1) as f64 };
            let comic = reader.kind == "comic";
            state.flush_progress();
            if comic { state.reader_content_ready = false; }
            state.position = target;
            state.reader_restore = true;
            tx.scroll_to_bottom_instant("reader-scroll");
            return true;
        }
        _ => return false,
    };
    step(state, amount, tx);
    true
}

pub fn view(state: &State, _: &mut Cx<State>) -> El {
    let reader = reader(state);
    let kit = &state.reader_kit;
    let count = if reader.kind == "novel" { reader.blocks.len() } else { reader.pages.len() };
    let index = (state.position.floor() as usize).min(count.saturating_sub(1));
    let paged = reader.kind == "comic" && reader.mode != "continuous";
    let mut toolbar = row().w_full().gap(GAP).padding(GAP).flex_wrap()
        .child(Button::new(if paged { "Previous page" } else { "Page up" }).variant(ButtonVariant::Outline)
            .disabled(state.busy() || (paged && index == 0)).on_press_tx(|state: &mut State, tx| step(state, -1, tx)).build(kit))
        .child(text(if count == 0 { "No content".into() } else if reader.kind == "novel" {
            format!("{}% read", (state.position / 10.0).round())
        } else { format!("Page {} of {count}", index + 1) }).font(kit.ty.small).color(kit.c.text_weak))
        .child(Button::new(if paged { "Next page" } else { "Page down" }).variant(ButtonVariant::Outline)
            .disabled(state.busy() || (paged && index + 1 >= count)).on_press_tx(|state: &mut State, tx| step(state, 1, tx)).build(kit))
        .child(Button::new("Chapter controls").disabled(state.busy()).on_press(|state: &mut State| state.settings_open = true).build(kit));
    if let Some(settings) = state.screen.actions.iter().chain(state.screen.sections.iter().flat_map(|section| &section.actions))
        .find(|action| action.method == "navigate" && action.params.as_ref().is_some_and(|params| params.get("route").and_then(serde_json::Value::as_str) == Some("settings") && params.get("tab").and_then(serde_json::Value::as_str) == Some("reader"))) {
        toolbar = toolbar.child(crate::view::action(state, settings));
    }
    let content = if reader.kind == "novel" && !state.fonts_ready {
        let mut loading = col().w_full().padding(GROUP).gap(GAP);
        if let Some(error) = &state.font_error {
            loading = loading.child(text(error).font(kit.ty.body).color(kit.c.text_weak).wrap().w_full())
                .child(Button::new("Retry font loading").on_press(|state: &mut State| state.retry_fonts()).build(kit));
        } else {
            loading = loading.child(text("Loading reader font").font(kit.ty.small).color(kit.c.text_weak))
                .children((0..4).map(|_| el().w_full().h(GROUP).radius(kit.radius.sm).fill(kit.c.layer_02)));
        }
        loading
    } else if count == 0 {
        col().w_full().padding(GROUP).child(text("This chapter has no content.").font(kit.ty.body).color(kit.c.text_weak))
    } else if reader.kind == "novel" {
        let size = reader.font_size.unwrap_or(DEFAULT_FONT_SIZE).clamp(12.0, 32.0);
        let measure = reader.measure.unwrap_or(DEFAULT_MEASURE).clamp(40.0, 120.0);
        let width = (measure * size * 0.5).min(state.width - GROUP * 2.0).max(UNIT);
        col().key("prose").w_full().items_center().padding(GROUP).gap(GROUP)
            .virtual_rows(count, size * reader.line_height.unwrap_or(DEFAULT_LINE_HEIGHT) * 4.0,
                |state: &State, index| self::reader(state).blocks[index].renderer_key.as_str().into(),
                move |state: &State, index| novel_block(state, index, width))
    } else if paged {
        col().w_full().child(comic_page(state, index))
    } else {
        let gap = if reader.continuous_style.as_deref() == Some("webtoon") || reader.gap == Some(false) { 0.0 } else { GAP };
        col().key("comic-pages").w_full().gap(gap)
            .virtual_rows(count, state.reader_height.max(GROUP),
                |state: &State, index| self::reader(state).pages[index].renderer_key.as_str().into(),
                |state: &State, index| comic_page(state, index))
    };
    let position = state.reader_scroll.clone();
    let wake = state.waker();
    let surface = match reader.surface.as_deref() {
        Some("black") => theme::LETTERBOX,
        Some("muted") => kit.c.layer_02,
        _ => kit.c.bg_base,
    };
    col().key("reader").w_full().min_h(0.0).grow(1.0).child(toolbar)
        .child(col().key("reader-scroll").w_full().min_h(0.0).grow(1.0).fill(surface)
            .on_layout(|state: &mut State, rect| { state.reader_top = rect[1]; state.reader_height = rect[3]; })
            .scroll(ScrollSpec { stick_bottom: false })
            .on_scroll_offset(move |at| {
                position.set((at.offset[1], at.max[1]));
                if let Some(wake) = &wake { wake(); }
            })
            .child(content))
}

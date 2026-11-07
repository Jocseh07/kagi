use crate::protocol::{Action, Field, ImageRef, Row, Section};
use crate::state::State;
use crate::theme::{self, BORDER, COMPACT, COVER_RATIO, FRAME, GAP, GROUP, UNIT};
use rune::{Cx, El, ScrollSpec, SurfaceFit, col, el, row, spacer, text};
use rune_kit::{Badge, Button, ButtonVariant, Progress, Select, Switch, TextArea, TextInput};
use serde_json::json;

pub fn action(state: &State, model: &Action) -> El {
    let pending = state.action_pending(&model.id);
    let dispatch = model.clone();
    let variant = if pending { ButtonVariant::Loading } else { match model.variant.as_deref() {
        Some("primary") => ButtonVariant::Submit,
        Some("secondary") => ButtonVariant::Outline,
        Some("ghost") => ButtonVariant::Ghost,
        Some("danger") => ButtonVariant::Danger,
        _ => ButtonVariant::Neutral,
    } };
    Button::new(&model.label).variant(variant).disabled(state.busy() || state.navigating() || state.closing || state.failure.is_some())
        .on_press_tx(move |state: &mut State, tx| state.activate(dispatch.clone(), tx))
        .build(&state.kit).key(&model.id)
}

fn cancellation(state: &State) -> Option<El> {
    let (id, canceling) = state.cancellation()?;
    Some(Button::new(if canceling { "Canceling action" } else { "Cancel action" })
        .disabled(canceling || state.closing).variant(ButtonVariant::Outline)
        .on_press(move |state: &mut State| state.cancel_action(&id)).build(&state.kit))
}

fn actions(state: &State, models: &[Action]) -> El {
    row().w_full().flex_wrap().gap(GAP).children(models.iter().map(|model| action(state, model)))
}

fn field(state: &State, model: &Field, layers: &mut Vec<El>) -> El {
    let kit = &state.kit;
    let Some(edit) = state.drafts.get(&model.id) else { return el() };
    let disabled = model.disabled || state.busy() || state.closing;
    let id = model.id.clone();
    let control = match model.kind.as_str() {
        "toggle" => Switch::new(edit.text == "true").label(&model.label).disabled(disabled)
            .on_toggle(move |state: &mut State| {
                if let Some(edit) = state.drafts.get_mut(&id) {
                    let value = if edit.text == "true" { "false" } else { "true" };
                    edit.replace_text(value);
                }
            }).build(kit),
        "select" => {
            let labels: Vec<&str> = model.options.iter().map(|option| option.label.as_str()).collect();
            let current = model.options.iter().find(|option| option.value == edit.text).map(|option| option.label.as_str());
            let open_id = id.clone();
            let choice_id = id.clone();
            let choices = model.options.clone();
            Select::new(format!("select-{id}"), &labels).current(current)
                .width(((state.width - GROUP).min(FRAME / 2.0) - GROUP).max(UNIT))
                .open(state.select.as_ref() == Some(&id)).disabled(disabled)
                .on_toggle(move |state: &mut State| {
                    state.select = if state.select.as_ref() == Some(&open_id) { None } else { Some(open_id.clone()) };
                })
                .on_close(|state: &mut State| state.select = None)
                .on_choose(move |state: &mut State, label, _| {
                    if let Some(option) = choices.iter().find(|option| option.label == label) {
                        if let Some(edit) = state.drafts.get_mut(&choice_id) { edit.replace_text(&option.value); }
                    }
                    state.select = None;
                }).build(kit, layers)
        }
        "multiline" => TextArea::new(edit).width(None).max_height(GROUP * 6.0).disabled(disabled)
            .on_edit(move |state: &mut State| state.drafts.get_mut(&id).expect("mounted draft"))
            .build(kit).w_full(),
        _ => TextInput::new(edit).width(None).disabled(disabled)
            .on_edit(move |state: &mut State| state.drafts.get_mut(&id).expect("mounted draft"))
            .build(kit).label(&model.label),
    };
    let mut group = col().key(&model.id).w_full().min_w(0.0).gap(UNIT);
    if model.kind != "toggle" { group = group.child(text(&model.label).font(kit.ty.ui_medium).color(kit.c.text_base)); }
    group = group.child(control);
    if let Some(hint) = &model.hint { group = group.child(text(hint).font(kit.ty.small).color(kit.c.text_weak).wrap().w_full()); }
    group
}

pub fn fields(state: &State, models: &[Field], layers: &mut Vec<El>) -> El {
    let mut group = col().w_full().gap(GROUP);
    for model in models { group = group.child(field(state, model, layers)); }
    group
}

pub fn image(state: &State, path: Option<&str>, reference: Option<&ImageRef>, width: f32, height: f32, cover: bool) -> El {
    let kit = &state.kit;
    let radius = if cover { kit.radius.md } else { 0.0 };
    let frame = el().size(width, height).radius(radius).fill(kit.c.layer_02);
    let resolved = reference.and_then(|reference| state.images.as_ref().map(|images| images.get(reference)));
    let mut error = None;
    let resolved_path = match &resolved {
        Some(crate::resolution::ImageState::Ready(image)) => Some(image.path.as_str()),
        Some(crate::resolution::ImageState::Failed(message)) => { error = Some(message.clone()); None }
        _ => None,
    };
    let path = path.or(resolved_path);
    if let Some(path) = path {
        match state.assets.as_ref().and_then(|assets| assets.image(path)) {
            Some(Ok(image)) => {
                if image.tiles.len() == 1 {
                    return frame.pixels_fit(image.tiles[0].image.pixels(), if cover { SurfaceFit::Fill } else { SurfaceFit::Fit });
                }
                let scale = if cover { (width / image.width as f32).max(height / image.height as f32) } else { (width / image.width as f32).min(height / image.height as f32) };
                let left = (width - image.width as f32 * scale) / 2.0;
                let top = (height - image.height as f32 * scale) / 2.0;
                let mut frame = frame.clip_rounded(radius);
                for tile in &image.tiles {
                    frame = frame.child(el().size(tile.width as f32 * scale, tile.height as f32 * scale)
                        .absolute(left + tile.x as f32 * scale, top + tile.y as f32 * scale).pixels(tile.image.pixels()));
                }
                return frame;
            },
            Some(Err(message)) => error = Some(message),
            None => return frame.label("Loading image"),
        }
    }
    if let Some(error) = error {
        let key = reference.map(|reference| reference.key.clone());
        let path = path.map(str::to_owned);
        let retry = move |state: &mut State| {
            if let (Some(key), Some(images)) = (&key, &state.images) { images.retry(key); }
            if let (Some(path), Some(assets)) = (&path, &state.assets) { assets.retry(path); }
        };
        if width < GROUP * 4.0 {
            let compact = frame.center().help(error).label("Retry image").role("button")
                .child(text("Retry image").font(kit.ty.small).color(kit.c.text_weak).wrap().w_full());
            return if state.failure.is_none() { kit.interactive(compact).on_press(retry) } else { compact };
        }
        return frame.center().child(col().gap(GAP)
            .child(text("Image unavailable").font(kit.ty.small).color(kit.c.text_weak).wrap().w_full().help(error))
            .child(Button::new("Retry image").disabled(state.failure.is_some()).on_press(retry).build(kit)));
    }
    if reference.is_some() { frame.label("Loading image") }
    else { frame.center().child(text("No cover").font(kit.ty.small).color(kit.c.text_weak)) }
}

fn item(state: &State, model: &Row, width: f32, grid: bool) -> El {
    let kit = &state.kit;
    let mut content = col().gap(UNIT).min_w(0.0)
        .child(text(&model.title).font(kit.ty.body_medium).color(kit.c.text_strong).truncate().help(&model.title));
    for detail in [model.subtitle.as_ref(), model.detail.as_ref()].into_iter().flatten() {
        content = content.child(text(detail).font(kit.ty.small).color(kit.c.text_weak).wrap().w_full().selectable(true));
    }
    if !model.badges.is_empty() {
        content = content.child(row().gap(UNIT).flex_wrap().children(model.badges.iter().map(|badge| Badge::new(badge).build(kit))));
    }
    if let Some(progress) = model.progress { content = content.child(Progress::new(Some(progress.clamp(0.0, 1.0))).build(kit)); }
    if grid {
        let cover_width = (width - GAP * 2.0).max(UNIT);
        let mut cover = image(state, model.image.as_deref(), model.image_ref.as_ref(), cover_width, cover_width / COVER_RATIO, true);
        if let Some(primary) = model.actions.first() {
            let primary = primary.clone();
            if !state.busy() && !state.closing {
                cover = kit.interactive(cover).label(format!("Open {}", model.title)).role("button")
                    .on_press_tx(move |state: &mut State, tx| state.activate(primary.clone(), tx));
            }
        }
        col().key(&model.id).w(width).min_w(0.0).padding(GAP).gap(GAP)
            .fill(if model.selected { kit.c.layer_03 } else { kit.c.bg_base })
            .radius(kit.radius.lg).child(cover).child(content).child(actions(state, &model.actions))
    } else {
        let mut line = row().key(&model.id).w_full().min_w(0.0).padding(GAP).gap(GAP).flex_wrap()
            .fill(if model.selected { kit.c.layer_03 } else { kit.c.bg_base });
        if model.image.is_some() || model.image_ref.is_some() { line = line.child(image(state, model.image.as_deref(), model.image_ref.as_ref(), GROUP * 2.0, GROUP * 3.0, true)); }
        line.child(content.grow(1.0)).child(row().gap(GAP).flex_wrap().children(model.actions.iter().map(|model| action(state, model))))
    }
}

fn skeleton(state: &State, grid: bool) -> El {
    let kit = &state.kit;
    if grid {
        row().w_full().gap(GAP).children((0..3).map(|_| el().grow(1.0).h(GROUP * 6.0).radius(kit.radius.md).fill(kit.c.layer_02)))
    } else {
        col().gap(GAP).w_full().children((0..3).map(|_| el().w_full().h(GROUP * 2.0).radius(kit.radius.md).fill(kit.c.layer_02)))
    }
}

fn section(state: &State, model: &Section, section_index: usize, layers: &mut Vec<El>) -> El {
    let kit = &state.kit;
    let mut result = col().key(&model.id).w_full().min_w(0.0).gap(GAP);
    if let Some(title) = &model.title { result = result.child(text(title).font(kit.ty.body_medium).color(kit.c.text_strong)); }
    let grid = model.layout.as_deref() == Some("grid");
    if model.status.as_deref() == Some("loading") {
        if model.rows.is_empty() && model.fields.is_empty() { result = result.child(skeleton(state, grid)); }
        else { result = result.child(text("Refreshing").font(kit.ty.small).color(kit.c.text_weak)); }
    }
    if model.status.as_deref() == Some("error") || model.error.is_some() {
        result = result.child(col().gap(GAP).padding(GAP).radius(kit.radius.md).border(BORDER, kit.c.danger.border)
            .child(text(model.error.as_deref().unwrap_or("Could not load this section. Try again.")).font(kit.ty.body).color(kit.c.text_base).wrap().w_full())
            .child(Button::new("Retry loading").disabled(state.busy() || state.navigating())
                .on_press(|state: &mut State| state.refresh()).build(kit)));
    }
    if !model.fields.is_empty() { result = result.child(fields(state, &model.fields, layers)); }
    if !model.rows.is_empty() {
        let columns = if state.width >= 1024.0 { 6 } else if state.width >= COMPACT { 4 } else { 2 };
        let columns = if grid { columns } else { 1 };
        let width = (state.width.min(FRAME) - GROUP * 2.0 - GAP * (columns - 1) as f32).max(UNIT) / columns as f32;
        let count = model.rows.len().div_ceil(columns);
        let estimate = if grid { width / COVER_RATIO + GROUP * 4.0 } else { GROUP * 3.0 };
        result = result.child(col().w_full().gap(GAP).virtual_rows(count, estimate,
            move |state: &State, index| state.screen.sections[section_index].rows[index * columns].id.as_str().into(),
            move |state: &State, index| {
                let models = &state.screen.sections[section_index].rows;
                let start = index * columns;
                let end = (start + columns).min(models.len());
                row().w_full().gap(GAP).children(models[start..end].iter().map(|model| item(state, model, width, grid)))
            }));
    } else if model.fields.is_empty() && model.status.as_deref() != Some("loading") && model.error.is_none() && model.status.as_deref() != Some("error") {
        if let Some(empty) = &model.empty { result = result.child(text(empty).font(kit.ty.body).color(kit.c.text_weak).wrap().w_full().padding(GROUP)); }
    }
    result.child(actions(state, &model.actions))
}

const NAV: &[(&str, &str)] = &[("Home", "home"), ("Library", "library"), ("Updates", "updates"), ("Browse", "browse"), ("History", "history"), ("Downloads", "downloads"), ("Adaptations", "adaptations"), ("Generation journal", "journal"), ("Settings", "settings")];

fn nav_button(state: &State, label: &str, route: &'static str) -> El {
    Button::new(label).variant(if state.screen.route == route { ButtonVariant::Neutral } else { ButtonVariant::Ghost })
        .disabled(state.busy() || state.closing).on_press(move |state: &mut State| state.navigate(route, json!({}), true)).build(&state.kit).key(route)
}

fn header(state: &State) -> El {
    let kit = &state.kit;
    let mut nav = row().w_full().padding(GAP).gap(GAP).center_y()
        .child(Button::new("Kagi").variant(ButtonVariant::Ghost).disabled(state.busy() || state.closing)
            .on_press(|state: &mut State| state.navigate("home", json!({}), true)).build(kit))
        .child(spacer().grow(1.0));
    if state.width >= COMPACT {
        for &(label, route) in NAV.iter().take(4) { nav = nav.child(nav_button(state, label, route)); }
    }
    nav.child(Button::new("Menu").disabled(state.busy() || state.closing)
        .on_press(|state: &mut State| state.menu = !state.menu).build(kit))
}

fn modal(state: &State, id: &str, title: &str, description: Option<&str>, contents: El, dismiss: fn(&mut State), layers: &mut Vec<El>) {
    let kit = &state.kit;
    let disabled = state.busy() || state.closing;
    let mut body = col().w_full().min_h(0.0).grow(1.0).gap(GAP).padding(GAP).scroll(ScrollSpec { stick_bottom: false });
    if let Some(description) = description { body = body.child(text(description).font(kit.ty.body).color(kit.c.text_weak).wrap().w_full()); }
    body = body.child(contents);
    let mut header = row().w_full().padding(GAP).gap(GAP).center_y()
        .child(text(title).font(kit.ty.body_medium).color(kit.c.text_strong).wrap().min_w(0.0).grow(1.0));
    if let Some(cancel) = cancellation(state) { header = header.child(cancel); }
    header = header.child(Button::new("Close").variant(ButtonVariant::Ghost).disabled(disabled)
        .on_press(move |state: &mut State| dismiss(state)).build(kit));
    let mut panel = col().key(format!("{id}-dialog")).role("dialog").label(title)
        .w_full().max_w(FRAME / 2.0).h((state.height - GROUP * 2.0).clamp(GROUP * 3.0, theme::DIALOG_HEIGHT))
        .radius(kit.radius.lg).fill(kit.c.layer_01).border(BORDER, kit.c.border_base).child(header);
    if let Some(error) = &state.error {
        panel = panel.child(text(error).font(kit.ty.body).color(kit.c.danger.icon).wrap().w_full().padding(GAP));
    }
    let panel = panel.child(body)
        .modal(!disabled, move |state: &mut State| { if !state.busy() && !state.closing { dismiss(state); } });
    layers.push(el().key(format!("{id}-scrim")).absolute(0.0, 0.0).w_full().h_full().fill(kit.c.scrim));
    layers.push(el().key(format!("{id}-layer")).absolute(0.0, 0.0).w_full().h_full().padding(GAP).center().child(panel));
}

pub fn view(state: &State, cx: &mut Cx<State>) -> El {
    state.observe_appearance(cx.system_dark());
    let mut layers = Vec::new();
    let kit = &state.kit;
    let mut body = col().key("body").w_full().min_w(0.0).min_h(0.0).grow(1.0).gap(GAP);
    let mut title = row().w_full().max_w(FRAME).self_center().gap(GAP).center_y();
    if state.can_back() {
        title = title.child(Button::new("Back").variant(ButtonVariant::Ghost).disabled(state.busy() || state.closing)
            .on_press(|state: &mut State| state.back()).build(kit));
    }
    title = title.child(text(&state.screen.title).font(theme::title(kit, state.width)).color(kit.c.text_strong).truncate().help(&state.screen.title).min_w(0.0).grow(1.0));
    if state.navigating() { title = title.child(text("Loading").font(kit.ty.small).color(kit.c.text_weak)); }
    body = body.child(title.padding(GAP));
    if let Some(subtitle) = &state.screen.subtitle { body = body.child(text(subtitle).font(kit.ty.small).color(kit.c.text_weak).wrap().w_full().px(GROUP)); }
    if !state.screen.tabs.is_empty() {
        body = body.child(row().key("tabs").w_full().gap(GAP).padding(GAP).scroll_x().children(state.screen.tabs.iter().map(|tab| {
            let route = tab.route.clone();
            let params = tab.params.clone().unwrap_or_else(|| json!({}));
            Button::new(&tab.label).variant(if tab.selected { ButtonVariant::Neutral } else { ButtonVariant::Ghost })
                .disabled(state.busy() || state.closing).on_press(move |state: &mut State| state.navigate(&route, params.clone(), true)).build(kit).key(&tab.id)
        })));
    }
    if !state.screen.actions.is_empty() { body = body.child(actions(state, &state.screen.actions).px(GROUP)); }
    if state.screen.dialog.is_none() && !state.settings_open && !state.menu {
        if let Some(cancel) = cancellation(state) { body = body.child(cancel.px(GROUP)); }
    }
    if let Some(failure) = &state.failure {
        body = body.child(col().w_full().padding(GROUP).gap(GAP)
            .child(text("Engine unavailable").font(kit.ty.body_medium).color(kit.c.text_strong))
            .child(text(failure).font(kit.ty.body).color(kit.c.text_weak).wrap().w_full())
            .child(Button::new("Restart engine").variant(if state.restarting { ButtonVariant::Loading } else { ButtonVariant::Neutral })
                .disabled(state.closing || state.restarting).on_press(|state: &mut State| state.restart()).build(kit)));
    }
    if state.screen.dialog.is_none() && !state.settings_open {
        if let Some(error) = &state.error { body = body.child(text(error).font(kit.ty.body).color(kit.c.danger.icon).wrap().w_full().px(GROUP)); }
    }
    if let Some(notice) = &state.notice { body = body.child(text(notice).font(kit.ty.small).color(kit.c.text_weak).wrap().w_full().px(GROUP)); }
    if !state.screen.reader.as_ref().is_some_and(|reader| reader.kind == "novel") {
        if state.fonts_loading() { body = body.child(text("Loading fonts").font(kit.ty.small).color(kit.c.text_weak).px(GROUP)); }
        if let Some(error) = &state.font_error {
            body = body.child(row().gap(GAP).padding(GAP).flex_wrap()
                .child(text(error).font(kit.ty.body).color(kit.c.text_weak).wrap().min_w(0.0).grow(1.0))
                .child(Button::new("Retry font loading").disabled(state.fonts_loading()).on_press(|state: &mut State| state.retry_fonts()).build(kit)));
        }
    }
    if state.screen.reader.is_some() {
        body = body.child(crate::reader::view(state, cx));
        if state.settings_open {
            let mut popup_layers = Vec::new();
            let mut settings = col().w_full().gap(GROUP);
            for (index, model) in state.screen.sections.iter().enumerate() { settings = settings.child(section(state, model, index, &mut popup_layers)); }
            modal(state, "reader-controls", "Chapter controls", None, settings, |state| state.settings_open = false, &mut layers);
            layers.extend(popup_layers);
        }
    } else {
        let mut sections = col().key("sections").w_full().max_w(FRAME).self_center().gap(GROUP).padding(GROUP);
        for (index, model) in state.screen.sections.iter().enumerate() { sections = sections.child(section(state, model, index, &mut layers)); }
        body = body.child(col().key("page-scroll").w_full().grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(sections));
    }
    if state.menu {
        let mut menu = col().gap(GAP).w_full();
        for &(label, route) in NAV { menu = menu.child(nav_button(state, label, route)); }
        modal(state, "navigation", "Menu", None, menu, |state| state.menu = false, &mut layers);
    }
    if let Some(dialog) = &state.screen.dialog {
        let mut popup_layers = Vec::new();
        let mut contents = fields(state, &dialog.fields, &mut popup_layers).gap(GROUP);
        contents = contents.child(actions(state, &dialog.actions));
        modal(state, &dialog.id, &dialog.title, dialog.description.as_deref(), contents,
            |state| std::sync::Arc::make_mut(&mut state.screen).dialog = None, &mut layers);
        layers.extend(popup_layers);
    }
    if let Some(confirm) = &state.confirmation {
        let accepted = confirm.clone();
        let contents = row().w_full().gap(GAP).justify_end()
            .child(Button::new("Cancel").on_press(|state: &mut State| state.confirmation = None).build(kit))
            .child(Button::new(&confirm.label).variant(ButtonVariant::Danger)
                .on_press_tx(move |state: &mut State, tx| state.pick_or_send(accepted.clone(), tx)).build(kit));
        modal(state, "confirm-action", &confirm.label, Some(confirm.confirm.as_deref().unwrap_or("This action cannot be undone.")),
            contents, |state| state.confirmation = None, &mut layers);
    }
    if state.dimmed {
        layers.push(el().key("reader-idle-veil").absolute(0.0, 0.0).w_full().h_full()
            .fill(theme::LETTERBOX.alpha(theme::VEIL_ALPHA)).role("button").label("Resume reading")
            .on_press(|state: &mut State| state.wake_reader()));
    }
    let base = col().key("app").w_full().h_full().min_w(0.0).fill(kit.c.bg_base)
        .on_layout(|state: &mut State, rect| { state.width = rect[2]; state.height = rect[3]; })
        .child(header(state)).child(body);
    rune_kit::root(base, layers)
}


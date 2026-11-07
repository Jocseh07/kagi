use crate::protocol::Values;
use rune::{Color, oklcha, tok};
use rune_kit::Kit;

pub const UNIT: f32 = tok::space::S1;
pub const GAP: f32 = tok::space::S2;
pub const GROUP: f32 = tok::space::S6;
pub const FRAME: f32 = 1152.0;
pub const COMPACT: f32 = 768.0;
pub const COVER_RATIO: f32 = 2.0 / 3.0;
pub const BORDER: f32 = 1.0;
pub const MIN_WIDTH: f32 = 375.0;
pub const MIN_HEIGHT: f32 = 400.0;
pub const LETTERBOX: Color = Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 };
pub const DIALOG_HEIGHT: f32 = 368.0;
pub const NOVEL_PROGRESS: f64 = 1000.0;
pub const PROGRESS_END_TOLERANCE: f32 = 2.0;
pub const DIM_AFTER: std::time::Duration = std::time::Duration::from_secs(20);
pub const VEIL_ALPHA: f32 = 0.8;

pub fn length(value: &str) -> Option<f32> {
    let value = value.trim();
    let (number, scale) = if let Some(number) = value.strip_suffix("rem") { (number, 16.0) }
        else { (value.strip_suffix("px").unwrap_or(value), 1.0) };
    number.parse::<f32>().ok().filter(|number| number.is_finite() && *number >= 0.0).map(|number| number * scale)
}

pub fn color(value: &str) -> Option<Color> {
    let value = value.trim();
    if value.starts_with('#') { return value.is_ascii().then(|| rune::theme::hex(value)).flatten(); }
    if value == "transparent" { return Some(Color::TRANSPARENT); }
    if value == "black" { return Some(Color::BLACK); }
    if value == "white" { return Some(Color::WHITE); }
    if value.starts_with("rgb(") || value.starts_with("rgba(") || value.starts_with("hsl(") || value.starts_with("hsla(") {
        return functional_color(value);
    }
    let content = value.strip_prefix("oklch(")?.strip_suffix(')')?;
    let mut parts = content.split_whitespace();
    let light = parts.next()?;
    let l = light.trim_end_matches('%').parse::<f32>().ok()? / if light.ends_with('%') { 100.0 } else { 1.0 };
    let c = parts.next()?.parse::<f32>().ok()?;
    let h = parts.next()?.trim_end_matches("deg").parse::<f32>().ok()?;
    let a = match parts.next() {
        None => 1.0,
        Some("/") => {
            let value = parts.next()?;
            value.trim_end_matches('%').parse::<f32>().ok()? / if value.ends_with('%') { 100.0 } else { 1.0 }
        }
        _ => return None,
    };
    if parts.next().is_some() { return None; }
    if ![l, c, h, a].iter().all(|value| value.is_finite()) || !(0.0..=1.0).contains(&l) || !(0.0..=1.0).contains(&a) || !(0.0..=0.5).contains(&c) { return None; }
    Some(oklcha(l, c, h, a))
}

fn functional_color(value: &str) -> Option<Color> {
    let (kind, body) = value.split_once('(')?;
    let parts: Vec<&str> = body.strip_suffix(')')?.split(|ch: char| ch.is_whitespace() || ch == ',' || ch == '/').filter(|part| !part.is_empty()).collect();
    if parts.len() != 3 && parts.len() != 4 { return None; }
    let scalar = |value: &str, scale: f32| {
        value.trim_end_matches('%').parse::<f32>().ok().map(|number| number / if value.ends_with('%') { 100.0 } else { scale })
            .filter(|number| number.is_finite() && (0.0..=1.0).contains(number))
    };
    let alpha = if parts.len() == 4 { scalar(parts[3], 1.0)? } else { 1.0 };
    let channels = if kind == "rgb" || kind == "rgba" {
        [scalar(parts[0], 255.0)?, scalar(parts[1], 255.0)?, scalar(parts[2], 255.0)?]
    } else {
        let hue = parts[0].trim_end_matches("deg").parse::<f32>().ok()?;
        if !hue.is_finite() || !parts[1].ends_with('%') || !parts[2].ends_with('%') { return None; }
        let saturation = scalar(parts[1], 1.0)?;
        let lightness = scalar(parts[2], 1.0)?;
        let chroma = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
        let h = hue.rem_euclid(360.0) / 60.0;
        let x = chroma * (1.0 - (h.rem_euclid(2.0) - 1.0).abs());
        let base = match h as u8 {
            0 => [chroma, x, 0.0], 1 => [x, chroma, 0.0], 2 => [0.0, chroma, x],
            3 => [0.0, x, chroma], 4 => [x, 0.0, chroma], _ => [chroma, 0.0, x],
        };
        base.map(|channel| channel + lightness - chroma / 2.0)
    };
    let [r, g, b] = channels.map(rune::color::srgb_decode);
    Some(Color { r, g, b, a: alpha })
}

pub fn title(kit: &Kit, width: f32) -> rune::TextStyle {
    let (size, line_height) = if width >= COMPACT { (24.0, 32.0) } else { (20.0, 28.0) };
    rune::TextStyle { size, line_height, tracking: size * -0.025, weight: tok::type_::SECTION.weight, ..kit.ty.body_medium }
}

pub fn token<'a>(theme: &'a Values, name: &str) -> Option<&'a str> {
    theme.get(name).or_else(|| theme.get(&format!("--{name}"))).map(String::as_str)
}

pub fn kit(theme: &Values, system_dark: bool) -> Kit {
    let dark = match token(theme, "mode").or_else(|| token(theme, "color-scheme")) {
        Some("dark") => true, Some("light") => false, _ => system_dark,
    };
    let mut kit = Kit::neutral(dark);
    let scoped = |name: &str| theme.get(&format!("{}.{name}", if dark { "dark" } else { "light" })).map(String::as_str).or_else(|| token(theme, name));
    let read = |name: &str, default| scoped(name).and_then(color).unwrap_or(default);
    let c = &mut kit.c;
    c.bg_base = read("background", c.bg_base);
    c.page = c.bg_base;
    c.text_base = read("foreground", c.text_base);
    c.text_strong = c.text_base;
    c.text_weak = read("muted-foreground", c.text_weak);
    c.text_muted = c.text_weak;
    c.text_faint = c.text_weak;
    c.layer_01 = read("card", c.layer_01);
    c.layer_02 = read("muted", c.layer_02);
    c.layer_03 = read("secondary", c.layer_03);
    c.layer_04 = read("accent", c.layer_04);
    c.bg_accent = read("primary", c.bg_accent);
    c.submit_fg = read("primary-foreground", c.submit_fg);
    c.submit_icon = c.submit_fg;
    c.text_accent = c.bg_accent;
    c.icon_accent = c.bg_accent;
    c.border_base = read("border", c.border_base);
    c.border_muted = c.border_base;
    c.border_weak = c.border_base;
    c.border_strong = c.border_base;
    c.border_focus = read("ring", c.border_focus);
    c.surface_base = c.layer_01;
    c.surface_weak = c.layer_02;
    c.surface_raised = c.layer_01;
    c.surface_raised_base = c.layer_01;
    c.surface_float = read("popover", c.surface_float);
    c.bg_button_neutral = c.layer_03;
    c.bg_contrast = c.bg_accent;
    c.text_contrast = c.submit_fg;
    c.icon_contrast = c.submit_fg;
    c.text_inverse = c.submit_fg;
    c.text_invert_strong = c.submit_fg;
    c.danger.fg = read("destructive", c.danger.fg);
    c.danger.icon = c.danger.fg;
    c.danger.border = c.danger.fg;
    c.icon_base = c.text_base;
    c.icon_muted = c.text_weak;
    c.icon_faint = c.text_weak;
    c.std_text = c.text_base;
    c.std_icon = c.icon_base;
    c.std_border = c.border_base;
    if let Some(radius) = token(theme, "radius").and_then(length).filter(|radius| *radius <= GROUP * 2.0) {
        kit.radius.xs = radius * 0.35;
        kit.radius.sm = radius * 0.6;
        kit.radius.md = radius * 0.8;
        kit.radius.lg = radius;
        kit.radius.xl = radius * 1.4;
    }
    kit
}

pub fn reader_kit(theme: &Values, surface: Option<&str>, system_dark: bool) -> Kit {
    if matches!(surface, Some("dark" | "muted" | "black")) {
        let mut theme = theme.clone();
        theme.insert("mode".into(), "dark".into());
        kit(&theme, true)
    } else { kit(theme, system_dark) }
}

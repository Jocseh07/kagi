use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub type Values = BTreeMap<String, String>;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    pub route: String,
    pub route_key: String,
    pub title: String,
    pub subtitle: Option<String>,
    #[serde(default)] pub tabs: Vec<Tab>,
    #[serde(default)] pub actions: Vec<Action>,
    #[serde(default)] pub sections: Vec<Section>,
    pub dialog: Option<Dialog>,
    pub reader: Option<Reader>,
    #[serde(default)] pub theme: Values,
    #[serde(default)] pub fonts: Vec<FontFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FontFile { pub family: String, pub path: String }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub id: String,
    pub label: String,
    pub route: String,
    pub params: Option<Value>,
    #[serde(default)] pub selected: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub id: String,
    pub label: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub params: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")] pub variant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub confirm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub pick: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub cancelable: Option<bool>,
    #[serde(default)] pub accept: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: String,
    pub title: Option<String>,
    pub status: Option<String>,
    pub error: Option<String>,
    pub empty: Option<String>,
    pub layout: Option<String>,
    #[serde(default)] pub rows: Vec<Row>,
    #[serde(default)] pub fields: Vec<Field>,
    #[serde(default)] pub actions: Vec<Action>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub detail: Option<String>,
    pub image: Option<String>,
    pub image_ref: Option<ImageRef>,
    #[serde(default)] pub badges: Vec<String>,
    pub progress: Option<f32>,
    #[serde(default)] pub actions: Vec<Action>,
    #[serde(default)] pub selected: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub value: String,
    pub hint: Option<String>,
    #[serde(default)] pub options: Vec<Choice>,
    #[serde(default)] pub disabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Choice { pub value: String, pub label: String }

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Dialog {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    #[serde(default)] pub fields: Vec<Field>,
    pub actions: Vec<Action>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reader {
    pub series_id: String,
    pub chapter_id: String,
    pub kind: String,
    pub mode: String,
    pub position: f64,
    #[serde(default)] pub pages: Vec<Page>,
    #[serde(default)] pub blocks: Vec<TextBlock>,
    pub font_family: Option<String>,
    pub font_size: Option<f32>,
    pub line_height: Option<f32>,
    pub measure: Option<f32>,
    pub fit: Option<String>,
    pub gap: Option<bool>,
    pub continuous_style: Option<String>,
    pub surface: Option<String>,
    pub justify: Option<bool>,
    pub word_starts: Option<String>,
    pub dim_idle: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub path: Option<String>,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub image_ref: Option<ImageRef>,
    #[serde(skip)] pub renderer_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TextBlock {
    pub id: String,
    pub kind: String,
    pub text: Option<String>,
    pub level: Option<u8>,
    #[serde(default)] pub spans: Vec<TextSpan>,
    pub image: Option<String>,
    #[serde(rename = "imageRef")] pub image_ref: Option<ImageRef>,
    #[serde(skip)] pub renderer_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TextSpan {
    pub text: String,
    #[serde(default)] pub bold: bool,
    #[serde(default)] pub italic: bool,
    #[serde(default)] pub mono: bool,
    #[serde(default)] pub underline: bool,
    pub href: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Request { pub id: u64, pub method: String, pub params: Value }

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultData {
    pub screen: Option<Screen>,
    pub notice: Option<String>,
    pub external_url: Option<String>,
    pub export_path: Option<String>,
    pub image: Option<ResolvedImage>,
}

#[derive(Debug, Deserialize)]
pub struct EngineError { pub code: String, pub message: String }

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Incoming {
    Event(Event),
    Reply { id: u64, ok: bool, result: Option<ResultData>, error: Option<EngineError> },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum Event {
    Section { #[serde(rename = "routeKey")] route_key: String, section: Section },
    Reader { #[serde(rename = "routeKey")] route_key: String, reader: Reader },
    Notice { message: String },
    Changed { topics: Vec<String> },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRef {
    pub source_id: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")] pub descramble: Option<Descramble>,
    #[serde(skip)] pub key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Descramble { pub cols: u32, pub rows: u32, pub tiles: Vec<u32> }

#[derive(Clone, Debug, Deserialize)]
pub struct ResolvedImage { pub key: String, pub path: String, pub width: f32, pub height: f32 }

impl Incoming {
    pub fn prepare(&mut self) {
        fn image(reference: &mut Option<ImageRef>) {
            if let Some(reference) = reference {
                reference.key = serde_json::to_string(reference).unwrap_or_default();
            }
        }
        fn section(section: &mut Section) {
            for row in &mut section.rows { image(&mut row.image_ref); }
        }
        fn prepare_reader(reader: &mut Reader) {
            for (index, page) in reader.pages.iter_mut().enumerate() {
                page.renderer_key = format!("reader-page-{index}");
                image(&mut page.image_ref);
            }
            for block in &mut reader.blocks {
                block.renderer_key = format!("reader-block-{}", block.id);
                image(&mut block.image_ref);
            }
        }
        match self {
            Incoming::Reply { result: Some(result), .. } => {
                if let Some(screen) = &mut result.screen {
                    for model in &mut screen.sections { section(model); }
                    if let Some(reader) = &mut screen.reader { prepare_reader(reader); }
                }
            }
            Incoming::Event(Event::Section { section: model, .. }) => section(model),
            Incoming::Event(Event::Reader { reader, .. }) => prepare_reader(reader),
            _ => {}
        }
    }
}

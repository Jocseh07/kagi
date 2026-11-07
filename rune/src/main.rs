mod assets;
mod engine;
mod protocol;
mod reader;
mod resolution;
mod state;
mod theme;
mod view;

use rune::{App, AppSpec};
use state::State;

fn main() {
    rune::set_app_id("io.github.Jocseh07.kagi");
    let spec = AppSpec {
        min_size: Some((theme::MIN_WIDTH, theme::MIN_HEIGHT)),
        setup: Some(State::setup),
        poll: Some(|state, _, tx| state.poll(tx)),
        on_key: Some(reader::key),
        ..AppSpec::new("Kagi", (theme::FRAME, theme::COMPACT), State::new, view::view)
    };
    let app = App::new(spec).keep_running().on_close(State::close);
    let handle = app.handle();
    app.init(move || {
        let mut state = State::new();
        state.app_handle = Some(handle);
        state
    }).run();
}

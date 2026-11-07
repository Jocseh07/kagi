use crate::protocol::{Incoming, Request};
use rune::Waker;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

pub enum CommandMessage { Request(Request), Shutdown }
pub enum Message { Incoming(Incoming), Failed(String), OutputClosed, Stopped }

pub struct Engine {
    pub send: mpsc::Sender<CommandMessage>,
    pub receive: mpsc::Receiver<Message>,
}

struct Completion { events: mpsc::SyncSender<Message>, wake: Waker }
impl Drop for Completion {
    fn drop(&mut self) { let _ = self.events.send(Message::Stopped); (self.wake)(); }
}

fn data_directory() -> Result<PathBuf, String> {
    let args = rune::extra_args();
    if let Some(i) = args.iter().position(|arg| arg == "--data-dir") {
        return args.get(i + 1).map(PathBuf::from).ok_or_else(|| "--data-dir needs a path".into());
    }
    if let Some(path) = args.iter().find_map(|arg| arg.strip_prefix("--data-dir=")) {
        return Ok(path.into());
    }
    if let Some(path) = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|path| path.is_absolute()) {
        return Ok(path.join("kagi-rune"));
    }
    std::env::var_os("HOME").map(PathBuf::from).filter(|path| path.is_absolute()).map(|home| home.join(".local/share/kagi-rune"))
        .ok_or_else(|| "Set XDG_DATA_HOME or pass --data-dir.".into())
}

fn launch() -> Result<Child, String> {
    let engine = match std::env::var_os("KAGI_ENGINE") {
        Some(path) => PathBuf::from(path),
        None => std::env::current_exe().map_err(|error| format!("Cannot locate the packaged engine: {error}"))?.with_file_name("kagi-engine"),
    };
    let mut command = if engine.extension().is_some_and(|ext| ext == "js" || ext == "mjs") {
        let mut command = Command::new(std::env::var_os("KAGI_BUN").unwrap_or_else(|| "bun".into()));
        command.arg(&engine);
        command
    } else { Command::new(&engine) };
    command.arg("--data-dir").arg(data_directory()?).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    command.spawn().map_err(|error| format!("Cannot start {}: {error}", engine.display()))
}

impl Engine {
    pub fn start(wake: Waker) -> Self {
        let (send, requests) = mpsc::channel();
        let (events, receive) = mpsc::sync_channel(128);
        let reader_stop = send.clone();
        thread::Builder::new().name("kagi-engine-host".into()).spawn(move || {
            let _completion = Completion { events: events.clone(), wake: wake.clone() };
            let fail = |message: String| { let _ = events.send(Message::Failed(message)); wake(); };
            let mut child = match launch() { Ok(child) => child, Err(error) => { fail(error); return; } };
            let Some(mut input) = child.stdin.take() else { fail("Engine input is unavailable.".into()); let _ = child.kill(); let _ = child.wait(); return; };
            let Some(output) = child.stdout.take() else { fail("Engine output is unavailable.".into()); let _ = child.kill(); let _ = child.wait(); return; };
            let reader_events = events.clone();
            let reader_wake = wake.clone();
            let reader = thread::Builder::new().name("kagi-engine-output".into()).spawn(move || {
                let mut lines = BufReader::new(output);
                let mut line = String::new();
                loop {
                    line.clear();
                    let message = match lines.read_line(&mut line) {
                        Ok(0) => {
                            let _ = reader_events.send(Message::OutputClosed);
                            let _ = reader_stop.send(CommandMessage::Shutdown);
                            reader_wake();
                            break;
                        }
                        Ok(_) => match serde_json::from_str::<Incoming>(&line) {
                            Ok(mut message) => { message.prepare(); Message::Incoming(message) },
                            Err(_) => Message::Failed("The engine returned invalid data. Restart Kagi.".into()),
                        },
                        Err(error) => {
                            let _ = reader_events.send(Message::Failed(format!("Engine connection failed: {error}")));
                            let _ = reader_stop.send(CommandMessage::Shutdown);
                            reader_wake();
                            break;
                        }
                    };
                    if reader_events.send(message).is_err() { break; }
                    reader_wake();
                }
            });
            if let Err(error) = &reader {
                fail(format!("Cannot read engine output: {error}"));
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            for message in requests {
                match message {
                    CommandMessage::Request(request) => {
                        let written = serde_json::to_writer(&mut input, &request).and_then(|_| {
                            input.write_all(b"\n").map_err(serde_json::Error::io)
                        }).and_then(|_| input.flush().map_err(serde_json::Error::io));
                        if let Err(error) = written { fail(format!("Engine request failed: {error}")); break; }
                    }
                    CommandMessage::Shutdown => break,
                }
            }
            drop(input);
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if child.try_wait().ok().flatten().is_some() { break; }
                if Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); break; }
                thread::sleep(Duration::from_millis(25));
            }
            if let Ok(reader) = reader { let _ = reader.join(); }
        }).expect("engine host thread");
        Self { send, receive }
    }
}

impl Drop for Engine {
    fn drop(&mut self) { let _ = self.send.send(CommandMessage::Shutdown); }
}

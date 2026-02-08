use std::fs::OpenOptions;
use std::io::Write;
use std::sync::{LazyLock, Mutex};

static LOG_FILE: LazyLock<Mutex<Option<std::fs::File>>> = LazyLock::new(|| Mutex::new(None));

pub fn init(filename: &str) {
    if jstorrent_common::read_env_value("LOGFILE").as_deref() != Some("true") {
        return;
    }
    if let Some(log_dir) = jstorrent_common::get_log_dir() {
        let log_path = log_dir.join(filename);
        if let Ok(file) = OpenOptions::new().create(true).append(true).open(&log_path) {
            *LOG_FILE.lock().unwrap() = Some(file);
            log("Logger initialized");
        }
    }
}

pub fn log(msg: &str) {
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let formatted_msg = format!("[{timestamp}] {msg}\n");

    // Always print to stderr (for terminal visibility)
    eprint!("{formatted_msg}");

    // Write to log file if enabled
    if let Ok(mut file_guard) = LOG_FILE.lock() {
        if let Some(file) = file_guard.as_mut() {
            let _ = file.write_all(formatted_msg.as_bytes());
        }
    }
}

#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => {
        $crate::logging::log(&format!($($arg)*));
    }
}

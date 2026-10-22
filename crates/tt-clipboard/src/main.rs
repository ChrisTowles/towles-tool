#[cfg(target_os = "linux")]
mod cli;

#[cfg(target_os = "linux")]
fn main() -> std::process::ExitCode {
    cli::main()
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("tt-clip is Linux-only: it reads the clipboard over Wayland");
    std::process::exit(1);
}

//! Pre-warm the code-server the Files pane provisions on first use, from a
//! terminal: `cargo run -p tt-codeserver --example provision`. The app does
//! this itself — this is for doing it before a demo, or on a machine that is
//! about to go offline.

fn main() {
    let root = tt_config::code_server_install_dir().expect("no data dir");
    let mut last = String::new();
    let result = tt_codeserver::install::ensure(&root, &mut |p| {
        let line = format!("{:?} {}%", p.phase, p.done_bytes * 100 / p.total_bytes.max(1));
        if line != last {
            println!("{line}");
            last = line;
        }
    });
    match result {
        Ok(bin) => println!("code-server ready: {}", bin.display()),
        Err(e) => {
            eprintln!("provisioning failed: {e}");
            std::process::exit(1);
        }
    }
}

//! Dev tasks (`cargo xtask <task>`). One task today, in the module named after it.

mod comment_budget;

use std::env;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("comment-budget") => comment_budget::run(&args[1..]),
        _ => {
            eprintln!(
                "usage: cargo xtask <task>\n\ntasks:\n  comment-budget    gate on comment volume"
            );
            ExitCode::from(2)
        }
    }
}

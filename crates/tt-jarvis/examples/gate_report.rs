//! Reads the JSONL emitted by the two benchmark hosts and prints the Step 0
//! verdict.
//!
//! Deliberately goes through [`FrameStats::compare_to_baseline`] rather than
//! recomputing the thresholds here: that function is unit-tested, and a second
//! copy of the gate arithmetic in a report script is exactly the kind of thing
//! that drifts from the tested one and quietly changes what "pass" means.
//!
//! ```sh
//! cargo run -p tt-jarvis --example gate_report -- gate.jsonl
//! ```

use std::collections::BTreeMap;

use tt_jarvis::stats::FrameStats;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: gate_report <results.jsonl>");
        std::process::exit(2);
    });
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        eprintln!("cannot read {path}: {e}");
        std::process::exit(2);
    });

    // (size, mode) -> host -> best run
    let mut arms: BTreeMap<(String, String), BTreeMap<String, FrameStats>> = BTreeMap::new();
    let mut errors = 0usize;

    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("error").is_some() {
            errors += 1;
            eprintln!("run failed: {line}");
            continue;
        }
        let (Some(label), Some(stats)) = (value["label"].as_str(), value.get("stats")) else {
            continue;
        };
        let Ok(stats) = serde_json::from_value::<FrameStats>(stats.clone()) else {
            continue;
        };

        let mut parts = label.split('/');
        let (Some(host), Some(size), Some(mode)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };

        // Best-of-N per arm: background load only ever makes a run slower, so
        // the fastest run is the closest available estimate of the arm's real
        // cost. Both arms get the same treatment, and they were interleaved.
        arms.entry((size.into(), mode.into()))
            .or_default()
            .entry(host.into())
            .and_modify(|best| {
                if stats.median_us < best.median_us {
                    *best = stats.clone();
                }
            })
            .or_insert(stats);
    }

    println!(
        "{:<12} {:<8} {:>11} {:>11} {:>9} {:>9}  verdict",
        "size", "mode", "base med", "pane med", "Δmed", "Δp99"
    );
    println!("{}", "-".repeat(78));

    let mut all_passed = true;
    let mut compared = 0usize;

    for ((size, mode), hosts) in &arms {
        let (Some(baseline), Some(pane)) = (hosts.get("standalone"), hosts.get("subsurface"))
        else {
            println!("{size:<12} {mode:<8} incomplete arm — one host produced no runs");
            all_passed = false;
            continue;
        };
        let cmp = pane.compare_to_baseline(baseline);
        compared += 1;
        all_passed &= cmp.passed;

        println!(
            "{:<12} {:<8} {:>9}µs {:>9}µs {:>+8.1}% {:>+8.1}%  {}",
            size,
            mode,
            baseline.median_us,
            pane.median_us,
            cmp.median_regression_pct,
            cmp.p99_regression_pct,
            if cmp.passed { "PASS" } else { "FAIL" },
        );
    }

    println!();
    if errors > 0 {
        println!("{errors} run(s) produced no output — see stderr");
    }
    if compared == 0 {
        println!("VERDICT: no complete arms to compare");
        std::process::exit(1);
    }
    println!(
        "VERDICT: {} ({compared} arms, budgets: median {}%, p99 {}%)",
        if all_passed { "PASS — embedding is within budget" } else { "FAIL" },
        tt_jarvis::stats::MEDIAN_BUDGET_PCT,
        tt_jarvis::stats::P99_BUDGET_PCT,
    );
    if !all_passed {
        std::process::exit(1);
    }
}

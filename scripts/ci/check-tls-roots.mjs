#!/usr/bin/env node
// Fails if Cargo.lock declares `webpki-roots` or `rustls`: Chris develops behind
// a Zscaler-style TLS-inspecting proxy whose root CA lives only in the OS trust
// store, which a bundled Mozilla root list never sees. Prefer `native-tls` or an
// OS-native-roots rustls variant (rustls-native-certs / rustls-tls-native-roots).
// Run from the repo root.

import { readFileSync } from "node:fs";

const BANNED = ["webpki-roots", "rustls"];
const lockfile = "Cargo.lock";

const lines = readFileSync(lockfile, "utf8").split("\n");
const hits = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^name = "([^"]+)"/.exec(lines[i]);
  if (m && BANNED.includes(m[1])) hits.push(`${lockfile}:${i + 1}: ${m[1]}`);
}

if (hits.length > 0) {
  console.error(
    "Bundled-roots TLS crate(s) found in Cargo.lock.\n" +
      "TLS clients must trust the OS store (native-tls or an OS-native-roots\n" +
      "rustls variant), not webpki-roots/bundled rustls — see the TLS-clients\n" +
      "convention in CLAUDE.md.\n",
  );
  for (const h of hits) console.error("  " + h);
  process.exit(1);
}

console.log(`OK: no bundled-roots TLS crates (${BANNED.join(", ")}) in Cargo.lock.`);

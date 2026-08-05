// Puts the platform package's binary where `bin` points, so the installed
// `comment-budget` is the executable itself rather than a node process that
// spawns one. The shim it replaces shares the resolution below.

const fs = require("node:fs");
const path = require("node:path");

const EXE = "comment-budget";
const SHIM = path.join(__dirname, EXE);

// glibcVersionRuntime is absent on musl. This is detect-libc's own check, and
// inlining it keeps the wrapper dependency-free.
function isMusl() {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport?.();
  return report ? !report.header?.glibcVersionRuntime : false;
}

function platformPackage() {
  const { platform, arch } = process;
  const name = (suffix) => `@towles-tool/comment-budget-${suffix}`;
  if (platform === "darwin" && arch === "arm64") return name("darwin-arm64");
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
    return isMusl() ? null : name(`linux-${arch}-gnu`);
  }
  return null;
}

function resolveBinary() {
  const pkg = platformPackage();
  if (!pkg) return null;
  try {
    const dir = path.dirname(require.resolve(`${pkg}/package.json`, { paths: [__dirname] }));
    const binary = path.join(dir, "bin", EXE);
    return fs.existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

// True only in the crate that builds this package, where `comment-budget` is
// the committed shim `pack.sh` packs into the tarball. Overwriting it there turns
// a host binary into a staged source change, and a published one if anyone
// commits it. A consumer's install has no crate manifest two levels up.
function inSourceTree() {
  try {
    const manifest = fs.readFileSync(path.join(__dirname, "..", "..", "Cargo.toml"), "utf8");
    return manifest.includes(`name = "${EXE}"`);
  } catch {
    return false;
  }
}

function missingBinaryMessage() {
  const host = `${process.platform}-${process.arch}`;
  if (isMusl()) {
    return (
      `comment-budget: no prebuilt binary for ${host} (musl libc).\n` +
      "Only glibc Linux is prebuilt; on Alpine, build from source with `cargo install comment-budget`."
    );
  }
  // An Apple Silicon machine running node under Rosetta also reports x64, and
  // reads as an unsupported platform unless the message says otherwise.
  if (process.platform === "darwin" && process.arch === "x64") {
    return (
      "comment-budget: no prebuilt binary for darwin-x64.\n" +
      "Only Apple Silicon is prebuilt. On an arm64 Mac this means node is running\n" +
      "under Rosetta — use an arm64 node. On an Intel Mac, build from source with\n" +
      "`cargo install comment-budget`."
    );
  }
  const pkg = platformPackage();
  return (
    `comment-budget: no prebuilt binary for ${host}.\n` +
    (pkg
      ? `Expected the optional dependency ${pkg}. Reinstall without --no-optional,`
      : "This platform is not prebuilt;") +
    " or build from source with `cargo install comment-budget`."
  );
}

function install() {
  if (inSourceTree()) return;
  const source = resolveBinary();
  // A missing binary is the shim's to report, so an unsupported host — Windows
  // among them — installs quietly rather than failing.
  if (!source) return;
  try {
    fs.rmSync(SHIM, { force: true });
    try {
      fs.linkSync(source, SHIM);
    } catch {
      fs.copyFileSync(source, SHIM);
    }
    fs.chmodSync(SHIM, 0o755);
  } catch (error) {
    console.error(`comment-budget: keeping the fallback shim (${error.message})`);
  }
}

module.exports = { resolveBinary, missingBinaryMessage, platformPackage, inSourceTree };

if (require.main === module) install();

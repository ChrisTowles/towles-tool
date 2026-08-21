const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const vscode = require("vscode");

// A checkout's workbench is one *window* on a code-server shared by the whole
// app instance, and every window's extension host inherits the same env — so
// the folder it opened, not the environment, is what makes this socket unique.
function socketPath(folder) {
  const dir = process.env.TT_BRIDGE_DIR;
  if (!dir || !folder) return undefined;
  const key = crypto.createHash("sha256").update(folder.fsPath).digest("hex").slice(0, 16);
  return path.join(dir, `w-${key}.sock`);
}

// The extension host answers before the git extension has scanned the folder,
// and a cold pane is exactly when this gets asked. The caller retries on 503, so
// say "not yet" rather than open a diff of nothing.
class NotReady extends Error {}

async function repository(folder) {
  const git = vscode.extensions.getExtension("vscode.git");
  if (!git) throw new NotReady("no git extension");
  const api = (await git.activate()).getAPI(1);
  const repo = api.state === "initialized" && (api.getRepository(folder) ?? api.repositories[0]);
  if (!repo) throw new NotReady("git has not scanned this folder yet");
  return repo;
}

// The caller asks with one number — everything uncommitted — and VS Code has a
// multi-file diff editor per SCM group, none spanning them. So both open: the
// staged one pinned, since the second would otherwise replace it in the same
// preview slot, and the working tree last so it is the one in front.
async function showChanges(repo) {
  const staged = repo.state.indexChanges.length;
  const working = repo.state.workingTreeChanges.length + (repo.state.untrackedChanges ?? []).length;
  if (staged) {
    await vscode.commands.executeCommand("git.viewStagedChanges");
    await vscode.commands.executeCommand("workbench.action.keepEditor");
  }
  if (working) await vscode.commands.executeCommand("git.viewChanges");
  // With nothing to diff, an empty diff editor would say less than the view does.
  if (!staged && !working) await vscode.commands.executeCommand("workbench.view.scm");
}

async function run(folder, request) {
  if (request.type !== "changes") throw new Error(`unknown request: ${request.type}`);
  return showChanges(await repository(folder));
}

function reply(conn, status, body) {
  const head = `HTTP/1.0 ${status} ${status === 200 ? "OK" : "Error"}\r\n`;
  conn.end(`${head}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

// HTTP/1.0 over a unix socket, the shape tt-codeserver already speaks to
// code-server's own window registry. Answered on Content-Length: the caller
// keeps its write half open, so waiting for EOF would deadlock.
function onConnection(folder, conn) {
  let raw = "";
  conn.setEncoding("utf8");
  conn.on("error", () => conn.destroy());
  conn.on("data", async (chunk) => {
    raw += chunk;
    const split = raw.indexOf("\r\n\r\n");
    if (split < 0) return;
    const body = raw.slice(split + 4);
    const length = Number(/content-length:\s*(\d+)/i.exec(raw.slice(0, split))?.[1] ?? 0);
    if (Buffer.byteLength(body) < length) return;
    conn.removeAllListeners("data");
    try {
      await run(folder, JSON.parse(body));
      reply(conn, 200, '{"ok":true}');
    } catch (e) {
      const status = e instanceof NotReady ? 503 : 500;
      reply(conn, status, JSON.stringify({ error: e?.message ?? String(e) }));
    }
  });
}

function activate(context) {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const socket = socketPath(folder);
  if (!socket) return;
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  fs.rmSync(socket, { force: true });
  const server = net.createServer((conn) => onConnection(folder, conn));
  server.on("error", (e) => console.error("[tt-bridge]", e.message));
  server.listen(socket);
  context.subscriptions.push({
    dispose() {
      server.close();
      fs.rmSync(socket, { force: true });
    },
  });
}

module.exports = { activate };

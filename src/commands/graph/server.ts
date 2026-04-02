import * as http from "node:http";
import { run } from "@towles/shared";

/**
 * Start a local HTTP server to serve the generated HTML.
 * Tries successive ports if the initial port is in use.
 * Returns the actual port used.
 */
export async function startServer(
  html: string,
  filename: string,
  startPort: number,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === `/${filename}`) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  const maxAttempts = 10;

  const tryPort = (port: number): Promise<number> => {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE" && port < startPort + maxAttempts - 1) {
          resolve(tryPort(port + 1));
        } else {
          reject(err);
        }
      };

      const onListening = () => {
        server.removeListener("error", onError);
        resolve(port);
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port);
    });
  };

  const port = await tryPort(startPort);
  return { server, port };
}

/**
 * Open a URL in the default browser.
 */
export function openInBrowser(url: string): void {
  const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
  run(openCmd, [url]);
}

/**
 * Wait for SIGINT and then close the server.
 */
export function waitForShutdown(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      server.close();
      resolve();
    });
  });
}

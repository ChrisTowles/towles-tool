// Injected into every frame of the app's webview, so it acts only where a
// workbench URL named a keymap (tt_codeserver::workbench_url). The URL is read
// once and kept per origin: a window reload inside VS Code drops the query.
(() => {
  const FLAG = "tt-keymap";
  let keymap;
  try {
    const asked = new URLSearchParams(location.search).get(FLAG);
    if (asked) sessionStorage.setItem(FLAG, asked);
    keymap = asked ?? sessionStorage.getItem(FLAG);
  } catch {
    return;
  }
  if (keymap !== "pc") return;

  // VS Code picks its keymap off the user agent, xterm.js off the platform.
  const spoofed = {
    userAgent: navigator.userAgent.replace(/\(Macintosh;[^)]*\)/, "(X11; Linux x86_64)"),
    platform: "Linux x86_64",
  };
  for (const [key, value] of Object.entries(spoofed)) {
    Object.defineProperty(Navigator.prototype, key, { get: () => value, configurable: true });
  }

  // In a browser VS Code leaves copy and cut unbound, trusting the browser's
  // own chord — which on a Mac is ⌘. Its terminal keeps Ctrl+C as SIGINT.
  const COMMANDS = { c: "copy", x: "cut" };
  addEventListener(
    "keydown",
    (e) => {
      const command = COMMANDS[e.key.toLowerCase()];
      if (!command || !e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const target = e.target;
      if (!(target instanceof Element) || target.closest(".xterm")) return;
      const editable = target.matches("input, textarea") || target.isContentEditable;
      if (!editable && (getSelection()?.isCollapsed ?? true)) return;
      if (document.execCommand(command)) e.preventDefault();
    },
    true,
  );
})();

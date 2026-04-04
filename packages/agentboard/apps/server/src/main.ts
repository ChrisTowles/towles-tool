import {
  AmpAgentWatcher,
  ClaudeCodeAgentWatcher,
  CodexAgentWatcher,
  OpenCodeAgentWatcher,
  PluginLoader,
  loadConfig,
  startServer,
} from "@tt-agentboard/runtime";
import { TmuxProvider } from "@tt-agentboard/mux-tmux";
import consola from "consola";

const config = loadConfig();
const loader = new PluginLoader();

// Register tmux provider (tmux only)
try {
  const provider = new TmuxProvider();
  loader.registerMux(provider);
} catch (err) {
  consola.error("Failed to initialize tmux provider:", err);
}

const mux = loader.resolve(config.mux);
if (!mux) {
  consola.error(
    "No terminal multiplexer detected.\n" +
      `Registered providers: ${loader.registry.list().join(", ") || "(none)"}\n` +
      "$TMUX environment variable is not set — are you running inside a tmux session?\n" +
      "Set 'mux' in your towles-tool settings to override.",
  );
  process.exit(1);
}

loader.registerWatcher(new AmpAgentWatcher());
loader.registerWatcher(new ClaudeCodeAgentWatcher());
loader.registerWatcher(new CodexAgentWatcher());
loader.registerWatcher(new OpenCodeAgentWatcher());

const watchers = loader.getWatchers();
if (watchers.length > 0) {
  consola.info(`Agent watchers: ${watchers.map((watcher) => watcher.name).join(", ")}`);
}

consola.info(`Primary mux provider: ${mux.name}`);
startServer(mux, [], watchers);

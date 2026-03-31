import {
  AmpAgentWatcher,
  ClaudeCodeAgentWatcher,
  CodexAgentWatcher,
  OpenCodeAgentWatcher,
  PluginLoader,
  loadConfig,
  startServer,
} from "@tt-agentboard2/runtime";
import { TmuxProvider } from "@tt-agentboard2/mux-tmux";
import { join } from "node:path";

const config = loadConfig();
const loader = new PluginLoader();

// Register tmux provider (tmux only)
try {
  const provider = new TmuxProvider();
  loader.registerMux(provider);
} catch (err) {
  console.error("Failed to initialize tmux provider:", err);
}

const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
const pluginDir = join(home, ".config", "towles-tool", "agentboard2", "plugins");
const localPlugins = loader.loadDir(pluginDir);
if (localPlugins.length > 0) {
  console.log(`Loaded local plugins: ${localPlugins.join(", ")}`);
}

if (config.plugins.length > 0) {
  const npmPlugins = loader.loadPackages(config.plugins);
  if (npmPlugins.length > 0) {
    console.log(`Loaded npm plugins: ${npmPlugins.join(", ")}`);
  }
}

const mux = loader.resolve(config.mux);
if (!mux) {
  console.error(
    "No terminal multiplexer detected.\n" +
      `Registered providers: ${loader.registry.list().join(", ") || "(none)"}\n` +
      "$TMUX environment variable is not set — are you running inside a tmux session?\n" +
      "Set 'mux' in ~/.config/towles-tool/agentboard2/config.json to override.",
  );
  process.exit(1);
}

loader.registerWatcher(new AmpAgentWatcher());
loader.registerWatcher(new ClaudeCodeAgentWatcher());
loader.registerWatcher(new CodexAgentWatcher());
loader.registerWatcher(new OpenCodeAgentWatcher());

const watchers = loader.getWatchers();
if (watchers.length > 0) {
  console.log(`Agent watchers: ${watchers.map((watcher) => watcher.name).join(", ")}`);
}

console.log(`Primary mux provider: ${mux.name}`);
startServer(mux, [], watchers);

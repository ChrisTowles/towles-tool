import { resolve } from "node:path";
import { readFile, writeFile, fileExists } from "@towles/shared";
import type { DoctorRunResult } from "./checks.js";

const MAX_HISTORY = 50;

export interface DiffEntry {
  category: string;
  name: string;
  change: "added" | "removed" | "upgraded" | "downgraded" | "passed" | "failed" | "unchanged";
  oldValue?: string | null;
  newValue?: string | null;
}

function getHistoryPath(): string {
  const configDir = process.env.XDG_CONFIG_HOME ?? resolve(process.env.HOME ?? "~", ".config");
  return resolve(configDir, "tt", "doctor-history.json");
}

export function loadHistory(historyPath?: string): DoctorRunResult[] {
  const path = historyPath ?? getHistoryPath();
  if (!fileExists(path)) return [];
  try {
    return JSON.parse(readFile(path));
  } catch {
    return [];
  }
}

export function saveHistory(result: DoctorRunResult, historyPath?: string): void {
  const path = historyPath ?? getHistoryPath();
  const history = loadHistory(path);
  history.push(result);
  const trimmed = history.slice(-MAX_HISTORY);
  writeFile(path, JSON.stringify(trimmed, null, 2));
}

export function diffRuns(previous: DoctorRunResult, current: DoctorRunResult): DiffEntry[] {
  const entries: DiffEntry[] = [];

  const prevToolMap = new Map(previous.tools.map((t) => [t.name, t]));
  const currToolMap = new Map(current.tools.map((t) => [t.name, t]));

  for (const [name, curr] of currToolMap) {
    const prev = prevToolMap.get(name);
    if (!prev) {
      entries.push({ category: "tool", name, change: "added", newValue: curr.version });
      continue;
    }
    if (prev.version !== curr.version && prev.version && curr.version) {
      entries.push({
        category: "tool",
        name,
        change: compareVersions(prev.version, curr.version) > 0 ? "downgraded" : "upgraded",
        oldValue: prev.version,
        newValue: curr.version,
      });
    }
    if (prev.ok !== curr.ok) {
      entries.push({
        category: "tool",
        name,
        change: curr.ok ? "passed" : "failed",
        oldValue: prev.ok ? "pass" : "fail",
        newValue: curr.ok ? "pass" : "fail",
      });
    }
  }

  for (const [name, prev] of prevToolMap) {
    if (!currToolMap.has(name)) {
      entries.push({ category: "tool", name, change: "removed", oldValue: prev.version });
    }
  }

  if (previous.ghAuth !== current.ghAuth) {
    entries.push({
      category: "auth",
      name: "gh auth",
      change: current.ghAuth ? "passed" : "failed",
      oldValue: previous.ghAuth ? "pass" : "fail",
      newValue: current.ghAuth ? "pass" : "fail",
    });
  }

  const prevPluginMap = new Map(previous.plugins.map((p) => [p.name, p]));
  for (const curr of current.plugins) {
    const prev = prevPluginMap.get(curr.name);
    if (!prev) {
      entries.push({ category: "plugin", name: curr.name, change: "added" });
    } else if (prev.ok !== curr.ok) {
      entries.push({
        category: "plugin",
        name: curr.name,
        change: curr.ok ? "passed" : "failed",
      });
    }
  }

  const prevAbMap = new Map(previous.agentboard.map((a) => [a.name, a]));
  for (const curr of current.agentboard) {
    const prev = prevAbMap.get(curr.name);
    if (!prev) {
      entries.push({ category: "agentboard", name: curr.name, change: "added" });
    } else if (prev.ok !== curr.ok) {
      entries.push({
        category: "agentboard",
        name: curr.name,
        change: curr.ok ? "passed" : "failed",
      });
    }
  }

  return entries;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

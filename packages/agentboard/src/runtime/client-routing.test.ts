import { describe, expect, it } from "vitest";

import { resolveSwitchTargets } from "./client-routing";

const CLIENTS = [
  { tty: "/dev/pts/0", sessionName: "slot-1" },
  { tty: "/dev/pts/3", sessionName: "primary" },
  { tty: "/dev/pts/6", sessionName: "slot-1" },
];

describe("resolveSwitchTargets", () => {
  it("returns the ttys of all clients attached to fromSession", () => {
    expect(resolveSwitchTargets(CLIENTS, "slot-1")).toEqual(["/dev/pts/0", "/dev/pts/6"]);
  });

  it("returns empty for a session with no attached clients", () => {
    expect(resolveSwitchTargets(CLIENTS, "detached-session")).toEqual([]);
  });

  it("returns empty when fromSession is unknown", () => {
    expect(resolveSwitchTargets(CLIENTS, undefined)).toEqual([]);
    expect(resolveSwitchTargets(CLIENTS, null)).toEqual([]);
  });

  it("returns empty with no clients at all", () => {
    expect(resolveSwitchTargets([], "slot-1")).toEqual([]);
  });
});

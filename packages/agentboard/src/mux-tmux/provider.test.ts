import { describe, expect, it } from "vitest";

import { TmuxProvider } from "./provider";
import { TmuxClient } from "./client";
import type { ClientInfo } from "./client";

function client(tty: string, sessionName: string): ClientInfo {
  return { name: tty, tty, pid: 1, sessionName, width: 80, height: 24 };
}

/** Records switch-client calls; serves a canned client list (constructor DI, no vi.mock). */
class FakeTmuxClient extends TmuxClient {
  switches: { target: string; clientTty?: string }[] = [];

  constructor(private clients: ClientInfo[]) {
    super();
  }

  override listClients(): ClientInfo[] {
    return this.clients;
  }

  override switchClient(target: string, options?: { clientTty?: string }): void {
    this.switches.push({ target, clientTty: options?.clientTty });
  }
}

describe("TmuxProvider.switchSession", () => {
  // The original bug: the server stored "the last client that switched to a
  // session" and routed switches via that tty. With two terminals attached,
  // the stored tty pointed at the *other* terminal — clicking a session card
  // moved the wrong client and the clicking terminal never switched.
  it("switches every client attached to fromSession, ignoring other clients", () => {
    const tmux = new FakeTmuxClient([
      client("/dev/pts/0", "slot-1"),
      client("/dev/pts/3", "primary"),
      client("/dev/pts/6", "slot-1"),
    ]);
    const provider = new TmuxProvider({ client: tmux });

    provider.switchSession("slot-2", { fromSession: "slot-1" });

    expect(tmux.switches).toEqual([
      { target: "slot-2", clientTty: "/dev/pts/0" },
      { target: "slot-2", clientTty: "/dev/pts/6" },
    ]);
  });

  it("falls back to default client targeting when no client is attached to fromSession", () => {
    const tmux = new FakeTmuxClient([client("/dev/pts/3", "primary")]);
    const provider = new TmuxProvider({ client: tmux });

    provider.switchSession("slot-2", { fromSession: "gone-session" });

    expect(tmux.switches).toEqual([{ target: "slot-2", clientTty: undefined }]);
  });

  it("falls back to default client targeting with no target info", () => {
    const tmux = new FakeTmuxClient([client("/dev/pts/0", "slot-1")]);
    const provider = new TmuxProvider({ client: tmux });

    provider.switchSession("slot-2");

    expect(tmux.switches).toEqual([{ target: "slot-2", clientTty: undefined }]);
  });

  it("honors an explicit clientTty without consulting the client list", () => {
    const tmux = new FakeTmuxClient([
      client("/dev/pts/0", "slot-1"),
      client("/dev/pts/3", "primary"),
    ]);
    const provider = new TmuxProvider({ client: tmux });

    provider.switchSession("slot-2", { clientTty: "/dev/pts/3", fromSession: "slot-1" });

    expect(tmux.switches).toEqual([{ target: "slot-2", clientTty: "/dev/pts/3" }]);
  });
});

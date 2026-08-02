import { describe, expect, it } from "vitest";
import { cdpModifiers, keyEvents, mouseEvent, normalizeUrl, wheelEvent } from "@/lib/browser";

const noMods = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe("cdpModifiers", () => {
  it("packs Alt/Ctrl/Meta/Shift into CDP's bitmask", () => {
    expect(cdpModifiers(noMods)).toBe(0);
    expect(cdpModifiers({ ...noMods, altKey: true })).toBe(1);
    expect(cdpModifiers({ ...noMods, ctrlKey: true, shiftKey: true })).toBe(10);
    expect(cdpModifiers({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
  });
});

describe("mouseEvent", () => {
  it("translates to pane-local coordinates and CDP button names", () => {
    const e = mouseEvent(
      "mousePressed",
      { ...noMods, button: 2, clientX: 110, clientY: 220, detail: 2 },
      { left: 100, top: 200 },
    );
    expect(e).toMatchObject({ type: "mousePressed", x: 10, y: 20, button: "right", clickCount: 2 });
  });

  it("omits clickCount on moves", () => {
    const e = mouseEvent(
      "mouseMoved",
      { ...noMods, button: 0, clientX: 5, clientY: 5 },
      { left: 0, top: 0 },
    );
    expect("clickCount" in e && e.clickCount).toBeUndefined();
  });
});

describe("wheelEvent", () => {
  it("inverts DOM deltas into CDP scroll deltas", () => {
    const e = wheelEvent(
      { ...noMods, clientX: 0, clientY: 0, deltaX: 3, deltaY: 120 },
      { left: 0, top: 0 },
    );
    expect(e).toMatchObject({ type: "mouseWheel", deltaX: -3, deltaY: -120 });
  });
});

describe("keyEvents", () => {
  it("carries text for printable keys on the way down only", () => {
    const [down] = keyEvents("down", { ...noMods, key: "a", code: "KeyA" });
    expect(down).toMatchObject({ type: "keyDown", text: "a", windowsVirtualKeyCode: 65 });
    const [up] = keyEvents("up", { ...noMods, key: "a", code: "KeyA" });
    expect(up).toMatchObject({ type: "keyUp" });
    expect(up && "text" in up ? up.text : undefined).toBeUndefined();
  });

  it("maps Enter to carriage return with its vkey", () => {
    const [down] = keyEvents("down", { ...noMods, key: "Enter", code: "Enter" });
    expect(down).toMatchObject({ text: "\r", windowsVirtualKeyCode: 13 });
  });

  it("gives editing keys a vkey but no text", () => {
    const [down] = keyEvents("down", { ...noMods, key: "Backspace", code: "Backspace" });
    expect(down).toMatchObject({ windowsVirtualKeyCode: 8 });
    expect(down && "text" in down ? down.text : undefined).toBeUndefined();
  });
});

describe("normalizeUrl", () => {
  it("prepends http:// only when scheme-less", () => {
    expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeUrl("  example.com ")).toBe("http://example.com");
    expect(normalizeUrl("https://a.dev")).toBe("https://a.dev");
    expect(normalizeUrl("about:blank")).toBe("about:blank");
  });
});

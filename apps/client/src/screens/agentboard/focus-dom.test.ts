// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { blurTerminal, terminalFocused } from "./focus-dom";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(html: string) {
  document.body.innerHTML = html;
  return document.getElementById("target") as HTMLElement;
}

describe("blurTerminal", () => {
  it("releases focus held inside a terminal host", () => {
    const input = mount(`<div data-term-host><input id="target" /></div>`);
    input.focus();
    expect(document.activeElement).toBe(input);
    blurTerminal();
    expect(document.activeElement).not.toBe(input);
  });

  it("leaves focus outside a terminal alone", () => {
    const input = mount(`<div><input id="target" /></div>`);
    input.focus();
    blurTerminal();
    expect(document.activeElement).toBe(input);
  });
});

describe("terminalFocused", () => {
  it("is false when focus is elsewhere", () => {
    mount(`<input id="target" />`).focus();
    expect(terminalFocused()).toBe(false);
  });

  it("is true for a focused element inside a terminal host while the document has focus", () => {
    mount(`<div data-term-host><input id="target" /></div>`).focus();
    expect(terminalFocused()).toBe(document.hasFocus());
  });
});

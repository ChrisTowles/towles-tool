/**
 * Boot/navigation/tab primitives shared by the screen specs. Not a spec itself
 * (no `.e2e.ts` suffix, so wdio.conf's `specs` glob skips it). Read-only: it
 * navigates and inspects, never writing settings or other persisted state.
 */

/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />

export async function bootReady(): Promise<void> {
  const root = await browser.$("#root");
  await root.waitForExist({ timeout: 15000 });
  await browser.waitUntil(async () => (await root.$$("*").length) > 0, {
    timeout: 15000,
    timeoutMsg: "#root never got children",
  });
}

/** Checks text and `aria-label`, so it holds in either sidebar collapse state. */
export async function expectActiveScreen(title: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const tabs = await browser.$$('button[aria-current="true"]');
      for (const tab of tabs) {
        const text = (await tab.getText()).trim();
        const label = await tab.getAttribute("aria-label");
        if (text === title || label === title) return true;
      }
      return false;
    },
    { timeout: 10000, timeoutMsg: `no active screen titled "${title}"` },
  );
}

/**
 * Deliberately the sidebar button, not the ⌘K palette: a synthetic chord
 * silently no-ops under WebKitGTK automation when focus sits in an input or the
 * just-restored screen. palette.e2e.ts still covers the palette itself.
 */
export async function gotoScreen(title: string): Promise<void> {
  await clickNavButton(title);
  await expectActiveScreen(title);
}

async function clickNavButton(title: string): Promise<void> {
  const byLabel = await browser.$(`button[aria-label="${title}"]`);
  if (await byLabel.isExisting()) {
    await byLabel.click();
    return;
  }
  const buttons = await browser.$$("button");
  for (const button of buttons) {
    if ((await button.getText()).trim() === title) {
      await button.click();
      return;
    }
  }
  throw new Error(`no sidebar nav button titled "${title}"`);
}

/**
 * `browser.$` returns the first DOM match, which on a shared selector is often a
 * still-mounted hidden screen's copy; this passes on any displayed match.
 */
export async function waitForAnyDisplayed(selector: string, why: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      for (const el of await browser.$$(selector)) {
        if (await el.isDisplayed()) return true;
      }
      return false;
    },
    { timeout: 10000, timeoutMsg: `${why}: no displayed "${selector}"` },
  );
}

/**
 * Matches on trimmed visible text so triggers from other still-mounted screens
 * (App.tsx hides rather than unmounts) don't collide — their `getText()` is empty.
 */
export async function clickTab(label: string): Promise<void> {
  // The strip can mount after the screen does (a summary still loading).
  let target: WebdriverIO.Element | undefined;
  await browser.waitUntil(
    async () => {
      for (const trigger of await browser.$$('[role="tab"]')) {
        if ((await trigger.getText()).trim() === label) {
          target = trigger;
          return true;
        }
      }
      return false;
    },
    { timeout: 10000, timeoutMsg: `tab "${label}" never rendered` },
  );
  await target?.click();
  await browser.waitUntil(
    async () => {
      const selected = await browser.$$('[role="tab"][aria-selected="true"]');
      for (const trigger of selected) {
        if ((await trigger.getText()).trim() === label) return true;
      }
      return false;
    },
    { timeout: 10000, timeoutMsg: `tab "${label}" never became selected` },
  );
}

/** Kumo's `Tabs` renders only the strip, so each screen labels its own
 * `tabpanel` with the active tab's name. */
export async function expectTabPanelShown(label: string): Promise<void> {
  const panel = await browser.$(`[role="tabpanel"][aria-label="${label}"]`);
  await panel.waitForDisplayed({
    timeout: 10000,
    timeoutMsg: `no displayed panel for selected tab "${label}"`,
  });
}

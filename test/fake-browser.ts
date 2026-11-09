/**
 * A fake of the extension's browser for the dry run's tests: a page whose
 * elements are a table of selectors, which records every call made to it.
 */

import type { Browser, LaunchBrowser, OpenOptions, Page, Probe } from "../src/browser";

export type FakeElement = {
  visible?: boolean;
  /** Off screen until revealed (`scrollIntoView`). */
  offscreen?: boolean;
  /** Another element sits over its centre. */
  covered?: boolean;
  /** Shows only after this many `wait` calls. */
  appearsAfterWaits?: number;
  /** Shows once this selector has been clicked. */
  appearsAfterClick?: string;
  x?: number;
  y?: number;
};

export type FakePage = Page & {
  calls: string[];
  opened: { url: string; options: OpenOptions }[];
  shots: number;
};

/** A tiny valid PNG's first bytes: enough for the tests to see a PNG was written. */
export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function fakePage(
  elements: Record<string, FakeElement>,
  options: { failOpen?: string } = {},
): FakePage {
  const calls: string[] = [];
  const opened: { url: string; options: OpenOptions }[] = [];
  const revealed = new Set<string>();
  const clicked = new Set<string>();
  let waits = 0;
  const shows = (el: FakeElement) =>
    (el.appearsAfterWaits === undefined || waits >= el.appearsAfterWaits) &&
    (el.appearsAfterClick === undefined || clicked.has(el.appearsAfterClick));
  const at = (selector: string) => {
    const el = elements[selector];
    return el !== undefined && shows(el) ? el : null;
  };
  const page: FakePage = {
    calls,
    opened,
    shots: 0,
    async open(url, openOptions) {
      calls.push(`open ${url}`);
      opened.push({ url, options: openOptions });
      if (options.failOpen !== undefined) throw new Error(options.failOpen);
    },
    async probe(selector): Promise<Probe> {
      const el = at(selector);
      if (el === null) return { found: false };
      const visible = (el.visible ?? true) && (!el.offscreen || revealed.has(selector));
      return { found: true, visible, x: el.x ?? 100, y: el.y ?? 50, width: 40, height: 20 };
    },
    async reveal(selector) {
      calls.push(`reveal ${selector}`);
      revealed.add(selector);
    },
    async hits(selector) {
      return !(at(selector)?.covered ?? false);
    },
    async mouse(kind, x, y) {
      calls.push(`${kind} ${x},${y}`);
      if (kind !== "click") return;
      for (const [selector, el] of Object.entries(elements)) {
        const probe = await page.probe(selector);
        if (probe.found && probe.x === x && probe.y === y && !el.covered) clicked.add(selector);
      }
    },
    async focus(selector) {
      calls.push(`focus ${selector}`);
    },
    async insertText(text) {
      calls.push(`text ${text}`);
    },
    async wait() {
      waits += 1;
    },
    async screenshot() {
      page.shots += 1;
      calls.push("screenshot");
      return PNG;
    },
    errors: () => [],
  };
  return page;
}

/** A launcher that hands out `page` and counts how many browsers ran at once. */
export function fakeLauncher(page: Page): LaunchBrowser & { launched: number; closed: number; most: number } {
  let open = 0;
  const launcher = Object.assign(
    async (): Promise<Browser> => {
      launcher.launched += 1;
      open += 1;
      launcher.most = Math.max(launcher.most, open);
      return {
        page,
        close: async () => {
          open -= 1;
          launcher.closed += 1;
        },
      };
    },
    { launched: 0, closed: 0, most: 0 },
  );
  return launcher;
}

/**
 * A Vite build's page made into one file: each `<script src="./assets/…">`
 * and `<link rel="stylesheet" href="./assets/…">` replaced by the file's text
 * inline, the way ODI's `scripts/compose_mockup_artifact.py` does it. A page
 * that keeps a reference to a file it needs is refused: the browser opens it
 * as `file://`, where a module script from another file does not load.
 */

const SCRIPT = /<script\b([^>]*)\bsrc="([^"]+)"([^>]*)><\/script>/g;
const STYLESHEET = /<link\b[^>]*\brel="stylesheet"[^>]*>/g;
const PRELOAD = /<link\b[^>]*\brel="modulepreload"[^>]*>\s*/g;
const HREF = /\bhref="([^"]+)"/;

/** JS made safe inside a `<script>`: no early end, no comment opener, no literal U+FFFD. */
export function escapeScript(code: string): string {
  return code
    .replaceAll("</script", "<\\/script")
    .replaceAll("<!--", "<\\!--")
    .replaceAll("�", "\\uFFFD");
}

/** `./assets/x.js` relative to the page's folder; an absolute URL or a data: URL is no local file. */
function local(ref: string): string | null {
  if (/^(?:[a-z]+:|\/\/)/i.test(ref)) return null;
  return ref.replace(/^\.\//, "").replace(/^\//, "");
}

export async function composeSingleFile(
  html: string,
  read: (relative: string) => Promise<string>,
): Promise<string> {
  const scripts = [...html.matchAll(SCRIPT)];
  const styles = [...html.matchAll(STYLESHEET)];
  let out = html.replace(PRELOAD, "");
  for (const match of scripts) {
    const [whole, before = "", ref = "", after = ""] = match;
    const file = local(ref);
    if (file === null) continue;
    const attrs = `${before}${after}`.replace(/\s*\bcrossorigin\b(="[^"]*")?/g, "").trimEnd();
    const code = escapeScript(await read(file));
    out = out.replace(whole, () => `<script${attrs}>${code}</script>`);
  }
  for (const match of styles) {
    const [whole] = match;
    const ref = HREF.exec(whole)?.[1];
    const file = ref === undefined ? null : local(ref);
    if (file === null) continue;
    const css = (await read(file)).replaceAll("</style", "<\\/style");
    out = out.replace(whole, () => `<style>${css}</style>`);
  }
  // Looked for in the page less what was inlined, never in the inlined code.
  const rest = html.replace(SCRIPT, "").replace(STYLESHEET, "").replace(PRELOAD, "");
  const left = /\b(?:src|href)="\.?\/?assets\/[^"]+"/.exec(rest);
  if (left !== null) throw new Error(`The built page still loads a file of its own: ${left[0]}`);
  return out;
}

// Small helpers shared by the tabs: building nodes, calling the extension, and
// the one error line and one notice line at the top of the page.

export const $ = (id) => document.getElementById(id);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "disabled" || key === "hidden") node[key] = Boolean(value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}

export function setError(message) {
  $("error").hidden = message === null;
  $("error").textContent = message === null ? "" : message;
}

export function setNotice(message) {
  $("notice").hidden = message === null;
  $("notice").textContent = message === null ? "" : message;
}

/** Asks the extension; a failure is shown inline and rethrown to the caller. */
export async function call(path, body) {
  try {
    const response = await fetch(`api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error ?? `The extension answered ${response.status}`);
    setError(null);
    return data;
  } catch (caught) {
    setError(String(caught.message ?? caught));
    throw caught;
  }
}

export function words(text) {
  return String(text ?? "").trim().split(/\s+/).filter((word) => word !== "").length;
}

/** The window's tokens: the colours and fonts of the prifly window. */
const LOOK = {
  "--background": "--bg",
  "--foreground": "--fg",
  "--card": "--card",
  "--muted": "--muted",
  "--muted-foreground": "--muted-fg",
  "--border": "--border",
  "--font-sans": "--font",
  "--font-mono": "--mono",
};

export function listenForLook() {
  addEventListener("message", (event) => {
    if (event.data?.type !== "prifly-look") return;
    document.documentElement.classList.toggle("dark", event.data.dark === true);
    for (const [theirs, ours] of Object.entries(LOOK)) {
      const value = event.data.tokens?.[theirs];
      if (typeof value === "string" && value !== "") {
        document.documentElement.style.setProperty(ours, value);
      }
    }
  });
}

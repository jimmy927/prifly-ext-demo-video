// Tab 1: the brief form. Saved as a whole; Save brief only enables while
// something changed.

import { S, setData } from "./state.js";
import { call, el } from "./ui.js";

const TEXT_FIELDS = [
  ["title", "Title", "text"],
  ["audience", "Audience", "text"],
  ["pain", "Pain or goal the video opens on", "area"],
  ["aha", "Aha moment", "area"],
  ["callToAction", "Call to action (one)", "text"],
  ["releaseNote", "Release-note folder (optional)", "text"],
];

function textControl(brief, key, kind, markDirty) {
  const control = kind === "area" ? el("textarea", { rows: "2" }) : el("input", { type: "text" });
  control.value = brief[key] ?? "";
  control.name = key;
  control.addEventListener("input", markDirty);
  return control;
}

function readForm(form) {
  const brief = { product: form.elements.product.value };
  for (const [key] of TEXT_FIELDS) {
    const value = form.elements[key].value.trim();
    if (value !== "" || key !== "releaseNote") brief[key] = value;
  }
  brief.languages = ["sv", "en"].filter((code) => form.elements[`lang-${code}`].checked);
  brief.targetSeconds = Number(form.elements.targetSeconds.value);
  return brief;
}

function validity(brief) {
  if (brief.title === "") return "A title is needed.";
  if (brief.languages.length === 0) return "Pick at least one language.";
  if (
    !Number.isInteger(brief.targetSeconds) ||
    brief.targetSeconds < 10 ||
    brief.targetSeconds > 600
  ) {
    return "The target length is 10 to 600 seconds.";
  }
  return null;
}

export function briefTab(onSaved) {
  const brief = S.data.brief;
  const save = el(
    "button",
    { type: "button", class: "primary", disabled: !S.briefDirty },
    "Save brief",
  );
  const problem = el("span", { class: "hint" }, "");
  const form = el("form", { class: "form" });
  const markDirty = () => {
    S.briefDirty = true;
    const found = validity(readForm(form));
    save.disabled = found !== null || S.busy;
    problem.textContent = found ?? "";
  };
  for (const [key, label, kind] of TEXT_FIELDS) {
    form.append(el("label", {}, label, textControl(brief, key, kind, markDirty)));
  }
  const product = el(
    "select",
    { name: "product" },
    el("option", { value: "odi" }, "Artemis (ODI)"),
    el("option", { value: "prifly" }, "prifly"),
  );
  product.value = brief.product;
  product.addEventListener("change", markDirty);
  const seconds = el("input", { type: "number", name: "targetSeconds", min: "10", max: "600" });
  seconds.value = String(brief.targetSeconds);
  seconds.addEventListener("input", markDirty);
  const langs = ["sv", "en"].map((code) => {
    const box = el("input", { type: "checkbox", name: `lang-${code}` });
    box.checked = brief.languages.includes(code);
    box.addEventListener("change", markDirty);
    return el("label", { class: "row" }, box, code === "sv" ? "Swedish" : "English");
  });
  form.append(
    el("label", {}, "Product", product),
    el("div", { class: "row" }, ...langs),
    el("label", {}, "Target length (seconds)", seconds),
    el("div", { class: "row" }, save, problem),
  );
  form.addEventListener("submit", (event) => event.preventDefault());
  save.addEventListener("click", async () => {
    S.busy = true;
    save.disabled = true;
    try {
      setData(await call("brief", { id: S.id, brief: readForm(form) }));
      S.briefDirty = false;
      await onSaved();
    } catch {
      save.disabled = false;
    } finally {
      S.busy = false;
    }
  });
  return form;
}

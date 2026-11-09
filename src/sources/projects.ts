/**
 * Each product's own mockup harness, as `mcp__prifly__mockup_recipe` names
 * it, and what a build of it needs: the targets it has, the files written
 * into the throwaway worktree, the build command and where its page lands.
 *
 * One page per project and commit holds every target: `?target=<name>`
 * picks one, and a scene's `state` is the page's `location.hash`.
 *
 * - ODI (`frontend/mockup/`, `docs/guides/ui-mockup-artifacts.md`):
 *   `harness.tsx`'s `mountMockup` with the targets in
 *   `frontend/mockup/targets/` (every `artemis-demo-*.tsx`, and any other a
 *   scene names), built by the repo's own `vite.mockup.config.ts` into
 *   `dist-mockup/`. The worktree's `mockup-main.tsx`, which points at one
 *   target, is replaced by one that picks from all of them, keeping the
 *   original's MUI licence line.
 * - prifly (`apps/desktop-web/src/fixtures/preview.tsx`): `PreviewApp`, the
 *   real window fed fixtures, mounted as `preview-main.tsx` mounts it.
 *   Targets: `window` (the whole window) and `transcript` (`only:
 *   "transcript"`). The hash is `PreviewState` as a query string
 *   (`#watched=ended&draft=Why%20slow`); `true` and `false` are booleans.
 */

import type { Product } from "../scenes";

export type ProjectSpec = {
  id: Product;
  /** The checkout's default place, in its own world. */
  defaultCheckout: string;
  /** Folders of the reader's checkout linked into the worktree, where they exist. */
  links: readonly string[];
  /** Target names from `git ls-tree --name-only -r <commit> <targetsDir>`'s lines, or fixed ones. */
  targetsDir: string | null;
  fixedTargets: readonly string[];
  /** The targets every page of this project holds, besides those scenes name. */
  defaultTarget: (name: string) => boolean;
  /** The files written into the worktree, by path relative to its top. */
  files(targets: readonly string[], read: (relative: string) => Promise<string>): Promise<Record<string, string>>;
  /** The build: folder relative to the worktree, and the arguments after the runtime (`bun`). */
  build: { cwd: string; args: readonly string[] };
  /** The built page, relative to the worktree. */
  page: string;
  /** When the page has drawn: `ready` shows and `busy` is gone. */
  ready: { ready: string; busy?: string };
  /** Hidden in the stills: the harness's own controls. */
  hide: readonly string[];
};

const ident = (index: number) => `t${index}`;

function odiEntry(targets: readonly string[], licence: string): string {
  const imports = targets.map(
    (name, index) => `import { target as ${ident(index)} } from "./targets/${name}";`,
  );
  const table = targets.map((name, index) => `\t${JSON.stringify(name)}: ${ident(index)},`);
  return [
    "// Written by Demo studio into a throwaway worktree: every target, picked by ?target=.",
    'import { LicenseInfo } from "@mui/x-license";',
    'import { mountMockup, type MockupTarget } from "./harness";',
    ...imports,
    "",
    licence,
    "",
    "const targets: Record<string, MockupTarget> = {",
    ...table,
    "};",
    'const name = new URLSearchParams(location.search).get("target") ?? "";',
    "const chosen = targets[name];",
    "if (chosen === undefined) {",
    '\tdocument.body.textContent = `No mockup target ${name}`;',
    "\tthrow new Error(`No mockup target ${name}`);",
    "}",
    "mountMockup(chosen);",
    "",
  ].join("\n");
}

const LICENCE = /LicenseInfo\.setLicenseKey\(\s*"[^"]*"\s*\);/;

const odi: ProjectSpec = {
  id: "odi",
  defaultCheckout: "~/src/odi",
  links: ["node_modules"],
  targetsDir: "frontend/mockup/targets",
  fixedTargets: [],
  defaultTarget: (name) => name.startsWith("artemis-demo-"),
  async files(targets, read) {
    const original = await read("frontend/mockup/mockup-main.tsx");
    const licence = LICENCE.exec(original)?.[0] ?? "// No MUI licence line in mockup-main.tsx.";
    return { "frontend/mockup/mockup-main.tsx": odiEntry(targets, licence) };
  },
  build: {
    cwd: ".",
    args: ["node_modules/vite/bin/vite.js", "build", "--config", "vite.mockup.config.ts", "--logLevel", "warn"],
  },
  page: "dist-mockup/mockup.html",
  ready: { ready: "#root > *", busy: '#root [role="progressbar"]' },
  hide: ['[data-component="mockup-theme-toggle"]'],
};

const PRIFLY_ENTRY = `// Written by Demo studio into a throwaway worktree: PreviewApp as preview-main.tsx mounts it.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { TooltipProvider } from "../components/ui/tooltip";
import { keepPageStill } from "../net/page-scroll";
import { WindowMenu } from "../panels/window-menu";
import { PreviewApp } from "./preview";

keepPageStill();

const props: Record<string, unknown> = {};
for (const [key, value] of new URLSearchParams(location.hash.slice(1))) {
  props[key] = value === "true" ? true : value === "false" ? false : value;
}
if (new URLSearchParams(location.search).get("target") === "transcript") props["only"] = "transcript";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <TooltipProvider delayDuration={300}>
      <WindowMenu>
        {/* biome-ignore lint/suspicious/noExplicitAny: props come from the hash */}
        <PreviewApp {...(props as any)} />
      </WindowMenu>
    </TooltipProvider>
  </StrictMode>,
);
`;

const PRIFLY_CONFIG = `// Written by Demo studio into a throwaway worktree: one self-contained page.
import { fileURLToPath } from "node:url";
import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

process.env["NODE_ENV"] = "production";

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  base: "./",
  publicDir: false,
  logLevel: "warn",
  build: {
    outDir: "dist-demo-studio",
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    reportCompressedSize: false,
    sourcemap: false,
    rollupOptions: {
      input: fileURLToPath(new URL("./demo-studio.html", import.meta.url)),
      output: { inlineDynamicImports: true },
    },
  },
});
`;

const prifly: ProjectSpec = {
  id: "prifly",
  defaultCheckout: "~/src/prifly",
  links: ["node_modules", "apps/desktop-web/node_modules"],
  targetsDir: null,
  fixedTargets: ["window", "transcript"],
  defaultTarget: () => true,
  async files(_targets, read) {
    const preview = await read("apps/desktop-web/preview.html");
    const html = preview
      .replace(/\s*<link rel="icon"[^>]*>/, "")
      .replace(/src="\/src\/fixtures\/preview-main\.tsx"/, 'src="./src/fixtures/demo-studio-entry.tsx"');
    return {
      "apps/desktop-web/demo-studio.html": html,
      "apps/desktop-web/src/fixtures/demo-studio-entry.tsx": PRIFLY_ENTRY,
      "apps/desktop-web/vite.demo-studio.config.ts": PRIFLY_CONFIG,
    };
  },
  build: {
    cwd: "apps/desktop-web",
    args: ["../../node_modules/vite/bin/vite.js", "build", "--config", "vite.demo-studio.config.ts"],
  },
  page: "apps/desktop-web/dist-demo-studio/demo-studio.html",
  ready: { ready: "#root > *" },
  hide: [],
};

export const PROJECTS: Readonly<Record<Product, ProjectSpec>> = { odi, prifly };

/** The target names a `git ls-tree` listing of the targets folder holds: its `.tsx` files. */
export function targetsIn(listing: string): string[] {
  return listing
    .split("\n")
    .map((line) => line.trim().split("/").pop() ?? "")
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => name.slice(0, -".tsx".length))
    .sort();
}

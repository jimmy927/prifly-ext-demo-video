/** A running Demo studio over the fake api and a throwaway videos folder. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PanelRequest } from "@prifly/extension-api";
import * as extension from "../index";
import { fakeApi } from "./fake-api";

export function studio(options: { features?: string[]; noState?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "demo-videos-"));
  process.env["PRIFLY_DEMO_VIDEOS_DIR"] = dir;
  const fake = fakeApi({ settings: { elevenLabsKey: false, voiceSv: "sv-SE-SofieNeural", voiceEn: "en-GB-SoniaNeural" } });
  if (options.features !== undefined) {
    Object.assign(fake.api, { features: options.features });
  }
  if (options.noState === true) Object.assign(fake.api, { state: undefined });
  extension.activate(fake.api);
  // biome-ignore lint/suspicious/noExplicitAny: tests read loose JSON
  type Json = any;
  const ask = (path: string, body: unknown = null, query: Record<string, string> = {}) => {
    const request: PanelRequest = { path, query, body };
    return extension.panel("studio", request) as Promise<Json>;
  };
  return { fake, dir, ask };
}

export const SCENE = {
  id: "pain",
  title: "The pain",
  narration: { en: "Hiring takes weeks." },
  onScreen: "Hiring takes weeks",
  source: { kind: "harness", project: "odi", target: "artemis-demo-hero-pipeline" },
};

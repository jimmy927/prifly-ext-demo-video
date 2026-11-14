/**
 * What the session view's `fetch("api/…")` calls ask: the module's `panel()`
 * export hands each one to `answerPanel` (the view "timeline" is the only
 * page there is; the extension has no panel of its own any more). A throw
 * becomes the host's 500 `{ error }`, which the page shows inline.
 */

import type { PanelRequest } from "@prifly/extension-api";
import type { RenderService } from "./render-service";
import { TIMELINE_VIEW } from "./session-views";
import type { Store } from "./store";
import { timelineState, type ViewRequest } from "./timeline-state";

export type PanelContext = {
  store: () => Store;
  render: () => RenderService;
  /** Whether the host serves the videos folder as the session view's media (feature "panel-media", and `api.panelMedia` took it). */
  media: () => boolean;
};

export async function answerPanel(
  context: PanelContext,
  request: PanelRequest,
  viewId: string,
): Promise<unknown> {
  if (viewId !== TIMELINE_VIEW) throw new Error(`No such view: ${viewId}`);
  const view: ViewRequest = request;
  if (view.path === "state") return await timelineState(context, view);
  throw new Error(`No such request: ${view.path}`);
}

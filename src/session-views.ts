/**
 * The Demo studio viewer in a session's App tab, beside the chat. prifly's
 * `api.showSessionView` (feature "session-views", on prifly's prifly-623
 * branch) is typed here because no released @prifly/extension-api tag
 * (v0.8.0 is the newest) has it yet. A prifly without it still gets the
 * tools' work done, with one line saying how to see the timeline.
 */

import type { ExtensionApi } from "@prifly/extension-api";

/** The manifest's session view: its id is not the studio panel's. */
export const TIMELINE_VIEW = "timeline";

type SessionViewApi = {
  showSessionView?: (sessionId: string, viewId: string, params: Record<string, string>) => void;
};

export const UPDATE_PRIFLY = "Update prifly to see the timeline beside the chat.";

export type SessionViews = {
  /** demo_open: shows the video's viewer in the session (again, with the new video); the sentence for the answer. */
  open(session: string, video: string): string;
  /** The tools that change a video: open the viewer when this session has none yet; "" once it has, else the sentence for the answer. */
  ensure(session: string, video: string): string;
};

export function sessionViews(api: () => ExtensionApi | null): SessionViews {
  /** Sessions that were shown the viewer, or told why not, since the module started. */
  const handled = new Set<string>();
  const show = (session: string, video: string): string => {
    handled.add(session);
    const shower = (api() as (ExtensionApi & SessionViewApi) | null)?.showSessionView;
    if (typeof shower !== "function") return UPDATE_PRIFLY;
    try {
      shower.call(api(), session, TIMELINE_VIEW, { video });
    } catch (caught) {
      return `The timeline could not be opened beside the chat: ${caught instanceof Error ? caught.message : String(caught)}`;
    }
    return `The timeline of ${video} is open beside the chat.`;
  };
  return {
    open: show,
    ensure: (session, video) => (handled.has(session) ? "" : show(session, video)),
  };
}

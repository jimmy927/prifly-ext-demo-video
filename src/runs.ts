/**
 * One background job at a time (a dry run, a render): `start` answers at
 * once, either that the job started or which video's job is already going.
 * The panel polls `status`. A job that throws keeps its error, by video,
 * until that video's next start.
 */

export type Progress = { done: number; total: number; line: string };

export type RunStatus =
  | { state: "idle"; video: string | null }
  | { state: "running"; video: string; progress: Progress; startedAt: number };

export class BackgroundRuns<R> {
  private current: {
    video: string;
    progress: Progress;
    startedAt: number;
    done: Promise<R | null>;
  } | null = null;
  private lastError = new Map<string, string>();

  status(): RunStatus {
    const current = this.current;
    if (current === null) return { state: "idle", video: null };
    return {
      state: "running",
      video: current.video,
      progress: current.progress,
      startedAt: current.startedAt,
    };
  }

  /** Why the last run of `video` failed outright (the run itself, not a scene in it); null when it did not. */
  errorOf(video: string): string | null {
    return this.lastError.get(video) ?? null;
  }

  start(
    video: string,
    run: (onProgress: (progress: Progress) => void) => Promise<R>,
  ): { started: true; done: Promise<R | null> } | { started: false; running: string } {
    if (this.current !== null) return { started: false, running: this.current.video };
    this.lastError.delete(video);
    const progress: Progress = { done: 0, total: 0, line: "Starting…" };
    const entry: NonNullable<typeof this.current> = {
      video,
      progress,
      startedAt: Date.now(),
      done: new Promise<R | null>(() => {}),
    };
    this.current = entry;
    entry.done = run((next) => {
      entry.progress = next;
    })
      .then((value): R | null => value)
      .catch((caught: unknown) => {
        this.lastError.set(video, caught instanceof Error ? caught.message : String(caught));
        return null;
      })
      .finally(() => {
        if (this.current === entry) this.current = null;
      });
    return { started: true, done: entry.done };
  }
}

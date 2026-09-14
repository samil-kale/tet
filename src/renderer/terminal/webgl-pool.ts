/**
 * Which terminals may hold a WebGL context, kept apart from xterm and the DOM so the rules run in
 * node (test/webgl-pool.test.ts). The contexts themselves live in terminal-views.ts; keys here are
 * its view keys.
 *
 * A terminal in front of the user always gets one. A hidden one keeps its context only while it is
 * among the most recently hidden — each context costs GPU memory, and a switch back to a warm one
 * never shows a DOM frame or rebuilds its renderer.
 */

/** How many hidden terminals keep their context: two projects split 2×2 stay warm. */
export const MAX_HIDDEN_WEBGL = 8;

/**
 * A terminal whose context was lost this often inside the window stays on the DOM renderer until
 * the window has passed: a context that keeps dying is a driver problem, not a transient one.
 */
export const WEBGL_LOSS_LIMIT = 3;
export const WEBGL_LOSS_WINDOW_MS = 60_000;

/** A WebGL renderer name that is software rasterizing, where WebGL is slower than the DOM. */
const SOFTWARE_RENDERER = /\b(swiftshader|llvmpipe|softpipe|software rasterizer|software adapter|basic render|virgl|svga3d)\b/i;

export function isSoftwareRenderer(identity: string): boolean {
  return SOFTWARE_RENDERER.test(identity);
}

export class WebglPool {
  /** Hidden terminals holding a context, the one hidden longest first. */
  private readonly hidden: string[] = [];
  private readonly losses = new Map<string, number[]>();

  /** The terminal came in front of the user: it no longer counts against the hidden budget. */
  show(key: string): void {
    this.remove(key);
  }

  /** A hidden terminal lost its context on its own; its place goes to the next one hidden. */
  lost(key: string): void {
    this.remove(key);
  }

  /** The terminal went out of sight, holding a context. Nothing is released until `trim`. */
  hide(key: string): void {
    this.remove(key);
    this.hidden.push(key);
  }

  /**
   * The keys whose contexts are to be released to get back under the budget, the ones hidden
   * longest. Apart from `hide`, because the terminals leaving the screen are hidden before the ones
   * coming onto it are shown: a project switch hides one project's panes, then shows the other's,
   * which may be among the hidden. Trimmed at hide time, those would be released only to be built
   * again a moment later.
   */
  trim(): string[] {
    return this.hidden.splice(0, Math.max(0, this.hidden.length - MAX_HIDDEN_WEBGL));
  }

  /** A closed terminal. */
  forget(key: string): void {
    this.forgetWhere((candidate) => candidate === key);
  }

  /** Every terminal of a closed project: the keys starting with its view-key prefix. */
  forgetPrefix(prefix: string): void {
    this.forgetWhere((candidate) => candidate.startsWith(prefix));
  }

  private forgetWhere(matches: (key: string) => boolean): void {
    for (let i = this.hidden.length - 1; i >= 0; i--) {
      if (matches(this.hidden[i])) {
        this.hidden.splice(i, 1);
      }
    }
    for (const key of [...this.losses.keys()]) {
      if (matches(key)) {
        this.losses.delete(key);
      }
    }
  }

  recordLoss(key: string, now: number): void {
    this.losses.set(key, [...this.recentLosses(key, now), now]);
  }

  mayRetry(key: string, now: number): boolean {
    return this.recentLosses(key, now).length < WEBGL_LOSS_LIMIT;
  }

  private recentLosses(key: string, now: number): number[] {
    return (this.losses.get(key) ?? []).filter((at) => now - at < WEBGL_LOSS_WINDOW_MS);
  }

  private remove(key: string): void {
    const index = this.hidden.indexOf(key);
    if (index !== -1) {
      this.hidden.splice(index, 1);
    }
  }
}

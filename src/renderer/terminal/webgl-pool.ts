/**
 * Which terminals may hold a WebGL context, apart from xterm and the DOM so the rules run in node
 * (test/webgl-pool.test.ts). Contexts live in terminal-views.ts; keys are its view keys.
 *
 * A terminal in front of the user always gets one; a hidden one only while among the most recently
 * hidden — each costs GPU memory, and switching back to a warm one shows no DOM frame.
 */

/** How many hidden terminals keep their context: two projects split 2×2 stay warm. */
export const MAX_HIDDEN_WEBGL = 8;

/**
 * A terminal losing its context this often within the window stays on the DOM until it passes: a
 * context that keeps dying is a driver problem.
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

  /** In front of the user: no longer counts against the hidden budget. */
  show(key: string): void {
    this.remove(key);
  }

  /** A hidden terminal lost its context on its own. */
  lost(key: string): void {
    this.remove(key);
  }

  /** Out of sight, holding a context. Nothing is released until `trim`. */
  hide(key: string): void {
    this.remove(key);
    this.hidden.push(key);
  }

  /**
   * The keys to release to get back under the budget, hidden longest first. Apart from `hide`: a
   * project switch hides one project's panes before showing the other's, which may be among the
   * hidden — trimmed at hide time, they would be released only to be rebuilt.
   */
  trim(): string[] {
    return this.hidden.splice(0, Math.max(0, this.hidden.length - MAX_HIDDEN_WEBGL));
  }

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

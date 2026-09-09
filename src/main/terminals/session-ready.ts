/**
 * Generic "has enough output arrived to call the CLI ready" check, parameterized by an
 * agent-tuned byte count — see each agent's createIsSessionReady for what it is and why. This
 * file owns the counting mechanism, not the tuning.
 */
export function createByteThresholdCheck(outputThreshold: number): (chunk: string) => boolean {
  let output = 0;
  return (chunk) => {
    output += chunk.length;
    return output > outputThreshold;
  };
}

/**
 * A raw byte count only works where the bytes before the real frame are roughly fixed — not
 * true for opencode: while it fetches its provider/model list it repaints the *entire* blank
 * screen (cursor home, a full white-on-default fill, no content) over and over, an unpredictable
 * number of times over an unpredictable wait (measured, 1.18.4: 960 ms to 4.2 s across three
 * runs, one to three blank repaints of ~4.8 KB each before anything real). A byte threshold
 * tuned to clear that noise either fires mid-fill on a fast run or never on a slow one.
 *
 * What is fixed, measured the same three times: the frame that actually has something on it —
 * opencode's logo and its "Ask anything" prompt — arrives as one chunk carrying exactly 164
 * bytes of UTF-8 continuation content (box-drawing characters, code point ≥ U+0080) each time,
 * and no chunk before it carries any. Counting those instead of every byte skips the noise
 * entirely and fires exactly when the screen has something on it, however long the wait was.
 */
export function createNonAsciiThresholdCheck(outputThreshold: number): (chunk: string) => boolean {
  let count = 0;
  return (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      if (chunk.charCodeAt(i) > 0x7f) {
        count++;
      }
    }
    return count > outputThreshold;
  };
}

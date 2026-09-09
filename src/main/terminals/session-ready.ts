/**
 * Generic "has enough output arrived to call the CLI ready" check, parameterized by an
 * agent-tuned byte count. The tuning lives in each agent's createIsSessionReady.
 */
export function createByteThresholdCheck(outputThreshold: number): (chunk: string) => boolean {
  let output = 0;
  return (chunk) => {
    output += chunk.length;
    return output > outputThreshold;
  };
}

/**
 * Counts non-ASCII characters instead of bytes, for opencode, whose byte count before the first
 * real frame is not fixed: measured, 1.18.4, it repaints the entire blank screen one to three
 * times (~4.8 KB each) over 960 ms to 4.2 s while fetching its provider/model list. Fixed across
 * the same three runs: the first frame with content (logo, "Ask anything") carries exactly 164
 * bytes of UTF-8 continuation content (code point ≥ U+0080), and no chunk before it carries any.
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

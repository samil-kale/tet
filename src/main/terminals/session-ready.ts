/** "Enough output to call the CLI ready", by an agent-tuned count (each createIsSessionReady). */
export function createByteThresholdCheck(outputThreshold: number): (chunk: string) => boolean {
  let output = 0;
  return (chunk) => {
    output += chunk.length;
    return output > outputThreshold;
  };
}

/**
 * Counts non-ASCII characters, for opencode, whose bytes before the first frame vary: measured at
 * 1.18.4, it repaints the blank screen one to three times (~4.8 KB each) while fetching its model
 * list. The first frame with content carried exactly 164 code points ≥ U+0080 in every run, and no
 * chunk before it any.
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

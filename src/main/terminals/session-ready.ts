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

/** "Enough output to call the CLI ready", by an agent-tuned count (each createIsSessionReady). */
export function createByteThresholdCheck(outputThreshold: number): (chunk: string) => boolean {
  let output = 0;
  return (chunk) => {
    output += chunk.length;
    return output > outputThreshold;
  };
}

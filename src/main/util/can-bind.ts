import * as net from "node:net";

/** Whether a loopback port is free, by binding it: the control channel's port (findControlPort) and
 *  an SBX port to forward (sbx.ts's readSbxProblems). */
export function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type { InvokeChannels, SendChannels } from "../../shared/ipc";

/** `ipcMain.handle` held to `InvokeChannels`: the window's arguments, its answer or a promise of it. */
export function handle<C extends keyof InvokeChannels>(
  channel: C,
  listener: (
    event: IpcMainInvokeEvent,
    ...args: Parameters<InvokeChannels[C]>
  ) => Awaited<ReturnType<InvokeChannels[C]>> | ReturnType<InvokeChannels[C]>
): void {
  ipcMain.handle(channel, listener as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
}

/** `ipcMain.on` held to `SendChannels`. */
export function on<C extends keyof SendChannels>(
  channel: C,
  listener: (event: IpcMainEvent, ...args: Parameters<SendChannels[C]>) => void
): void {
  ipcMain.on(channel, listener as (event: IpcMainEvent, ...args: unknown[]) => void);
}

/** `ipcMain.once` held to `SendChannels`; the listener is registered as given, for `removeListener`. */
export function once<C extends keyof SendChannels>(
  channel: C,
  listener: (event: IpcMainEvent, ...args: Parameters<SendChannels[C]>) => void
): void {
  ipcMain.once(channel, listener as (event: IpcMainEvent, ...args: unknown[]) => void);
}

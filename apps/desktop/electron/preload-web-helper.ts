import type {
  ChildProcess
} from "node:child_process";

type IpcMessage =
  | {
      type: "send";
      channel: string;
      args: unknown[];
    }
  | {
      type: "postMessage";
      channel: string;
      message: unknown;
      transfer?: unknown[];
    }
  | {
      type: "invoke";
      id: number;
      channel: string;
      args: unknown[];
    }
  | {
      type: "response";
      id: number;
      result?: unknown;
      error?: {
        message: string;
        name?: string;
        stack?: string;
      };
    }
  | {
      type: "event";
      channel: string;
      args: unknown[];
    };
    
// Renderer

type Listener = (...args: unknown[]) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class MyIpcRenderer {
  private nextRequestId = 1;

  private readonly pending = new Map<
    number,
    PendingRequest
  >();

  private readonly listeners = new Map<
    string,
    Set<Listener>
  >();

  constructor() {
    process.on("message", (message: IpcMessage) => {
      this.handleMessage(message);
    });
  }

  /**
   * Electron-like:
   *
   * ipcRenderer.send(channel, ...args)
   */
  send(
    channel: string,
    ...args: unknown[]
  ): void {
    this.sendMessage({
      type: "send",
      channel,
      args,
    });
  }

  /**
   * Electron-like:
   *
   * ipcRenderer.invoke(channel, ...args)
   */
  invoke<T = unknown>(
    channel: string,
    ...args: unknown[]
  ): Promise<T> {
    const id = this.nextRequestId++;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (
          value: unknown
        ) => void,
        reject,
      });

      this.sendMessage({
        type: "invoke",
        id,
        channel,
        args,
      });
    });
  }

  /**
   * Electron-like:
   *
   * ipcRenderer.postMessage(channel, message)
   */
  postMessage(
    channel: string,
    message: unknown,
    transfer?: unknown[]
  ): void {
    this.sendMessage({
      type: "postMessage",
      channel,
      message,
      transfer,
    });
  }

  /**
   * Electron-like:
   *
   * ipcRenderer.on(channel, listener)
   */
  on(
    channel: string,
    listener: Listener
  ): void {
    let listeners = this.listeners.get(channel);

    if (!listeners) {
      listeners = new Set();
      this.listeners.set(channel, listeners);
    }

    listeners.add(listener);
  }

  /**
   * Electron-like:
   *
   * ipcRenderer.once(channel, listener)
   */
  once(
    channel: string,
    listener: Listener
  ): void {
    const wrapper: Listener = (...args) => {
      this.removeListener(channel, wrapper);
      listener(...args);
    };

    this.on(channel, wrapper);
  }

  /**
   * Electron-like:
   *
   * ipcRenderer.removeListener(channel, listener)
   */
  removeListener(
    channel: string,
    listener: Listener
  ): void {
    const listeners = this.listeners.get(channel);

    if (!listeners) {
      return;
    }

    listeners.delete(listener);

    if (listeners.size === 0) {
      this.listeners.delete(channel);
    }
  }

  private sendMessage(
    message: IpcMessage
  ): void {
    if (!process.send) {
      throw new Error(
        "MyIpcRenderer is not connected to a parent process"
      );
    }

    process.send(message);
  }

  private handleMessage(
    message: IpcMessage
  ): void {
    if (message.type === "response") {
      this.handleResponse(message);
      return;
    }

    if (message.type === "event") {
      this.emit(
        message.channel,
        ...message.args
      );
    }
  }

  private handleResponse(
    message: Extract<
      IpcMessage,
      { type: "response" }
    >
  ): void {
    const pending = this.pending.get(message.id);

    if (!pending) {
      return;
    }

    this.pending.delete(message.id);

    if (message.error) {
      const error = new Error(
        message.error.message
      );

      error.name =
        message.error.name ?? "Error";

      if (message.error.stack) {
        error.stack = message.error.stack;
      }

      pending.reject(error);
      return;
    }

    pending.resolve(message.result);
  }

  private emit(
    channel: string,
    ...args: unknown[]
  ): void {
    const listeners = this.listeners.get(channel);

    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(...args);
    }
  }
}

// Main

type Listener = (
  event: MyIpcMainEvent,
  ...args: unknown[]
) => void;

type Handler = (
  event: MyIpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>;

export interface MyIpcMainEvent {
  sender: MyIpcRendererLike;
}

export interface MyIpcMainInvokeEvent {
  sender: MyIpcRendererLike;
}

export interface MyIpcRendererLike {
  send(channel: string, ...args: unknown[]): void;
}

export class MyIpcMain {
  private readonly listeners =
    new Map<string, Set<Listener>>();

  private readonly handlers =
    new Map<string, Handler>();

  constructor(
    private readonly child: ChildProcess
  ) {
    child.on(
      "message",
      (message: IpcMessage) => {
        void this.handleMessage(message);
      }
    );
  }

  /**
   * Electron-like:
   *
   * ipcMain.on(channel, listener)
   */
  on(
    channel: string,
    listener: Listener
  ): void {
    let listeners =
      this.listeners.get(channel);

    if (!listeners) {
      listeners = new Set();
      this.listeners.set(channel, listeners);
    }

    listeners.add(listener);
  }

  /**
   * Electron-like:
   *
   * ipcMain.once(channel, listener)
   */
  once(
    channel: string,
    listener: Listener
  ): void {
    const wrapper: Listener = (
      event,
      ...args
    ) => {
      this.removeListener(
        channel,
        wrapper
      );

      listener(event, ...args);
    };

    this.on(channel, wrapper);
  }

  /**
   * Electron-like:
   *
   * ipcMain.handle(channel, handler)
   */
  handle(
    channel: string,
    handler: Handler
  ): void {
    if (this.handlers.has(channel)) {
      throw new Error(
        `Handler already registered for "${channel}"`
      );
    }

    this.handlers.set(channel, handler);
  }

  /**
   * Electron-like:
   *
   * ipcMain.removeHandler(channel)
   */
  removeHandler(
    channel: string
  ): void {
    this.handlers.delete(channel);
  }

  /**
   * Electron-like:
   *
   * ipcMain.removeListener(channel, listener)
   */
  removeListener(
    channel: string,
    listener: Listener
  ): void {
    const listeners =
      this.listeners.get(channel);

    if (!listeners) {
      return;
    }

    listeners.delete(listener);

    if (listeners.size === 0) {
      this.listeners.delete(channel);
    }
  }

  /**
   * Main → Renderer
   *
   * Similar to:
   * webContents.send(channel, ...args)
   */
  send(
    channel: string,
    ...args: unknown[]
  ): void {
    this.child.send({
      type: "event",
      channel,
      args,
    });
  }

  private async handleMessage(
    message: IpcMessage
  ): Promise<void> {
    switch (message.type) {
      case "send":
        this.handleSend(message);
        break;

      case "postMessage":
        this.handlePostMessage(message);
        break;

      case "invoke":
        await this.handleInvoke(message);
        break;
    }
  }

  private handleSend(
    message: Extract<
      IpcMessage,
      { type: "send" }
    >
  ): void {
    this.emit(
      message.channel,
      ...message.args
    );
  }

  private handlePostMessage(
    message: Extract<
      IpcMessage,
      { type: "postMessage" }
    >
  ): void {
    this.emit(
      message.channel,
      message.message
    );
  }

  private async handleInvoke(
    message: Extract<
      IpcMessage,
      { type: "invoke" }
    >
  ): Promise<void> {
    const handler =
      this.handlers.get(message.channel);

    if (!handler) {
      this.sendResponse(message.id, {
        message:
          `No handler registered for "${message.channel}"`,
        name: "Error",
      });

      return;
    }

    try {
      const event: MyIpcMainInvokeEvent = {
        sender: this.createSender(),
      };

      const result = await handler(
        event,
        ...message.args
      );

      this.sendResponse(
        message.id,
        undefined,
        result
      );
    } catch (error) {
      this.sendResponse(
        message.id,
        {
          message:
            error instanceof Error
              ? error.message
              : String(error),

          name:
            error instanceof Error
              ? error.name
              : "Error",

          stack:
            error instanceof Error
              ? error.stack
              : undefined,
        }
      );
    }
  }

  private sendResponse(
    id: number,
    error?: {
      message: string;
      name?: string;
      stack?: string;
    },
    result?: unknown
  ): void {
    this.child.send({
      type: "response",
      id,
      error,
      result,
    });
  }

  private emit(
    channel: string,
    ...args: unknown[]
  ): void {
    const listeners =
      this.listeners.get(channel);

    if (!listeners) {
      return;
    }

    const event: MyIpcMainEvent = {
      sender: this.createSender(),
    };

    for (const listener of listeners) {
      listener(event, ...args);
    }
  }

  private createSender(): MyIpcRendererLike {
    return {
      send: (
        channel: string,
        ...args: unknown[]
      ) => {
        this.send(channel, ...args);
      },
    };
  }
}

// Usage

// export const ipcRendererWeb = new MyIpcRenderer();
// const child = fork("./worker.js");
// const ipcMainWeb = new MyIpcMain(child);
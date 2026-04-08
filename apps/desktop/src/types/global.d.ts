declare global {
  interface Window {
    lobster: {
      rpc(method: string, params?: unknown): Promise<unknown>;
    };
  }
}

export {};


import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("lobster", {
  rpc(method: string, params?: unknown) {
    return ipcRenderer.invoke("lobster:rpc", method, params);
  }
});


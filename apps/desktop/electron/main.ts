import { BrowserWindow, app, ipcMain } from "electron";
import net from "node:net";
import path from "node:path";
import type { JsonRpcResponse } from "@lobster/shared";

const SOCKET_PATH = "/tmp/lobster/lobsterd.sock";

async function callDaemon(method: string, params?: unknown): Promise<JsonRpcResponse["result"]> {
  return await new Promise((resolve, reject) => {
    const client = net.createConnection(SOCKET_PATH);
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now().toString(),
      method,
      params
    });

    client.once("error", reject);
    client.once("data", (chunk) => {
      const response = JSON.parse(chunk.toString("utf8").trim()) as JsonRpcResponse;
      client.end();
      if (response.error) {
        reject(new Error(response.error.message));
        return;
      }
      resolve(response.result);
    });
    client.write(`${request}\n`);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 1200,
    minHeight: 760,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist-electron", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: "detach" });
    return;
  }

  void win.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
}

app.whenReady().then(() => {
  ipcMain.handle("lobster:rpc", async (_event, method: string, params?: unknown) => callDaemon(method, params));
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});


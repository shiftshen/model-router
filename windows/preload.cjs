const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cma", {
  call(command, args = [], input = null) {
    return ipcRenderer.invoke("cma:call", { command, args, input });
  },
  openDataDir() {
    return ipcRenderer.invoke("cma:open-data-dir");
  },
  installUpdate(path, portable, releaseUrl) {
    return ipcRenderer.invoke("cma:install-update", { path, portable, releaseUrl });
  },
  platform() {
    return ipcRenderer.invoke("cma:platform");
  }
});

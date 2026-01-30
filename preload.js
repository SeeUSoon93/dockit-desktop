const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onOpenDockitFile: (callback) => {
    ipcRenderer.on("open-dockit-file", (event, data) => callback(data));
  }
});

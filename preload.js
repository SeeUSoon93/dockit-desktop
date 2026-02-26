const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onOpenDockitFile: (callback) => {
    ipcRenderer.on("open-dockit-file", (event, data) => callback(data));
  },

  // 인쇄 미리 보기
  printWithPreview: (options) =>
    ipcRenderer.invoke("print-with-preview", options),

  // 직접 인쇄
  printDirect: (options) => ipcRenderer.invoke("print-direct", options)
});

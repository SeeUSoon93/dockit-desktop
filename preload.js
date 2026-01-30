const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onOpenDockitFile: (callback) => {
    ipcRenderer.on("open-dockit-file", (event, data) => callback(data));
  },
  // 인쇄 미리 보기 (PDF 미리 보기 창 열기)
  printWithPreview: (options) => ipcRenderer.invoke("print-with-preview", options),
  // 직접 인쇄 (시스템 인쇄 대화상자)
  printDirect: (options) => ipcRenderer.invoke("print-direct", options)
});

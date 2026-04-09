const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");

// 메뉴바 제거
Menu.setApplicationMenu(null);

const dockitWindows = new Set();
const pendingFilesToOpen = [];

// Windows/Linux: 파일 더블클릭 시 process.argv로 경로 전달됨
function getFileFromArgs(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  const dockitFile = args.find((arg) => arg.endsWith(".dockit"));
  return dockitFile || null;
}

function focusWindow(win) {
  if (!win || win.isDestroyed()) return;

  if (win.isMinimized()) win.restore();
  win.focus();
}

function getFirstWindow() {
  return Array.from(dockitWindows).find((win) => !win.isDestroyed()) || null;
}

// .dockit 파일 읽어서 특정 renderer에 전달
function loadDockitFile(targetWindow, filePath) {
  if (!targetWindow || targetWindow.isDestroyed() || !filePath) return;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(content);

    if (data.fileType === "dockit-document") {
      targetWindow.webContents.send("open-dockit-file", {
        filePath,
        data
      });
    }
  } catch (error) {
    console.error("파일 열기 실패:", error);
  }
}

function createWindow(filePath = null) {
  let pendingFilePath = filePath;

  const dockitWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: path.join(__dirname, "icons", "icon.png"),
    frame: false,
    transparent: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  dockitWindows.add(dockitWindow);
  dockitWindow.loadURL("https://dockit.kr");

  dockitWindow.on("closed", () => {
    dockitWindows.delete(dockitWindow);
  });

  dockitWindow.webContents.setUserAgent(
    dockitWindow.webContents.getUserAgent() + " DockitDesktop"
  );

  // 최대화: 라운드/그림자 제거 + renderer에 알림
  dockitWindow.on("maximize", () => {
    dockitWindow.webContents.send("window-maximized", true);
  });

  // 복원: 라운드/그림자 재적용 + renderer에 알림
  dockitWindow.on("unmaximize", () => {
    dockitWindow.webContents.send("window-maximized", false);
  });

  dockitWindow.webContents.on("did-finish-load", () => {
    if (!pendingFilePath) return;

    const fileToLoad = pendingFilePath;
    pendingFilePath = null;

    setTimeout(() => {
      loadDockitFile(dockitWindow, fileToLoad);
    }, 1500);
  });

  return dockitWindow;
}

const initialFileToOpen = getFileFromArgs(process.argv);
if (initialFileToOpen) {
  pendingFilesToOpen.push(initialFileToOpen);
}

// Single Instance Lock - 앱 중복 실행 방지
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  // 이미 실행 중일 때 새 창 또는 새 문서 열기
  app.on("second-instance", (_event, argv) => {
    const filePath = getFileFromArgs(argv);

    if (filePath) {
      if (app.isReady()) {
        const newWindow = createWindow(filePath);
        focusWindow(newWindow);
      } else {
        pendingFilesToOpen.push(filePath);
      }
      return;
    }

    if (app.isReady()) {
      const newWindow = createWindow();
      focusWindow(newWindow);
      return;
    }

    const existingWindow = getFirstWindow();
    if (existingWindow) {
      focusWindow(existingWindow);
    }
  });
}

app.whenReady().then(() => {
  if (pendingFilesToOpen.length > 0) {
    pendingFilesToOpen.splice(0).forEach((filePath) => {
      createWindow(filePath);
    });
    return;
  }

  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (dockitWindows.size === 0) {
    createWindow();
  }
});

// macOS: 파일 더블클릭 또는 드래그앤드롭
app.on("open-file", (event, filePath) => {
  event.preventDefault();

  if (!filePath.endsWith(".dockit")) return;

  if (app.isReady()) {
    const newWindow = createWindow(filePath);
    focusWindow(newWindow);
    return;
  }

  pendingFilesToOpen.push(filePath);
});

// 윈도우 컨트롤 IPC 핸들러
ipcMain.on("window-minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.on("window-maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on("window-close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

// 인쇄 미리 보기 지원을 위한 IPC 핸들러
ipcMain.handle("print-with-preview", async (event, options = {}) => {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender);
  if (!ownerWindow) return { success: false, error: "No window" };

  try {
    const pdfData = await ownerWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      ...options
    });

    const tempPath = path.join(os.tmpdir(), `dockit-print-${Date.now()}.pdf`);
    fs.writeFileSync(tempPath, pdfData);

    const previewWindow = new BrowserWindow({
      width: 800,
      height: 900,
      parent: ownerWindow,
      modal: true,
      title: "인쇄 미리 보기",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        plugins: true
      }
    });

    previewWindow.loadURL(`file://${tempPath}`);

    previewWindow.on("closed", () => {
      try {
        fs.unlinkSync(tempPath);
      } catch (e) {
        // 파일 삭제 실패 무시
      }
    });

    return { success: true };
  } catch (error) {
    console.error("인쇄 미리 보기 실패:", error);
    return { success: false, error: error.message };
  }
});

// 직접 인쇄 (시스템 대화상자)
ipcMain.handle("print-direct", async (event, options = {}) => {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender);
  if (!ownerWindow) return { success: false, error: "No window" };

  return new Promise((resolve) => {
    ownerWindow.webContents.print(
      {
        silent: false,
        printBackground: true,
        ...options
      },
      (success, failureReason) => {
        resolve({ success, error: failureReason });
      }
    );
  });
});

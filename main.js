const { app, BrowserWindow, Menu, ipcMain, screen } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");

// 메뉴바 제거
Menu.setApplicationMenu(null);

const dockitWindows = new Set();
const pendingFilesToOpen = [];
const windowStateSaveTimers = new WeakMap();
const trackedDownloadSessions = new WeakSet();
const DOCUMENT_EXTENSION = ".dkt";
const WINDOWS_APP_USER_MODEL_ID = "kr.dockit.desktop";
const DEFAULT_WINDOW_STATE = Object.freeze({
  width: 1280,
  height: 800,
  isMaximized: false
});
const WINDOW_STATE_FILE_NAME = "window-state.json";

// Windows/Linux: 파일 더블클릭 시 process.argv로 경로 전달됨
function getFileFromArgs(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  const documentFile = args.find((arg) => isDockitDocumentPath(arg));
  return documentFile || null;
}

function isDockitDocumentPath(filePath) {
  return (
    typeof filePath === "string" &&
    filePath.toLowerCase().endsWith(DOCUMENT_EXTENSION)
  );
}

function addRecentDocument(filePath) {
  if (
    (process.platform !== "win32" && process.platform !== "darwin") ||
    !isDockitDocumentPath(filePath)
  ) {
    return;
  }

  const resolvedPath = path.resolve(filePath);

  if (!fs.existsSync(resolvedPath)) {
    return;
  }

  app.addRecentDocument(resolvedPath);
}

function registerDownloadTracking(targetSession) {
  if (!targetSession || trackedDownloadSessions.has(targetSession)) {
    return;
  }

  trackedDownloadSessions.add(targetSession);

  targetSession.on("will-download", (_event, item) => {
    item.once("done", (_doneEvent, state) => {
      if (state !== "completed") {
        return;
      }

      const savedPath = item.getSavePath();
      addRecentDocument(savedPath);
    });
  });
}

function focusWindow(win) {
  if (!win || win.isDestroyed()) return;

  if (win.isMinimized()) win.restore();
  win.focus();
}

function getFirstWindow() {
  return Array.from(dockitWindows).find((win) => !win.isDestroyed()) || null;
}

function getReferenceWindow() {
  return BrowserWindow.getFocusedWindow() || getFirstWindow();
}

function getWindowStatePath() {
  return path.join(app.getPath("userData"), WINDOW_STATE_FILE_NAME);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isVisibleOnSomeDisplay(bounds) {
  return screen.getAllDisplays().some(({ workArea }) => {
    const intersectsHorizontally =
      bounds.x < workArea.x + workArea.width &&
      bounds.x + bounds.width > workArea.x;
    const intersectsVertically =
      bounds.y < workArea.y + workArea.height &&
      bounds.y + bounds.height > workArea.y;

    return intersectsHorizontally && intersectsVertically;
  });
}

function readWindowState() {
  try {
    const raw = fs.readFileSync(getWindowStatePath(), "utf-8");
    const parsed = JSON.parse(raw);

    if (
      !isFiniteNumber(parsed.width) ||
      !isFiniteNumber(parsed.height) ||
      parsed.width <= 0 ||
      parsed.height <= 0
    ) {
      return { ...DEFAULT_WINDOW_STATE };
    }

    const nextState = {
      width: parsed.width,
      height: parsed.height,
      isMaximized: Boolean(parsed.isMaximized)
    };

    if (isFiniteNumber(parsed.x) && isFiniteNumber(parsed.y)) {
      const candidateBounds = {
        x: parsed.x,
        y: parsed.y,
        width: parsed.width,
        height: parsed.height
      };

      if (isVisibleOnSomeDisplay(candidateBounds)) {
        nextState.x = parsed.x;
        nextState.y = parsed.y;
      }
    }

    return nextState;
  } catch (_error) {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

function getOffsetWindowState(sourceWindow) {
  if (
    !sourceWindow ||
    sourceWindow.isDestroyed() ||
    sourceWindow.isMaximized() ||
    sourceWindow.isFullScreen()
  ) {
    return null;
  }

  const sourceBounds = sourceWindow.getNormalBounds();
  const display = screen.getDisplayMatching(sourceBounds);
  const { workArea } = display;
  const offset = 28;
  const maxX = workArea.x + Math.max(0, workArea.width - sourceBounds.width);
  const maxY = workArea.y + Math.max(0, workArea.height - sourceBounds.height);

  return {
    x: Math.max(workArea.x, Math.min(sourceBounds.x + offset, maxX)),
    y: Math.max(workArea.y, Math.min(sourceBounds.y + offset, maxY)),
    width: sourceBounds.width,
    height: sourceBounds.height,
    isMaximized: false
  };
}

function getWindowState(sourceWindow = null) {
  return getOffsetWindowState(sourceWindow) || readWindowState();
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;

  try {
    const bounds = win.getNormalBounds();
    const stateToSave = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: win.isMaximized()
    };

    fs.writeFileSync(getWindowStatePath(), JSON.stringify(stateToSave, null, 2));
  } catch (error) {
    console.error("창 상태 저장 실패:", error);
  }
}

function scheduleWindowStateSave(win) {
  if (!win || win.isDestroyed()) return;

  const existingTimer = windowStateSaveTimers.get(win);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    windowStateSaveTimers.delete(win);
    saveWindowState(win);
  }, 250);

  windowStateSaveTimers.set(win, timer);
}

function clearWindowStateSaveTimer(win) {
  const existingTimer = windowStateSaveTimers.get(win);
  if (existingTimer) {
    clearTimeout(existingTimer);
    windowStateSaveTimers.delete(win);
  }
}

function isNewWindowShortcut(input) {
  return (
    input.type === "keyDown" &&
    typeof input.key === "string" &&
    input.key.toLowerCase() === "n" &&
    input.shift &&
    !input.alt &&
    (input.control || input.meta)
  );
}

// .dkt 파일 읽어서 특정 renderer에 전달
function loadDockitFile(targetWindow, filePath) {
  if (!targetWindow || targetWindow.isDestroyed() || !filePath) return;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(content);

    if (data.fileType === "dockit-document") {
      addRecentDocument(filePath);
      targetWindow.webContents.send("open-dockit-file", {
        filePath,
        data
      });
    }
  } catch (error) {
    console.error("파일 열기 실패:", error);
  }
}

function createWindow(filePath = null, options = {}) {
  let pendingFilePath = filePath;
  const windowState = getWindowState(options.sourceWindow);

  const dockitWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    ...(isFiniteNumber(windowState.x) ? { x: windowState.x } : {}),
    ...(isFiniteNumber(windowState.y) ? { y: windowState.y } : {}),
    icon: path.join(__dirname, "icons", "icon.png"),
    frame: false,
    transparent: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  registerDownloadTracking(dockitWindow.webContents.session);
  dockitWindows.add(dockitWindow);
  dockitWindow.loadURL("https://dockit.kr");

  dockitWindow.on("move", () => {
    scheduleWindowStateSave(dockitWindow);
  });

  dockitWindow.on("resize", () => {
    scheduleWindowStateSave(dockitWindow);
  });

  dockitWindow.on("closed", () => {
    clearWindowStateSaveTimer(dockitWindow);
    dockitWindows.delete(dockitWindow);
  });

  dockitWindow.webContents.setUserAgent(
    dockitWindow.webContents.getUserAgent() + " DockitDesktop"
  );

  // 최대화: 라운드/그림자 제거 + renderer에 알림
  dockitWindow.on("maximize", () => {
    scheduleWindowStateSave(dockitWindow);
    dockitWindow.webContents.send("window-maximized", true);
  });

  // 복원: 라운드/그림자 재적용 + renderer에 알림
  dockitWindow.on("unmaximize", () => {
    scheduleWindowStateSave(dockitWindow);
    dockitWindow.webContents.send("window-maximized", false);
  });

  dockitWindow.on("close", () => {
    saveWindowState(dockitWindow);
  });

  dockitWindow.webContents.on("before-input-event", (event, input) => {
    if (!isNewWindowShortcut(input)) return;

    event.preventDefault();
    const newWindow = createWindow(null, { sourceWindow: dockitWindow });
    focusWindow(newWindow);
  });

  dockitWindow.webContents.on("did-finish-load", () => {
    if (!pendingFilePath) return;

    const fileToLoad = pendingFilePath;
    pendingFilePath = null;

    setTimeout(() => {
      loadDockitFile(dockitWindow, fileToLoad);
    }, 1500);
  });

  if (windowState.isMaximized) {
    dockitWindow.maximize();
  }

  return dockitWindow;
}

const initialFileToOpen = getFileFromArgs(process.argv);
if (initialFileToOpen) {
  pendingFilesToOpen.push(initialFileToOpen);
}

if (process.platform === "win32") {
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
}

// Single Instance Lock - 앱 중복 실행 방지
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  // 이미 실행 중일 때 새 창 또는 새 문서 열기
  app.on("second-instance", (_event, argv) => {
    const filePath = getFileFromArgs(argv);
    const referenceWindow = getReferenceWindow();

    if (filePath) {
      if (app.isReady()) {
        const newWindow = createWindow(filePath, {
          sourceWindow: referenceWindow
        });
        focusWindow(newWindow);
      } else {
        pendingFilesToOpen.push(filePath);
      }
      return;
    }

    if (app.isReady()) {
      const newWindow = createWindow(null, { sourceWindow: referenceWindow });
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

  if (!isDockitDocumentPath(filePath)) return;

  if (app.isReady()) {
    const newWindow = createWindow(filePath, {
      sourceWindow: getReferenceWindow()
    });
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

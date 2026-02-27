const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");

// 메뉴바 제거
Menu.setApplicationMenu(null);

let mainWindow;
let fileToOpen = null;

// Windows/Linux: 파일 더블클릭 시 process.argv로 경로 전달됨
function getFileFromArgs(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  const dockitFile = args.find((arg) => arg.endsWith(".dockit"));
  return dockitFile || null;
}

// .dockit 파일 읽어서 renderer에 전달
function loadDockitFile(filePath) {
  if (!mainWindow || !filePath) return;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(content);

    if (data.fileType === "dockit-document") {
      mainWindow.webContents.send("open-dockit-file", {
        filePath,
        data
      });
    }
  } catch (error) {
    console.error("파일 열기 실패:", error);
  }
}

// 앱 시작 시 파일 경로 확인
fileToOpen = getFileFromArgs(process.argv);

// Single Instance Lock - 앱 중복 실행 방지
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  // 이미 실행 중일 때 다른 파일 열기 시도
  app.on("second-instance", (event, argv) => {
    const filePath = getFileFromArgs(argv);
    if (filePath && mainWindow) {
      loadDockitFile(filePath);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: path.join(__dirname, "icons", "icon.png"),
    frame: false,
    transparent: true,
    hasShadow: false, // Windows에서는 의미 없음
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  mainWindow.loadURL("https://dockit.kr");

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setUserAgent(
    mainWindow.webContents.getUserAgent() + " DockitDesktop"
  );

  // 최대화: 라운드/그림자 제거 + renderer에 알림
  mainWindow.on("maximize", () => {
    mainWindow.webContents.send("window-maximized", true);
  });

  // 복원: 라운드/그림자 재적용 + renderer에 알림
  mainWindow.on("unmaximize", () => {
    mainWindow.webContents.send("window-maximized", false);
  });

  // 페이지 로드 완료 후 라운드 CSS 주입
  mainWindow.webContents.on("did-finish-load", () => {
    if (fileToOpen) {
      setTimeout(() => {
        loadDockitFile(fileToOpen);
        fileToOpen = null;
      }, 1500);
    }
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// macOS: 파일 더블클릭 또는 드래그앤드롭
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (filePath.endsWith(".dockit")) {
    if (mainWindow) {
      loadDockitFile(filePath);
    } else {
      fileToOpen = filePath;
    }
  }
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
  if (!mainWindow) return { success: false, error: "No window" };

  try {
    const pdfData = await mainWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      ...options
    });

    const tempPath = path.join(os.tmpdir(), `dockit-print-${Date.now()}.pdf`);
    fs.writeFileSync(tempPath, pdfData);

    const previewWindow = new BrowserWindow({
      width: 800,
      height: 900,
      parent: mainWindow,
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
ipcMain.handle("print-direct", async (_event, options = {}) => {
  if (!mainWindow) return { success: false, error: "No window" };

  return new Promise((resolve) => {
    mainWindow.webContents.print(
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

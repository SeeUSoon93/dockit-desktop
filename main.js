const { app, BrowserWindow, Menu, ipcMain, dialog } = require("electron");
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
    // 창 포커스
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
    webPreferences: {
      nodeIntegration: false,
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

  // 페이지 로드 완료 후 파일 열기
  mainWindow.webContents.on("did-finish-load", () => {
    if (fileToOpen) {
      // 약간의 딜레이 후 파일 열기 (앱 초기화 대기)
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

// 인쇄 미리 보기 지원을 위한 IPC 핸들러
ipcMain.handle("print-with-preview", async (event, options = {}) => {
  if (!mainWindow) return { success: false, error: "No window" };

  try {
    // PDF로 먼저 생성하여 미리 보기 창에서 인쇄
    const pdfData = await mainWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      ...options
    });

    // 임시 PDF 파일 생성
    const tempPath = path.join(os.tmpdir(), `dockit-print-${Date.now()}.pdf`);
    fs.writeFileSync(tempPath, pdfData);

    // 미리 보기 창 생성
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

    // PDF 파일 로드 (Chromium 내장 PDF 뷰어 사용)
    previewWindow.loadURL(`file://${tempPath}`);

    // 창 닫힐 때 임시 파일 삭제
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

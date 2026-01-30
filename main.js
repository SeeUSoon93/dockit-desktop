const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

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

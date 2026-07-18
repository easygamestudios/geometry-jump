/* ============================================================
   Geometry Jump — оболочка приложения (Electron, main process)
   Игра лежит в app/ и грузится по своему протоколу gjump://game/,
   а не через file:// — так у страницы нормальное происхождение,
   и localStorage (прогресс, настройки, автосохранение редактора)
   переживает перезапуск приложения.
   ============================================================ */
'use strict';

const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('node:path');
const serve = require('./serve');

const { SCHEME, ENTRY } = serve; // ENTRY — игра вместе с редактором

serve.registerPrivileges();

/* ---------- окно ---------- */
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 960,
    minHeight: 600,
    title: 'Geometry Jump',
    backgroundColor: '#0a1e64',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadURL(ENTRY);

  // если игра не загрузилась — сказать об этом, а не показывать пустое окно
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[Geometry Jump] не загрузилось: ${code} ${desc} ${url}`);
  });
  win.webContents.on('did-finish-load', () => {
    console.log('[Geometry Jump] игра загружена');
  });

  // внешние ссылки — в браузер, а не поверх игры
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(SCHEME + '://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

/* ---------- экспорт уровней ---------- */
// Кнопка «⤓ Экспорт» в редакторе — это <a download> с blob-ссылкой.
// Просим Electron всегда показывать диалог сохранения, чтобы файл
// не уезжал молча в «Загрузки».
function setupDownloads() {
  app.on('session-created', (session) => {
    session.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({
        title: 'Сохранить уровень',
        defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
        filters: [
          { name: 'Уровень Geometry Jump', extensions: ['json'] },
          { name: 'Все файлы', extensions: ['*'] }
        ]
      });
    });
  });
}

/* ---------- меню ---------- */
function buildMenu() {
  const template = [
    {
      label: 'Geometry Jump',
      submenu: [
        { role: 'about', label: 'О Geometry Jump' },
        { type: 'separator' },
        { role: 'hide', label: 'Скрыть' },
        { role: 'hideOthers', label: 'Скрыть остальные' },
        { role: 'unhide', label: 'Показать все' },
        { type: 'separator' },
        { role: 'quit', label: 'Выйти' }
      ]
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Вернуть' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выделить все' }
      ]
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Перезагрузить игру' },
        { role: 'togglefullscreen', label: 'Полный экран' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' }
      ]
    },
    {
      label: 'Окно',
      submenu: [
        { role: 'minimize', label: 'Свернуть' },
        { role: 'zoom', label: 'Увеличить' },
        { role: 'close', label: 'Закрыть' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- запуск ---------- */
setupDownloads();

app.whenReady().then(() => {
  serve.install();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

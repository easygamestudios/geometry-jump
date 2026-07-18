/* Проверочный прогон: грузит игру, ловит ошибки консоли, снимает кадр.
   Запуск: npx electron electron/verify.js            (лобби)
           npx electron electron/verify.js editor     (экран редактора) */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const serve = require('./serve');

const { SCHEME } = serve;
const SHOT_DIR = process.env.GJ_SHOT_DIR || path.join(__dirname, '..', 'dist-verify');
const MODE = process.argv[2] || 'lobby';

serve.registerPrivileges();

const problems = [];

app.whenReady().then(async () => {
  serve.install();

  const win = new BrowserWindow({
    width: 1280, height: 760, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });

  const consoleLog = [];
  win.webContents.on('console-message', (event) => {
    const line = `[${event.level}] ${event.message}`;
    consoleLog.push(line);
    if (event.level === 'error' || event.level === 'warning') problems.push('console: ' + event.message);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    problems.push(`did-fail-load ${code} ${desc} ${url}`);
  });
  win.webContents.session.webRequest.onCompleted((details) => {
    if (details.statusCode >= 400) problems.push(`HTTP ${details.statusCode} ${details.url}`);
  });

  // экспорт: перехватываем скачивание, чтобы проверить содержимое файла
  let exported = null;
  if (MODE === 'export') {
    win.webContents.session.on('will-download', (_e, item) => {
      const dest = path.join(SHOT_DIR, item.getFilename());
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      item.setSavePath(dest);
      item.once('done', (_ev, st) => { exported = { dest, state: st }; });
    });
  }

  await win.loadURL(`${SCHEME}://game/dev.html`);
  await new Promise((r) => setTimeout(r, 2500));

  if (MODE === 'editor' || MODE === 'export') {
    await win.webContents.executeJavaScript(`document.querySelector('#btn-editor').click()`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (MODE === 'export') {
    await win.webContents.executeJavaScript(`document.querySelector('#ed-export').click()`);
    await new Promise((r) => setTimeout(r, 2500));
  }

  // реальный прогон уровня: игрок должен проехать вперёд сам по себе
  let run = null;
  if (MODE === 'play') {
    // важно вернуть скалярное значение: результат playLevel несериализуем и вешает промис,
    // а ошибку ловим внутри страницы, иначе Electron отдаёт её без текста
    const launch = await win.webContents.executeJavaScript(`(() => {
      try {
        if (!window.GW_APP) return 'нет GW_APP';
        if (!window.LEVELS || !window.LEVELS.length) return 'нет LEVELS';
        window.GW_APP.playLevel(window.LEVELS[0]);
        return 'ok';
      } catch (e) { return 'ОШИБКА: ' + (e && e.stack ? e.stack : e); }
    })()`);
    if (launch !== 'ok') problems.push('запуск уровня: ' + launch);
    console.log('=== LAUNCH ===');
    console.log(launch);
    await new Promise((r) => setTimeout(r, 1200));

    // поля движка заранее не известны — сначала смотрим, что вообще есть
    const shape = await win.webContents.executeJavaScript(`(() => {
      try {
        const g = window.GW_APP.game;
        if (!g) return { есть_game: false };
        return {
          есть_game: true,
          ключи: Object.keys(g).slice(0, 40),
          player: g.player ? Object.keys(g.player).slice(0, 30) : null
        };
      } catch (e) { return { ошибка: String(e) }; }
    })()`);

    const snap = `(() => {
      try {
        const g = window.GW_APP.game;
        if (!g) return null;
        const p = g.player || g.p || {};
        return { x: p.x, y: p.y, мертв: p.dead, время: g.time, процент: g.percent };
      } catch (e) { return { ошибка: String(e) }; }
    })()`;

    const t0 = await win.webContents.executeJavaScript(snap);
    await new Promise((r) => setTimeout(r, 2500));
    const t1 = await win.webContents.executeJavaScript(snap);

    run = { структура: shape, старт: t0, через_2_5с: t1 };
    if (!t0 || !t1) problems.push('игра не запустилась (нет GW_APP.game)');
    else if (typeof t0.x !== 'number' || typeof t1.x !== 'number') problems.push('не читается позиция игрока');
    else if (!(t1.x > t0.x)) problems.push(`игрок не движется: x ${t0.x} -> ${t1.x}`);
  }

  // музыка: без Range-запросов длительность приходит Infinity, и тогда
  // music.currentTime = 0 при новой попытке молча не срабатывает
  const music = await win.webContents.executeJavaScript(`new Promise((res) => {
    const a = new Audio('music/level1.mp3');
    const t = setTimeout(() => res('ТАЙМАУТ'), 8000);
    a.onloadedmetadata = () => {
      clearTimeout(t);
      if (!isFinite(a.duration)) return res('длительность Infinity — перемотка сломана');
      try { a.currentTime = 0; } catch (e) { return res('перемотка не работает: ' + e.message); }
      res('ok, длительность ' + Math.round(a.duration) + ' сек, перемотка работает');
    };
    a.onerror = () => { clearTimeout(t); res('ОШИБКА загрузки'); };
  })`);
  if (!String(music).startsWith('ok')) problems.push('музыка: ' + music);

  // что реально живо на странице
  const probe = await win.webContents.executeJavaScript(`(() => ({
    title: document.title,
    lobby: (document.querySelector('#lobby-title')||{}).textContent,
    screen: (document.querySelector('.screen.active')||{}).id,
    hasEditorBtn: !!document.querySelector('#btn-editor'),
    движок: !!window.GW,
    редактор: !!window.GW_EDITOR,
    кубиков: window.GW && window.GW.Icons ? Object.keys(window.GW.Icons.images).length : -1,
    музыка: ${JSON.stringify('')} + ${JSON.stringify(music)},
    levels: (window.LEVELS||[]).length,
    canvasPainted: (() => {
      const c = document.querySelector('#game-canvas');
      if (!c) return 'нет канваса';
      return c.width + 'x' + c.height;
    })(),
    storage: (() => { try { localStorage.setItem('__t','1'); localStorage.removeItem('__t'); return 'ok'; }
                      catch(e) { return 'FAIL: ' + e.message; } })()
  }))()`);

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const img = await win.capturePage();
  const shot = path.join(SHOT_DIR, `${MODE}.png`);
  fs.writeFileSync(shot, img.toPNG());

  console.log('=== PROBE ===');
  console.log(JSON.stringify(probe, null, 2));
  if (run) {
    console.log('=== PLAY ===');
    console.log(JSON.stringify(run, null, 2));
  }

  if (MODE === 'export') {
    console.log('=== EXPORT ===');
    if (!exported) {
      problems.push('экспорт не выдал файл');
    } else {
      const raw = fs.readFileSync(exported.dest, 'utf8');
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { problems.push('экспорт: битый JSON — ' + e.message); }
      console.log(JSON.stringify({
        файл: exported.dest,
        статус: exported.state,
        байт: raw.length,
        формат: parsed && parsed.format,
        объектов: parsed && parsed.objects && parsed.objects.length
      }, null, 2));
    }
  }

  console.log('=== PROBLEMS (' + problems.length + ') ===');
  problems.forEach((p) => console.log(' - ' + p));
  console.log('=== SHOT ===');
  console.log(shot);

  app.exit(problems.length ? 1 : 0);
}).catch((err) => {
  console.error('ПРОВЕРКА УПАЛА:', err && err.stack ? err.stack : err);
  app.exit(2);
});

// страховка от зависания: проверка не должна висеть вечно
setTimeout(() => {
  console.error('ПРОВЕРКА ЗАВИСЛА (таймаут 60с)');
  app.exit(3);
}, 60000).unref?.();

/* Отдача файлов игры по протоколу gjump://game/
   Общий модуль: им пользуются и приложение (main.js), и проверка (verify.js),
   чтобы проверка гоняла ровно тот же код, что и релиз. */
'use strict';

const { protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const SCHEME = 'gjump';
const APP_DIR = path.join(__dirname, '..', 'app');

const PRIVILEGES = {
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4'
};

function handle(request) {
  const url = new URL(request.url);
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'dev.html';
  const target = path.join(APP_DIR, rel);

  // за пределы app/ не выпускаем
  const inside = path.relative(APP_DIR, target);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    return new Response('Not found', { status: 404 });
  }

  let data;
  try {
    data = fs.readFileSync(target); // fs понимает пути внутри app.asar
  } catch (e) {
    return new Response('Not found', { status: 404 });
  }

  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const total = data.length;

  // Range обязателен для музыки: без него <audio> не знает длительность,
  // и перемотка music.currentTime = 0 при новой попытке молча не срабатывает
  const range = request.headers.get('Range');
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
    }
    end = Math.min(end, total - 1);
    const chunk = data.subarray(start, end + 1);
    return new Response(chunk, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes'
      }
    });
  }

  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Length': String(total),
      'Accept-Ranges': 'bytes'
    }
  });
}

module.exports = {
  SCHEME,
  APP_DIR,
  ENTRY: `${SCHEME}://game/dev.html`,
  registerPrivileges() { protocol.registerSchemesAsPrivileged([PRIVILEGES]); },
  install() { protocol.handle(SCHEME, handle); }
};

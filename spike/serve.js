// Minimal static server for spike/site on 127.0.0.1:8787. Logs every request (proves Kane reached it).
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'site');
const port = Number(process.env.PORT || 8787);

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const name = url.pathname === '/' ? 'com.html' : path.basename(url.pathname);
  const file = path.join(root, name);
  fs.readFile(file, (err, body) => {
    const status = err ? 404 : 200;
    console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${status} ua=${(req.headers['user-agent'] || '').slice(0, 60)}`);
    res.writeHead(status, { 'content-type': err ? 'text/plain' : 'text/html; charset=utf-8' });
    res.end(err ? 'not found' : body);
  });
}).listen(port, '127.0.0.1', () => console.log(`fixture on http://127.0.0.1:${port}`));

const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');

// Create or open the database (will create guestbook.db if missing)
const dbPath = path.join(__dirname, 'guestbook.db');
const db = new Database(dbPath);

// Create schema if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY,
    handle TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

// Embedded HTML template
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Guestbook</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
    h1 { text-align: center; }
    form { display: flex; flex-direction: column; gap: 10px; margin-bottom: 30px; }
    input, textarea { padding: 8px; font-size: 14px; }
    button { padding: 10px; font-size: 16px; cursor: pointer; }
    .entries { list-style: none; padding: 0; }
    .entry { border-bottom: 1px solid #eee; padding: 15px 0; }
    .entry-handle { font-weight: bold; color: #333; }
    .entry-message { margin: 5px 0; color: #555; }
    .entry-time { font-size: 12px; color: #999; }
  </style>
</head>
<body>
  <h1>Guestbook</h1>
  <form action="/sign" method="POST">
    <input type="text" name="handle" placeholder="Your name" required />
    <textarea name="message" placeholder="Your message" rows="4" required></textarea>
    <button type="submit">Sign Guestbook</button>
  </form>
  <h2>Entries</h2>
  <ul class="entries"></ul>
  <script>
    fetch('/api/entries')
      .then(res => res.json())
      .then(entries => {
        const ul = document.querySelector('.entries');
        entries.forEach(e => {
          const li = document.createElement('li');
          li.className = 'entry';
          li.innerHTML = \`
            <div class="entry-handle">\${e.handle}</div>
            <div class="entry-message">\${e.message}</div>
            <div class="entry-time">\${new Date(e.created_at * 1000).toISOString()}</div>
          \`;
          ul.appendChild(li);
        });
      });
  </script>
</body>
</html>`;

// Helper to parse POST body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      resolve({
        handle: params.get('handle') || '',
        message: params.get('message') || ''
      });
    });
    req.on('error', reject);
  });
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, \`http://\${req.headers.host}\`);

  // GET / — serve HTML page with form and entries
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // GET /api/entries — return all entries as JSON
  if (req.method === 'GET' && url.pathname === '/api/entries') {
    const entries = db.prepare('SELECT * FROM entries ORDER BY created_at DESC').all();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(entries));
    return;
  }

  // POST /sign — accept form submission, insert row, redirect
  if (req.method === 'POST' && url.pathname === '/sign') {
    const { handle, message } = await parseBody(req);

    // Reject empty handle or message with 400
    if (!handle.trim() || !message.trim()) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Handle and message are required.');
      return;
    }

    db.prepare('INSERT INTO entries (handle, message, created_at) VALUES (?, ?, ?)'

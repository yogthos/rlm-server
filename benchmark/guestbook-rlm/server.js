const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');

const PORT = 3001;
const DATA_FILE = path.join(__dirname, 'guestbook.json');

// Helper to ensure the JSON file exists and read it
const readEntries = () => {
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify([]));
        return [];
    }
    try {
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        return [];
    }
};

// Helper to write entries to the JSON file
const writeEntries = (entries) => {
    fs.writeFileSync(DATA_FILE, JSON.stringify(entries, null, 2));
};

// The HTML Template
const getHtml = (entries) => {
    const entryHtml = entries.map(entry => `
        <div class="entry">
            <strong>${escapeHtml(entry.name)}</strong> 
            <small>${new Date(entry.timestamp).toLocaleString()}</small>
            <p>${escapeHtml(entry.message)}</p>
        </div>
    `).join('');

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Guestbook</title>
        <style>
            body { font-family: sans-serif; line-height: 1.6; max-width: 600px; margin: 40px auto; padding: 0 20px; background: #f4f4f9; }
            h1 { color: #333; text-align: center; }
            form { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); margin-bottom: 30px; }
           .field { margin-bottom: 15px; }
            label { display: block; margin-bottom: 5px; font-weight: bold; }
            input, textarea { width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; }
            textarea { height: 100px; resize: vertical; }
            button { background: #007bff; color: white; border: none; padding: 10px 15px; border-radius: 4px; cursor: pointer; width: 100%; font-size: 16px; }
            button:hover { background: #0056b3; }
           .entry { background: white; padding: 15px; border-radius: 8px; margin-bottom: 15px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
           .entry strong { color: #007bff; }
           .entry small { color: #777; margin-left: 10px; }
           .entry p { margin: 10px 0 0 0; }
           .error { color: red; font-size: 0.9em; margin-bottom: 10px; }
        </style>
    </head>
    <body>
        <h1>Guestbook</h1>
        
        <form action="/sign" method="POST">
            <div class="field">
                <label for="name">Name</label>
                <input type="text" id="name" name="name" required>
            </div>
            <div class="field">
                <label for="message">Message</label>
                <textarea id="message" name="message" required></textarea>
            </div>
            <button type="submit">Sign Guestbook</button>
        </form>

        <div id="entries">
            ${entryHtml || '<p style="text-align:center; color: #888;">No entries yet. Be the first!</p>'}
        </div>
    </body>
    </html>
    `;
};

// Simple XSS protection
const escapeHtml = (str) => {
    return str.replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
};

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const method = req.method;

    // GET /
    if (method === 'GET' && parsedUrl.pathname === '/') {
        const entries = readEntries().sort((a, b) => b.timestamp - a.timestamp);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(getHtml(entries));
    } 

    // GET /api/entries
    else if (method === 'GET' && parsedUrl.pathname === '/api/entries') {
        const entries = readEntries().sort((a, b) => b.timestamp - a.timestamp);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(entries));
    }

    // POST /sign
    else if (method === 'POST' && parsedUrl.pathname === '/sign') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            const formData = querystring.parse(body);
            const { name, message } = formData;

            // Validation
            if (!name || name.trim() === '' ||!message || message.trim() === '') {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Error: Name and Message are required.');
                return;
            }

            const entries = readEntries();
            const newEntry = {
                name: name.trim(),
                message: message.trim(),
                timestamp: Date.now()
            };

            entries.push(newEntry);
            writeEntries(entries);

            // Redirect back to home
            res.writeHead(302, { 'Location': '/' });
            res.end();
        });
    }

    // 404 Not Found
    else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
});

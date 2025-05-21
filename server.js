const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const port = process.env.PORT || 3000;

// Налаштування SQLite
const db = new sqlite3.Database(':memory:');
db.run(`CREATE TABLE IF NOT EXISTS requests (ip TEXT, count INTEGER, date TEXT)`);

// Middleware
app.use(cors());
app.use(express.json());

// API для обробки запитів до Grok
app.post('/api/gen-spark', async (req, res) => {
  const { prompt } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const today = new Date().toISOString().split('T')[0];

  // Перевірка кількості запитів
  db.get(
    `SELECT count FROM requests WHERE ip = ? AND date = ?`,
    [clientIp, today],
    async (err, row) => {
      if (err) return res.status(500).json({ error: 'Database error' });

      const count = row ? row.count : 0;
      if (count >= 10) {
        return res.status(429).json({ error: 'Daily limit of 10 requests reached' });
      }

      // Оновлення лічильника
      db.run(
        `INSERT OR REPLACE INTO requests (ip, count, date) VALUES (?, ?, ?)`,
        [clientIp, count + 1, today]
      );

      // Запит до Grok API
      try {
        const response = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'grok-3',
            messages: [{ role: 'user', content: prompt }],
          }),
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Grok API error');
        }

        res.json({ response: data.choices[0].message.content, remaining: 10 - (count + 1) });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    }
  );
});

// API для скидання лічильника (для GitHub Actions)
app.post('/api/reset-counts', (req, res) => {
  db.run(`DELETE FROM requests`, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to reset counts' });
    res.json({ message: 'Request counts reset' });
  });
});

app.listen(port, () => console.log(`Server running on port ${port}`));

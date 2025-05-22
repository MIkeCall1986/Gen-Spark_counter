const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const port = process.env.PORT || 3000;

// Налаштування SQLite
const db = new sqlite3.Database('gen_spark.db', (err) => {
  if (err) {
    console.error('Database connection error:', err);
    return;
  }
  console.log('Connected to SQLite database');
  db.run(`
    CREATE TABLE IF NOT EXISTS requests (
      ip TEXT,
      count INTEGER,
      date TEXT,
      PRIMARY KEY (ip, date)
    )
  `, (err) => {
    if (err) console.error('Error creating requests table:', err);
  });
  db.run(`
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT,
      prompt TEXT,
      response TEXT,
      timestamp TEXT
    )
  `, (err) => {
    if (err) console.error('Error creating history table:', err);
  });
});

// Middleware
app.use(cors({
  origin: 'http://asistant.infy.uk',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// Перевірка GROK_API_KEY
if (!process.env.GROK_API_KEY) {
  console.error('Error: GROK_API_KEY is not set in environment variables');
  process.exit(1);
}

// Системний prompt для Grok
const systemPrompt = `
  Ти — Gen Spark AI, асистент для українського військовослужбовця в зоні бойових дій. 
  Ти надаєш короткі, дієві поради щодо:
  — військової тактики, виживання, логістики
  — фізичного та ментального здоров’я
  — самонавчання та IT-напрямків
  — фінансового зростання
  Відповідай українською, тепло, підтримуюче.
`;

// POST /api/gen-spark
app.post('/api/gen-spark', async (req, res) => {
  const { prompt, history = [] } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const today = new Date().toISOString().split('T')[0];

  console.log(`Received /api/gen-spark request from IP: ${clientIp}, prompt: ${prompt}`);

  try {
    // Перевірка лімітів
    db.get(
      `SELECT count FROM requests WHERE ip = ? AND date = ?`,
      [clientIp, today],
      async (err, row) => {
        if (err) {
          console.error('Database query error:', err);
          return res.status(500).json({ error: 'Database error' });
        }
        const count = row ? row.count : 0;

        if (count >= 10) {
          console.log(`IP ${clientIp} exceeded daily limit of 10 requests`);
          return res.status(429).json({ error: 'Ліміт 10 запитів на день вичерпано' });
        }

        // Оновлення лічильника
        db.run(
          `INSERT OR REPLACE INTO requests (ip, count, date) VALUES (?, ?, ?)`,
          [clientIp, count + 1, today],
          (err) => {
            if (err) console.error('Error updating requests table:', err);
          }
        );

        // Формування повідомлень для xAI API
        const messages = [
          { role: 'system', content: systemPrompt },
          ...history.slice(-3).map(h => {
            try {
              return [
                { role: 'user', content: h.prompt || '' },
                { role: 'assistant', content: h.response || '' }
              ];
            } catch (e) {
              console.error('Error processing history entry:', e);
              return [];
            }
          }).flat(),
          { role: 'user', content: prompt || '' }
        ];

        // Запит до xAI API
        console.log('Sending request to xAI API');
        const response = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'grok-3',
            messages,
          }),
        });

        const data = await response.json();
        if (!response.ok) {
          console.error('xAI API error:', data);
          throw new Error(data.error?.message || 'Grok API error');
        }

        // Перевірка структури відповіді
        if (!data.choices || !data.choices[0]?.message?.content) {
          console.error('Invalid xAI API response structure:', data);
          throw new Error('Invalid response from Grok API');
        }

        const responseText = data.choices[0].message.content;

        // Збереження в історію
        db.run(
          `INSERT INTO history (ip, prompt, response, timestamp) VALUES (?, ?, ?, ?)`,
          [clientIp, prompt, responseText, new Date().toISOString()],
          (err) => {
            if (err) console.error('Error inserting into history:', err);
          }
        );

        console.log(`Successful response for IP ${clientIp}, remaining: ${10 - (count + 1)}`);
        res.json({ response: responseText, remaining: 10 - (count + 1) });
      }
    );
  } catch (error) {
    console.error('Error in /api/gen-spark:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// GET /api/credits
app.get('/api/credits', (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const today = new Date().toISOString().split('T')[0];

  console.log(`Received /api/credits request from IP: ${clientIp}`);

  db.get(
    `SELECT count FROM requests WHERE ip = ? AND date = ?`,
    [clientIp, today],
    (err, row) => {
      if (err) {
        console.error('Database query error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      const count = row ? row.count : 0;
      res.json({ used: count, remaining: 10 - count });
    }
  );
});

// GET /api/history
app.get('/api/history', (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  console.log(`Received /api/history request from IP: ${clientIp}`);

  db.all(
    `SELECT prompt, response, timestamp FROM history WHERE ip = ? ORDER BY timestamp DESC LIMIT 5`,
    [clientIp],
    (err, rows) => {
      if (err) {
        console.error('Database query error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json(rows);
    }
  );
});

// POST /api/reset-counts
app.post('/api/reset-counts', (req, res) => {
  console.log('Received /api/reset-counts request');

  db.run(`DELETE FROM requests`, (err) => {
    if (err) {
      console.error('Error resetting requests:', err);
      return res.status(500).json({ error: 'Failed to reset counts' });
    }
    res.json({ message: 'Request counts reset' });
  });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

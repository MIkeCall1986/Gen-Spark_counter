const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const port = process.env.PORT || 3000;

// Налаштування SQLite
let db;
try {
  db = new sqlite3.Database('gen_spark.db', (err) => {
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
      else console.log('Requests table ready');
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
      else console.log('History table ready');
    });
  });
} catch (err) {
  console.error('Failed to initialize SQLite:', err);
}

// Middleware
app.use(cors({
  origin: 'http://asistant.infy.uk',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));
app.use(express.json());

// Перевірка FIREWORKS_API_KEY
if (!process.env.FIREWORKS_API_KEY) {
  console.error('Error: FIREWORKS_API_KEY is not set in environment variables');
  process.exit(1);
}

// Системний prompt
const systemPrompt = `
Ти — Gen Spark AI, асистент для українського військовослужбовця. 
Надавай чіткі, корисні відповіді українською мовою з акцентом на:
- Військові тактики та безпеку
- Психологічну підтримку
- IT-навички для військових
- Фінансові поради
Будь чемним, підтримуючим та професійним. 
Відповіді мають бути стислими (до 3 речень) та дієвими.
`;

// Перевірка стану сервера
app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.status(200).json({ status: 'OK', message: 'Server is running', sqlite: !!db });
});

// POST /api/gen-spark
app.post('/api/gen-spark', async (req, res) => {
  const { prompt, history = [] } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const today = new Date().toISOString().split('T')[0];

  console.log(`Received /api/gen-spark request from IP: ${clientIp}, prompt: ${prompt}`);

  if (!db) {
    console.error('Database not initialized');
    return res.status(500).json({ error: 'Database not available' });
  }

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
            else console.log('Requests table updated');
          }
        );

        // Формування повідомлень
        const messages = [
          { role: 'system', content: systemPrompt },
          ...history.slice(-3).flatMap(h => {
            try {
              return [
                { role: 'user', content: h.prompt || '' },
                { role: 'assistant', content: h.response || '' }
              ];
            } catch (e) {
              console.error('Error processing history entry:', e);
              return [];
            }
          }),
          { role: 'user', content: prompt || '' }
        ];

        // Запит до Fireworks API
        console.log('Sending request to Fireworks API with model: llama-v3p1-8b-instruct');
        const postData = JSON.stringify({
          model: 'accounts/fireworks/models/llama-v3p1-8b-instruct', // Нова модель
          messages,
          temperature: 0.6,
          max_tokens: 500,
          top_p: 1,
          top_k: 40,
          presence_penalty: 0,
          frequency_penalty: 0
        });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.FIREWORKS_API_KEY}`,
            'Accept': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          },
          body: postData,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorData = await response.text();
          console.error('Fireworks API error:', response.status, errorData);
          throw new Error(`API request failed with status ${response.status}: ${errorData}`);
        }

        const data = await response.json();

        if (!data?.choices?.[0]?.message?.content) {
          console.error('Invalid Fireworks API response structure:', data);
          throw new Error('Invalid response from Fireworks API');
        }

        const responseText = data.choices[0].message.content;

        // Збереження в історію
        db.run(
          `INSERT INTO history (ip, prompt, response, timestamp) VALUES (?, ?, ?, ?)`,
          [clientIp, prompt, responseText, new Date().toISOString()],
          (err) => {
            if (err) console.error('Error inserting into history:', err);
            else console.log('History entry added');
          }
        );

        console.log(`Successful response for IP ${clientIp}, remaining: ${10 - (count + 1)}`);
        res.json({
          response: responseText,
          remaining: 10 - (count + 1),
          model: 'llama-v3p1-8b-instruct'
        });
      }
    );
  } catch (error) {
    console.error('Error in /api/gen-spark:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /api/credits
app.get('/api/credits', (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const today = new Date().toISOString().split('T')[0];

  console.log(`Received /api/credits request from IP: ${clientIp}`);

  if (!db) {
    console.error('Database not initialized');
    return res.status(500).json({ error: 'Database not available' });
  }

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

  if (!db) {
    console.error('Database not initialized');
    return res.status(500).json({ error: 'Database not available' });
  }

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

  if (!db) {
    console.error('Database not initialized');
    return res.status(500).json({ error: 'Database not available' });
  }

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

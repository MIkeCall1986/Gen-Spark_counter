const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const port = process.env.PORT || 3000;

// Налаштування SQLite (залишаємо без змін)
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
      timestamp TEXT)
  `, (err) => {
    if (err) console.error('Error creating history table:', err);
  });
});

// Middleware (залишаємо без змін)
app.use(cors({
  origin: 'http://asistant.infy.uk',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// Перевірка FIREWORKS_API_KEY замість GROK_API_KEY
if (!process.env.FIREWORKS_API_KEY) {
  console.error('Error: FIREWORKS_API_KEY is not set in environment variables');
  process.exit(1);
}

// Оновлений системний prompt для Mistral
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

// Оновлений POST /api/gen-spark для Mistral API
app.post('/api/gen-spark', async (req, res) => {
  const { prompt, history = [] } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const today = new Date().toISOString().split('T')[0];

  console.log(`Received /api/gen-spark request from IP: ${clientIp}, prompt: ${prompt}`);

  try {
    // Перевірка лімітів (залишаємо без змін)
    db.get(`SELECT count FROM requests WHERE ip = ? AND date = ?`,
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

        // Оновлення лічильника (залишаємо без змін)
        db.run(`INSERT OR REPLACE INTO requests (ip, count, date) VALUES (?, ?, ?)`,
          [clientIp, count + 1, today],
          (err) => {
            if (err) console.error('Error updating requests table:', err);
          }
        );

        // Формування повідомлень для Mistral API
        const messages = [
          { role: 'system', content: systemPrompt },
          ...history.slice(-3).flatMap(h => [
            { role: 'user', content: h.prompt || '' },
            { role: 'assistant', content: h.response || '' }
          ]),
          { role: 'user', content: prompt || '' }
        ];

        // Запит до Mistral API через Fireworks
        console.log('Sending request to Mistral API');
        const response = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.FIREWORKS_API_KEY}`,
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            model: 'accounts/fireworks/models/mixtral-8x7b-instruct',
            messages,
            temperature: 0.7,
            max_tokens: 500
          }),
          timeout: 30000 // 30 секунд таймауту
        });

        if (!response.ok) {
          const errorData = await response.text();
          console.error('Mistral API error:', response.status, errorData);
          throw new Error(`API request failed with status ${response.status}`);
        }

        const data = await response.json();
        
        // Перевірка структури відповіді Mistral
        if (!data?.choices?.[0]?.message?.content) {
          console.error('Invalid Mistral API response structure:', data);
          throw new Error('Invalid response from Mistral API');
        }

        const responseText = data.choices[0].message.content;

        // Збереження в історію (залишаємо без змін)
        db.run(`INSERT INTO history (ip, prompt, response, timestamp) VALUES (?, ?, ?, ?)`,
          [clientIp, prompt, responseText, new Date().toISOString()],
          (err) => {
            if (err) console.error('Error inserting into history:', err);
          }
        );

        console.log(`Successful response for IP ${clientIp}, remaining: ${10 - (count + 1)}`);
        res.json({ 
          response: responseText, 
          remaining: 10 - (count + 1),
          model: 'mixtral-8x7b-instruct' // Додаємо інформацію про модель
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

// Решта ендпоінтів залишаються без змін
app.get('/api/credits', (req, res) => { /* ... */ });
app.get('/api/history', (req, res) => { /* ... */ });
app.post('/api/reset-counts', (req, res) => { /* ... */ });

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const port = process.env.PORT || 3000;

// Налаштування SQLite
const db = new sqlite3.Database('gen_spark.db', (err) => {
  if (err) console.error('Database error:', err);
  db.run(`
    CREATE TABLE IF NOT EXISTS requests (
      ip TEXT,
      count INTEGER,
      date TEXT,
      PRIMARY KEY (ip, date)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT,
      prompt TEXT,
      response TEXT,
      timestamp TEXT)
  `);
});

// Точні налаштування CORS
const corsOptions = {
  origin: 'http://asistant.infy.uk',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// Системний prompt для Grok
const systemPrompt = `
Ти — Gen Spark AI, асистент для українського військовослужбовця в зоні бойових дій. 
Ти надаєш короткі, дієві поради щодо:
— військової тактики, виживання, логістики
— фізичного та ментального здоров'я
— самонавчання та IT-напрямків
— фінансового зростання
Відповідай українською, тепло, підтримуюче.
`;

// POST /api/gen-spark
app.post('/api/gen-spark', async (req, res) => {
  const { prompt, history = [] } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const today = new Date().toISOString().split('T')[0];

  // Перевірка лімітів
  db.get(
    `SELECT count FROM requests WHERE ip = ? AND date = ?`,
    [clientIp, today],
    async (err, row) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      const count = row ? row.count : 0;

      if (count >= 10) {
        return res.status(429).json({ error: 'Ліміт 10 запитів на день вичерпано' });
      }

      // Оновлення лічильника
      db.run(
        `INSERT OR REPLACE INTO requests (ip, count, date) VALUES (?, ?, ?)`,
        [clientIp, count + 1, today]
      );

      // Формування запиту до Grok з історією
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-3).map(h => [
          { role: 'user', content: h.prompt },
          { role: 'assistant', content: h.response }
        ]).flat(),
        { role: 'user', content: prompt }
      ];

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
            messages,
          }),
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'Grok API error');

        const responseText = data.choices[0].message.content;

        // Збереження історії
        db.run(
          `INSERT INTO history (ip, prompt, response, timestamp) VALUES (?, ?, ?, ?)`,
          [clientIp, prompt, responseText, new Date().toISOString()]
        );

        res.json({ 
          response: responseText, 
          remaining: 10 - (count + 1),
          historyId: this.lastID
        });
      } catch (error) {
        console.error('Grok API error:', error);
        res.status(500).json({ 
          error: 'Помилка сервера. Спробуйте ще раз.',
          details: process.env.NODE_EN

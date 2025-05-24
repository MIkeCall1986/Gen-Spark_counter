const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const port = process.env.PORT || 3000;

// Підключення до SQLite
const db = new sqlite3.Database(process.env.DATABASE_URL || 'gen_spark.db', (err) => {
  if (err) {
    console.error('Database connection error:', err);
    return;
  }
  console.log('Connected to SQLite database');
  
  // Створення таблиць з обробкою помилок
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS requests (
      ip TEXT,
      count INTEGER,
      date TEXT,
      PRIMARY KEY (ip, date)
    )`, (err) => err && console.error('Requests table error:', err));
    
    db.run(`CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT,
      prompt TEXT,
      response TEXT,
      timestamp TEXT
    )`, (err) => err && console.error('History table error:', err));
  });
});

// Налаштування CORS для Railway
app.use(cors({
  origin: [
    'http://asistant.infy.uk',
    'https://asistant.infy.uk'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());

// Перевірка наявності API ключа
if (!process.env.FIREWORKS_API_KEY) {
  console.error('FIREWORKS_API_KEY is required!');
  process.exit(1);
}

// Оптимізований системний промпт
const systemPrompt = `Ти — Gen Spark AI, асистент для українських військових. Відповідай українською мовою стисло (1-3 речення) на теми:
- Військова тактика та безпека
- Психологічна підтримка
- Корисні IT-навички
- Фінансова грамотність

Будь точним, підтримуючим та професійним.`;

// Глобальні налаштування API
const API_CONFIG = {
  endpoint: 'https://api.fireworks.ai/inference/v1/chat/completions',
  model: 'accounts/fireworks/models/mixtral-8x7b-instruct',
  maxTokens: 300,
  temperature: 0.7
};

// Оптимізований middleware для логування
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path} from ${req.ip}`);
  next();
});

// Головний API endpoint
app.post('/api/gen-spark', async (req, res) => {
  try {
    const { prompt, history = [] } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.ip;
    const today = new Date().toISOString().split('T')[0];

    // Перевірка лімітів
    const { count } = await new Promise((resolve, reject) => {
      db.get(`SELECT count FROM requests WHERE ip = ? AND date = ?`, 
        [clientIp, today], 
        (err, row) => err ? reject(err) : resolve(row || { count: 0 })
      );
    });

    if (count >= 10) {
      return res.status(429).json({ 
        error: 'Ліміт 10 запитів на день вичерпано',
        resetAt: new Date(new Date().setHours(24, 0, 0, 0)).toISOString()
      });
    }

    // Оновлення лічильника
    await new Promise((resolve) => {
      db.run(`INSERT OR REPLACE INTO requests (ip, count, date) VALUES (?, ?, ?)`,
        [clientIp, count + 1, today],
        (err) => err ? console.error('Counter update failed:', err) : resolve()
      );
    });

    // Формування запиту до Mistral
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-3).flatMap(h => [
        { role: 'user', content: h.prompt },
        { role: 'assistant', content: h.response }
      ]),
      { role: 'user', content: prompt }
    ];

    // Виклик Mistral API
    const apiResponse = await fetch(API_CONFIG.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.FIREWORKS_API_KEY}`,
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        model: API_CONFIG.model,
        messages,
        temperature: API_CONFIG.temperature,
        max_tokens: API_CONFIG.maxTokens
      }),
      timeout: 10000
    });

    if (!apiResponse.ok) {
      const error = await apiResponse.json();
      throw new Error(error.message || 'API request failed');
    }

    const { choices } = await apiResponse.json();
    const responseText = choices[0].message.content;

    // Збереження в історію
    db.run(`INSERT INTO history (ip, prompt, response, timestamp) VALUES (?, ?, ?, ?)`,
      [clientIp, prompt, responseText, new Date().toISOString()]
    );

    res.json({
      response: responseText,
      remaining: 10 - (count + 1),
      model: API_CONFIG.model
    });

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: 'Помилка сервера',
      ...(process.env.NODE_ENV === 'development' && { details: error.message })
    });
  }
});

// Інші endpoints (оптимізовані)
app.get('/api/credits', async (req, res) => {
  try {
    const clientIp = req.headers['x-forwarded-for'] || req.ip;
    const today = new Date().toISOString().split('T')[0];
    
    const { count } = await new Promise((resolve) => {
      db.get(`SELECT count FROM requests WHERE ip = ? AND date = ?`, 
        [clientIp, today], 
        (err, row) => resolve(row || { count: 0 })
      );
    });

    res.json({ 
      used: count, 
      remaining: 10 - count,
      limit: 10,
      resetAt: new Date(new Date().setHours(24, 0, 0, 0)).toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const clientIp = req.headers['x-forwarded-for'] || req.ip;
    const history = await new Promise((resolve) => {
      db.all(`SELECT prompt, response, timestamp FROM history 
             WHERE ip = ? ORDER BY timestamp DESC LIMIT 5`,
        [clientIp],
        (err, rows) => resolve(rows || [])
      );
    });
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Health check для Railway
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Обробка помилок
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Using model: ${API_CONFIG.model}`);
});

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { google } = require('googleapis');
const cron = require('node-cron');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'كثير الطلبات'
});
app.use('/webhook', limiter);
app.use('/tasks', limiter);

// DB pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Globals
const OWNER = process.env.OWNER_PHONE || '966557654321';
const WIFE = process.env.WIFE_PHONE || '';
const GREEN_TOKEN = process.env.GREEN_TOKEN || '';
const INSTANCE_ID = process.env.INSTANCE_ID || '';
const CLAUDE_KEY = process.env.CLAUDE_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';

// ──────────────────────────────────────────────────────────────────────────────
// INITIALIZATION
// ──────────────────────────────────────────────────────────────────────────────

async function initDB() {
  try {
    // Tasks table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id BIGSERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        type VARCHAR(20) DEFAULT 'task',
        priority VARCHAR(10) DEFAULT 'normal',
        date TEXT,
        time TEXT,
        done BOOLEAN DEFAULT FALSE,
        column_id BIGINT,
        created_at TIMESTAMP DEFAULT NOW()
      )`);

    // Kanban columns table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kanban_columns (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        color VARCHAR(20) DEFAULT '#1e3a5f',
        created_at TIMESTAMP DEFAULT NOW()
      )`);

    // Settings table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )`);

    // Insert default settings if not exist
    await pool.query(
      "INSERT INTO settings (key,value) VALUES ('busy_mode','false') ON CONFLICT (key) DO NOTHING"
    );

    console.log('✅ Database initialized');
  } catch (e) {
    console.error('❌ DB Init Error:', e.message);
  }
}

initDB();

// ──────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ──────────────────────────────────────────────────────────────────────────────

async function sendMsg(phone, text, type = 'text') {
  try {
    const data = {
      chatId: phone + '@c.us',
      message: text
    };

    if (type === 'image') {
      data.urlFile = text;
    }

    await axios.post(
      `https://api.green-api.com/waInstance${INSTANCE_ID}/sendMessage/${GREEN_TOKEN}`,
      data,
      { timeout: 5000 }
    );
  } catch (e) {
    console.error('Send error:', e.message);
  }
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hour = h % 12 || 12;
  const period = h < 12 ? 'ص' : 'م';
  return `${hour}:${m} ${period}`;
}

// Parse multiple tasks from text
function parseMultipleTasks(text) {
  let tasks = [];

  if (text.includes('\n')) {
    tasks = text.split('\n')
      .map(t => t.trim())
      .filter(t => t.length > 0 && t.length < 200);
  } else if (text.includes(';')) {
    tasks = text.split(';')
      .map(t => t.trim())
      .filter(t => t.length > 0 && t.length < 200);
  } else if (text.includes(',')) {
    tasks = text.split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0 && t.length < 200);
  } else {
    tasks = [text];
  }

  return tasks.filter(t => t && !t.match(/^\d+\s*\.\s*$/) && t.length > 2);
}

// ──────────────────────────────────────────────────────────────────────────────
// WHATSAPP WEBHOOK
// ──────────────────────────────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  res.status(200).send('ok');

  try {
    const body = req.body;
    if (!body.body?.messages?.length) return;

    const msg = body.body.messages[0];
    const senderPhone = msg.senderData?.senderPhone;
    const text = msg.textMessage?.toLowerCase().trim() || '';
    const type = msg.typeMessage;

    if (!senderPhone || !text) return;

    const isOwner = senderPhone === OWNER;
    const isWife = senderPhone === WIFE;

    // Handle voice messages
    if (type === 'audioMessage' && msg.audioMessageData) {
      const audioUrl = msg.audioMessageData.urlFile;
      const transcript = await transcribeAudio(audioUrl);

      if (transcript) {
        await handleOwnerMessage(transcript, senderPhone);
      }
      return;
    }

    // Handle text messages
    if (isOwner) {
      await handleOwnerMessage(text, senderPhone);
    } else if (isWife) {
      await handleWifeMessage(text, senderPhone);
    } else {
      await handleVisitorMessage(text, senderPhone);
    }
  } catch (e) {
    console.error('Webhook error:', e);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// HANDLE OWNER MESSAGES
// ──────────────────────────────────────────────────────────────────────────────

async function handleOwnerMessage(text, phone) {
  try {
    // Add multiple tasks
    if (text.startsWith('add ') || text.startsWith('اضف ')) {
      let tasksText = text.replace(/^(add|اضف)\s+/i, '').trim();

      const tasksList = parseMultipleTasks(tasksText);

      if (tasksList.length === 0) {
        await sendMsg(phone, '❌ اكتب عنوان المهمة');
        return;
      }

      let added = 0;
      let duplicates = 0;
      let failed = 0;

      for (const taskTitle of tasksList) {
        if (taskTitle.length < 3) {
          failed++;
          continue;
        }

        // Check for duplicates
        const dup = await pool.query(
          'SELECT id FROM tasks WHERE LOWER(title) = LOWER($1) AND NOT done',
          [taskTitle]
        );

        if (dup.rows.length > 0) {
          duplicates++;
          continue;
        }

        try {
          await pool.query(
            'INSERT INTO tasks (title, type, date) VALUES ($1, $2, $3)',
            [taskTitle, 'task', todayStr()]
          );
          added++;
        } catch (e) {
          failed++;
        }
      }

      let response = `✅ تم إضافة ${added}`;
      if (duplicates > 0) response += ` | ⚠️ ${duplicates} مكررة`;
      if (failed > 0) response += ` | ❌ ${failed} فشلت`;

      await sendMsg(phone, response);
      return;
    }

    // Register meeting
    if (text.includes('اجتماع') || text.includes('meeting')) {
      let title = text.replace(/اجتماع|meeting/i, '').trim();
      let time = '';

      const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
      if (timeMatch) {
        time = `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`;
        title = title.replace(timeMatch[0], '').trim();
      }

      if (!title) {
        await sendMsg(phone, '❌ اكتب اسم الاجتماع (مثل: اجتماع احمد 3:00 م)');
        return;
      }

      // Check for duplicates
      const dup = await pool.query(
        `SELECT id FROM tasks 
         WHERE type = 'meeting' 
         AND LOWER(title) LIKE LOWER($1)
         AND date = $2
         AND time = $3
         AND NOT done`,
        ['%' + title + '%', todayStr(), time]
      );

      if (dup.rows.length > 0) {
        await sendMsg(phone, '⚠️ الاجتماع مسجل بالفعل');
        return;
      }

      await pool.query(
        'INSERT INTO tasks (title, type, date, time) VALUES ($1, $2, $3, $4)',
        [title, 'meeting', todayStr(), time]
      );

      const timeStr = time ? ` - ${fmt12(time)}` : '';
      await sendMsg(phone, `✅ اجتماع: ${title}${timeStr}`);
      return;
    }

    // Delete last task
    if (text === 'حذف' || text === 'undo') {
      const last = await pool.query(
        'SELECT id, title FROM tasks ORDER BY created_at DESC LIMIT 1'
      );

      if (!last.rows.length) {
        await sendMsg(phone, '❌ لا توجد مهام لحذفها');
        return;
      }

      await pool.query('DELETE FROM tasks WHERE id = $1', [last.rows[0].id]);
      await sendMsg(phone, `🗑 تم حذف: ${last.rows[0].title}`);
      return;
    }

    // Show tasks
    if (text === 'مهام' || text === 'tasks') {
      const tasks = await pool.query(
        `SELECT * FROM tasks 
         WHERE NOT done 
         AND date >= $1 
         ORDER BY date ASC, time ASC 
         LIMIT 10`,
        [todayStr()]
      );

      if (!tasks.rows.length) {
        await sendMsg(phone, '✅ لا توجد مهام متبقية');
        return;
      }

      let msg = '📋 *المهام*:\n\n';
      tasks.rows.forEach((t, i) => {
        msg += `${i + 1}. *${t.title}*\n`;
        if (t.date) msg += `   📅 ${t.date}`;
        if (t.time) msg += ` ${fmt12(t.time)}`;
        msg += '\n\n';
      });

      await sendMsg(phone, msg);
      return;
    }

    // Default help message
    await sendMsg(phone, '📝 أوامر: add/اضف، اجتماع، حذف، مهام');

  } catch (e) {
    console.error('Owner message error:', e);
    await sendMsg(phone, '❌ خطأ: ' + e.message);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// HANDLE WIFE MESSAGES
// ──────────────────────────────────────────────────────────────────────────────

async function handleWifeMessage(text, phone) {
  try {
    await sendMsg(OWNER, `💬 *من الزوجة*:\n${text}`);
    await sendMsg(phone, '✅ تم التسجيل');
  } catch (e) {
    console.error('Wife message error:', e);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// HANDLE VISITOR MESSAGES
// ──────────────────────────────────────────────────────────────────────────────

async function handleVisitorMessage(text, phone) {
  try {
    await sendMsg(phone, '👋 شكراً على التواصل. سيتم الرد عليك قريباً.');
  } catch (e) {
    console.error('Visitor message error:', e);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// TRANSCRIBE AUDIO (PLACEHOLDER)
// ──────────────────────────────────────────────────────────────────────────────

async function transcribeAudio(audioUrl) {
  try {
    // Placeholder - will be implemented with Whisper API
    return null;
  } catch (e) {
    console.error('Transcribe error:', e);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// REST API - TASKS
// ──────────────────────────────────────────────────────────────────────────────

app.get('/tasks', async (req, res) => {
  try {
    const tasks = await pool.query(
      'SELECT * FROM tasks ORDER BY date DESC, time DESC'
    );
    res.json(tasks.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/tasks', async (req, res) => {
  try {
    const { title, type, priority, date, time, done, column_id } = req.body;

    const result = await pool.query(
      'INSERT INTO tasks (title, type, priority, date, time, done, column_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [title, type || 'task', priority || 'normal', date, time, done || false, column_id || null]
    );

    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, done, priority, date, time, column_id } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (title !== undefined) {
      updates.push(`title = $${paramCount++}`);
      values.push(title);
    }
    if (done !== undefined) {
      updates.push(`done = $${paramCount++}`);
      values.push(done);
    }
    if (priority !== undefined) {
      updates.push(`priority = $${paramCount++}`);
      values.push(priority);
    }
    if (date !== undefined) {
      updates.push(`date = $${paramCount++}`);
      values.push(date);
    }
    if (time !== undefined) {
      updates.push(`time = $${paramCount++}`);
      values.push(time);
    }
    if (column_id !== undefined) {
      updates.push(`column_id = $${paramCount++}`);
      values.push(column_id);
    }

    if (!updates.length) {
      return res.json({ error: 'nothing to update' });
    }

    values.push(id);

    const result = await pool.query(
      `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    res.json(result.rows[0] || { error: 'not found' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/tasks/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// KANBAN ENDPOINTS
// ──────────────────────────────────────────────────────────────────────────────

app.get('/kanban/columns', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.id, c.name, c.color, c.created_at,
             json_agg(json_build_object('id', t.id, 'title', t.title, 'date', t.date, 'done', t.done, 'time', t.time)) 
             FILTER (WHERE t.id IS NOT NULL) as cards
      FROM kanban_columns c
      LEFT JOIN tasks t ON t.column_id = c.id
      GROUP BY c.id, c.name, c.color, c.created_at
      ORDER BY c.created_at ASC
    `);
    
    // Format response - kanban_columns might return null cards, replace with empty array
    const formatted = result.rows.map(col => ({
      ...col,
      cards: col.cards || []
    }));
    
    res.json(formatted);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/kanban/columns', async (req, res) => {
  try {
    const { name, color } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const result = await pool.query(
      'INSERT INTO kanban_columns (name, color) VALUES ($1, $2) RETURNING *',
      [name, color || '#1e3a5f']
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/kanban/columns/:id', async (req, res) => {
  try {
    const { name, color } = req.body;
    const { id } = req.params;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (color !== undefined) {
      updates.push(`color = $${paramCount++}`);
      values.push(color);
    }

    if (!updates.length) {
      return res.json({ error: 'nothing to update' });
    }

    values.push(id);

    const result = await pool.query(
      `UPDATE kanban_columns SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    res.json(result.rows[0] || { error: 'not found' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/kanban/columns/:id', async (req, res) => {
  try {
    // Delete associated tasks first
    await pool.query('DELETE FROM tasks WHERE column_id = $1', [req.params.id]);
    // Then delete the column
    await pool.query('DELETE FROM kanban_columns WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/kanban/cards', async (req, res) => {
  try {
    const { column_id, title, date, time } = req.body;

    if (!column_id || !title) {
      return res.status(400).json({ error: 'column_id and title are required' });
    }

    const result = await pool.query(
      'INSERT INTO tasks (title, date, time, column_id, type) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [title, date || null, time || null, column_id, 'task']
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/kanban/cards/:id', async (req, res) => {
  try {
    const { column_id, done } = req.body;
    const { id } = req.params;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (column_id !== undefined) {
      updates.push(`column_id = $${paramCount++}`);
      values.push(column_id);
    }
    if (done !== undefined) {
      updates.push(`done = $${paramCount++}`);
      values.push(done);
    }

    if (!updates.length) {
      return res.json({ error: 'nothing to update' });
    }

    values.push(id);

    const result = await pool.query(
      `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    res.json(result.rows[0] || { error: 'not found' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/kanban/cards/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// SERVE PAGES
// ──────────────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/kanban', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kanban_professional.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ──────────────────────────────────────────────────────────────────────────────
// HTTPS REDIRECT (Production only)
// ──────────────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !req.secure && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect('https://' + req.headers.host + req.url);
  }
  next();
});

// ──────────────────────────────────────────────────────────────────────────────
// SECURITY HEADERS
// ──────────────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Content-Security-Policy', "default-src 'self' https://fonts.googleapis.com https://cdnjs.cloudflare.com; script-src 'self'");
  next();
});

// ──────────────────────────────────────────────────────────────────────────────
// ERROR HANDLING
// ──────────────────────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ──────────────────────────────────────────────────────────────────────────────
// START SERVER
// ──────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  ✅ Server running on port ${PORT}       ║
║  📊 Dashboard: http://localhost:${PORT}  ║
║  🎨 Kanban: http://localhost:${PORT}/kanban  ║
╚════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

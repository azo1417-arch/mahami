require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const path = require('path');
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

const VACATION_DAYS = [5];
const PERSONAL_TAGS = ['شخصي', 'personal', 'عائلة', 'family', 'صحة', 'health'];

// ──────────────────────────────────────────────────────────────────────────────
// TIMEZONE - توقيت الرياض
// ──────────────────────────────────────────────────────────────────────────────

function getRiyadhDate() {
  const options = { timeZone: 'Asia/Riyadh' };
  return new Date(new Date().toLocaleString('en-US', options));
}

function getRiyadhDateStr() {
  const d = getRiyadhDate();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function getRiyadhDay() {
  return getRiyadhDate().getDay();
}

function getRiyadhTimeStr() {
  const d = getRiyadhDate();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// ──────────────────────────────────────────────────────────────────────────────
// INITIALIZATION
// ──────────────────────────────────────────────────────────────────────────────

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id BIGSERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        type VARCHAR(20) DEFAULT 'task',
        priority VARCHAR(20) DEFAULT 'medium',
        date TEXT,
        time TEXT,
        done BOOLEAN DEFAULT FALSE,
        column_id BIGINT,
        assignee TEXT,
        tags TEXT,
        is_personal BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS kanban_columns (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        color VARCHAR(20) DEFAULT '#1e3a5f',
        created_at TIMESTAMP DEFAULT NOW()
      )`);

    console.log('✅ Database initialized');
  } catch (e) {
    console.error('❌ DB Init Error:', e.message);
  }
}

initDB();

// ──────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ──────────────────────────────────────────────────────────────────────────────

async function sendMsg(phone, text) {
  try {
    const data = {
      chatId: phone + '@c.us',
      message: text
    };

    await axios.post(
      `https://api.green-api.com/waInstance${INSTANCE_ID}/sendMessage/${GREEN_TOKEN}`,
      data,
      { timeout: 5000 }
    );
  } catch (e) {
    console.error('Send error:', e.message);
  }
}

function generateCSV(tasks) {
  let csv = '\uFEFF';
  csv += 'العنوان,الوصف,الأولوية,التاريخ,الوقت,الحالة,المسؤول,التصنيفات\n';

  tasks.forEach(task => {
    csv += `"${task.title || ''}","${(task.description || '').replace(/"/g, '""')}","${task.priority || 'متوسطة'}","${task.date || ''}","${task.time || ''}","${task.done ? 'منجزة' : 'معلقة'}","${task.assignee || ''}","${task.tags || ''}"\n`;
  });

  return csv;
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

    if (!senderPhone || !text) return;

    const isOwner = senderPhone === OWNER;
    const isWife = senderPhone === WIFE;

    if (isOwner) {
      await handleOwnerMessage(text, senderPhone);
    } else if (isWife) {
      await sendMsg(OWNER, `💬 من الزوجة:\n${text}`);
      await sendMsg(senderPhone, '✅ تم التسجيل');
    }
  } catch (e) {
    console.error('Webhook error:', e);
  }
});

async function handleOwnerMessage(text, phone) {
  try {
    if (text.startsWith('add ') || text.startsWith('اضف ')) {
      let tasksText = text.replace(/^(add|اضف)\s+/i, '').trim();
      const tasksList = tasksText.split(/[\n,;]/).map(t => t.trim()).filter(t => t.length > 2);

      let added = 0;
      for (const title of tasksList) {
        const isPersonal = PERSONAL_TAGS.some(tag => title.toLowerCase().includes(tag.toLowerCase()));
        
        await pool.query(
          'INSERT INTO tasks (title, type, date, priority, is_personal) VALUES ($1, $2, $3, $4, $5)',
          [title, 'task', getRiyadhDateStr(), 'medium', isPersonal]
        );
        added++;
      }

      await sendMsg(phone, `✅ تم إضافة ${added} مهمة`);
      return;
    }

    if (text === 'مهام' || text === 'tasks') {
      const tasks = await pool.query(
        'SELECT * FROM tasks WHERE NOT done AND date = $1 LIMIT 10',
        [getRiyadhDateStr()]
      );

      if (!tasks.rows.length) {
        await sendMsg(phone, '✅ لا توجد مهام');
        return;
      }

      let msg = '📋 المهام:\n\n';
      tasks.rows.forEach((t, i) => {
        const tag = t.is_personal ? '🔒 ' : '📌 ';
        msg += `${i + 1}. ${tag}${t.title}\n`;
      });

      await sendMsg(phone, msg);
    }
  } catch (e) {
    console.error('Message error:', e);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// REST API - TASKS
// ──────────────────────────────────────────────────────────────────────────────

app.get('/tasks', async (req, res) => {
  try {
    const tasks = await pool.query('SELECT * FROM tasks ORDER BY date DESC, time DESC');
    res.json(tasks.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/tasks', async (req, res) => {
  try {
    const { title, description, priority, date, time, assignee, tags, column_id } = req.body;

    const isPersonal = PERSONAL_TAGS.some(tag => 
      title.toLowerCase().includes(tag.toLowerCase()) || 
      tags?.toLowerCase().includes(tag.toLowerCase())
    );

    const result = await pool.query(
      'INSERT INTO tasks (title, description, priority, date, time, assignee, tags, column_id, is_personal) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
      [title, description || null, priority || 'medium', date, time, assignee, tags, column_id || null, isPersonal]
    );

    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, done, priority, date, time, assignee, tags, column_id } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (title !== undefined) { updates.push(`title = $${paramCount++}`); values.push(title); }
    if (description !== undefined) { updates.push(`description = $${paramCount++}`); values.push(description); }
    if (done !== undefined) { updates.push(`done = $${paramCount++}`); values.push(done); }
    if (priority !== undefined) { updates.push(`priority = $${paramCount++}`); values.push(priority); }
    if (date !== undefined) { updates.push(`date = $${paramCount++}`); values.push(date); }
    if (time !== undefined) { updates.push(`time = $${paramCount++}`); values.push(time); }
    if (assignee !== undefined) { updates.push(`assignee = $${paramCount++}`); values.push(assignee); }
    if (tags !== undefined) { updates.push(`tags = $${paramCount++}`); values.push(tags); }
    if (column_id !== undefined) { updates.push(`column_id = $${paramCount++}`); values.push(column_id); }

    updates.push(`updated_at = NOW()`);

    if (!updates.length) return res.json({ error: 'nothing to update' });

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
// EXPORT ENDPOINTS
// ──────────────────────────────────────────────────────────────────────────────

app.get('/export/csv', async (req, res) => {
  try {
    const tasks = await pool.query('SELECT * FROM tasks ORDER BY date DESC, time DESC');
    const csv = generateCSV(tasks.rows);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="المهام_${getRiyadhDateStr()}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/export/excel', async (req, res) => {
  try {
    const tasks = await pool.query('SELECT * FROM tasks ORDER BY date DESC, time DESC');
    const csv = generateCSV(tasks.rows);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="المهام_${getRiyadhDateStr()}.xlsx"`);
    res.send(csv);
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
             json_agg(json_build_object('id', t.id, 'title', t.title, 'date', t.date, 'done', t.done, 'priority', t.priority)) 
             FILTER (WHERE t.id IS NOT NULL) as cards
      FROM kanban_columns c
      LEFT JOIN tasks t ON t.column_id = c.id
      GROUP BY c.id, c.name, c.color, c.created_at
      ORDER BY c.created_at ASC
    `);

    res.json(result.rows.map(col => ({
      ...col,
      cards: col.cards || []
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/kanban/columns', async (req, res) => {
  try {
    const { name, color } = req.body;
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
    const result = await pool.query(
      'UPDATE kanban_columns SET name = $1 WHERE id = $2 RETURNING *',
      [req.body.name, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/kanban/columns/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE column_id = $1', [req.params.id]);
    await pool.query('DELETE FROM kanban_columns WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/kanban/cards', async (req, res) => {
  try {
    const { column_id, title, date, time } = req.body;
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
    const result = await pool.query(
      `UPDATE tasks SET ${column_id !== undefined ? 'column_id = $1,' : ''}${done !== undefined ? 'done = $' + (column_id !== undefined ? '2' : '1') : ''} WHERE id = $${column_id !== undefined && done !== undefined ? '3' : column_id !== undefined ? '2' : '2'} RETURNING *`,
      [...(column_id !== undefined ? [column_id] : []), ...(done !== undefined ? [done] : []), req.params.id]
    );
    res.json(result.rows[0]);
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
// API: Get current Riyadh time
// ──────────────────────────────────────────────────────────────────────────────

app.get('/api/riyadh-time', (req, res) => {
  res.json({
    date: getRiyadhDateStr(),
    time: getRiyadhTimeStr(),
    day: getRiyadhDay(),
    dayName: ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'][getRiyadhDay()],
    isVacation: VACATION_DAYS.includes(getRiyadhDay()),
    timestamp: getRiyadhDate().getTime()
  });
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
  res.sendFile(path.join(__dirname, 'public', 'kanban.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: getRiyadhDateStr() });
});

// ──────────────────────────────────────────────────────────────────────────────
// SCHEDULED TASKS
// ──────────────────────────────────────────────────────────────────────────────

cron.schedule('0 8 * * *', async () => {
  try {
    const today = getRiyadhDateStr();
    const personalTasks = await pool.query(
      'SELECT * FROM tasks WHERE date = $1 AND NOT done AND is_personal = true',
      [today]
    );

    if (personalTasks.rows.length > 0 && OWNER) {
      let msg = '🔒 المهام الشخصية:\n\n';
      personalTasks.rows.forEach((t, i) => {
        msg += `${i + 1}. ${t.title}\n`;
      });
      await sendMsg(OWNER, msg);
    }
  } catch (e) {
    console.error('Personal tasks error:', e);
  }
});

cron.schedule('0 9 * * *', async () => {
  try {
    if (VACATION_DAYS.includes(getRiyadhDay())) return;

    const today = getRiyadhDateStr();
    const tasks = await pool.query(
      'SELECT * FROM tasks WHERE date = $1 AND NOT done AND is_personal = false',
      [today]
    );

    if (tasks.rows.length > 0 && OWNER) {
      let msg = '📋 تذكير المهام:\n\n';
      tasks.rows.forEach((t, i) => {
        msg += `${i + 1}. ${t.title}\n`;
      });
      await sendMsg(OWNER, msg);
    }
  } catch (e) {
    console.error('Cron error:', e);
  }
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
║  ✅ مهامي - النسخة الذكية             ║
║  🚀 Server running on port ${PORT}      ║
║  📊 Dashboard: /dashboard              ║
║  🎨 Kanban: /kanban                    ║
║  🕒 توقيت الرياض (UTC+3)              ║
╚════════════════════════════════════════╝
  `);
});

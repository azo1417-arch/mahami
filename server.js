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

// أيام الإجازة والأسبوع
const VACATION_DAYS = [5]; // 5 = يوم الجمعة (0=الأحد، 5=الجمعة)
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
    // Tasks table with advanced fields
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

    // Kanban columns
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kanban_columns (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        color VARCHAR(20) DEFAULT '#1e3a5f',
        created_at TIMESTAMP DEFAULT NOW()
      )`);

    // Comments
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id BIGSERIAL PRIMARY KEY,
        task_id BIGINT NOT NULL,
        author TEXT,
        text TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )`);

    // Activity log
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id BIGSERIAL PRIMARY KEY,
        task_id BIGINT,
        action TEXT,
        old_value TEXT,
        new_value TEXT,
        timestamp TIMESTAMP DEFAULT NOW()
      )`);

    // Settings
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
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

async function logActivity(taskId, action, oldVal, newVal) {
  try {
    await pool.query(
      'INSERT INTO activity_log (task_id, action, old_value, new_value) VALUES ($1, $2, $3, $4)',
      [taskId, action, oldVal, newVal]
    );
  } catch (e) {
    console.error('Log error:', e);
  }
}

function isVacationDay() {
  return VACATION_DAYS.includes(getRiyadhDay());
}

function isPersonalTask(task) {
  if (task.is_personal) return true;
  if (!task.tags) return false;
  
  const taskTags = task.tags.toLowerCase().split(',').map(t => t.trim());
  return taskTags.some(tag => PERSONAL_TAGS.some(pTag => tag.includes(pTag.toLowerCase())));
}

// Convert to Excel CSV
function generateCSV(tasks) {
  let csv = '\uFEFF'; // BOM for UTF-8
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
    // Add tasks
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

    // List tasks
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

    await logActivity(result.rows[0].id, 'CREATE', null, `Task: ${title}`);
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, done, priority, date, time, assignee, tags, column_id, is_personal } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (title !== undefined) {
      updates.push(`title = $${paramCount++}`);
      values.push(title);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description);
    }
    if (done !== undefined) {
      updates.push(`done = $${paramCount++}`);
      values.push(done);
      await logActivity(id, 'UPDATE', 'done', done ? 'true' : 'false');
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
    if (assignee !== undefined) {
      updates.push(`assignee = $${paramCount++}`);
      values.push(assignee);
    }
    if (tags !== undefined) {
      updates.push(`tags = $${paramCount++}`);
      values.push(tags);
    }
    if (column_id !== undefined) {
      updates.push(`column_id = $${paramCount++}`);
      values.push(column_id);
    }
    if (is_personal !== undefined) {
      updates.push(`is_personal = $${paramCount++}`);
      values.push(is_personal);
    }

    updates.push(`updated_at = NOW()`);

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
    await logActivity(req.params.id, 'DELETE', null, 'Task deleted');
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

app.post('/export/google-drive', async (req, res) => {
  try {
    // هذا placeholder - يحتاج Google API setup
    const tasks = await pool.query('SELECT * FROM tasks ORDER BY date DESC, time DESC');
    const csv = generateCSV(tasks.rows);

    res.json({
      success: true,
      message: 'جاهز للرفع على Google Drive',
      filename: `المهام_${getRiyadhDateStr()}.csv`,
      data: csv
    });
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
             json_agg(json_build_object('id', t.id, 'title', t.title, 'date', t.date, 'done', t.done, 'priority', t.priority, 'assignee', t.assignee, 'is_personal', t.is_personal)) 
             FILTER (WHERE t.id IS NOT NULL) as cards
      FROM kanban_columns c
      LEFT JOIN tasks t ON t.column_id = c.id
      GROUP BY c.id, c.name, c.color, c.created_at
      ORDER BY c.created_at ASC
    `);

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

    const result = await pool.query(
      'INSERT INTO kanban_columns (name, color) VALUES ($1, $2) RETURNING *',
      [name, color || '#1e3a5f']
    );

    await logActivity(null, 'CREATE_COLUMN', null, name);
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/kanban/columns/:id', async (req, res) => {
  try {
    const { name } = req.body;

    const result = await pool.query(
      'UPDATE kanban_columns SET name = $1 WHERE id = $2 RETURNING *',
      [name, req.params.id]
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

    values.push(req.params.id);

    const result = await pool.query(
      `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
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
    isVacation: isVacationDay(),
    timestamp: getRiyadhDate().getTime()
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// SERVE PAGES
// ──────────────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard_riyadh.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard_riyadh.html'));
});

app.get('/kanban', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kanban_professional.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: getRiyadhDateStr(), vacation: isVacationDay() });
});

// ──────────────────────────────────────────────────────────────────────────────
// SCHEDULED TASKS (توقيت الرياض)
// ──────────────────────────────────────────────────────────────────────────────

// Send reminder for PERSONAL tasks (8 AM Riyadh)
cron.schedule('0 8 * * *', async () => {
  try {
    const today = getRiyadhDateStr();
    const personalTasks = await pool.query(
      'SELECT * FROM tasks WHERE date = $1 AND NOT done AND is_personal = true',
      [today]
    );

    if (personalTasks.rows.length > 0) {
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

// Send reminder for WORK tasks (9 AM Riyadh - NOT on vacation)
cron.schedule('0 9 * * *', async () => {
  try {
    if (isVacationDay()) {
      console.log('🎉 اليوم إجازة - لا تنبيهات دوام');
      return;
    }

    const today = getRiyadhDateStr();
    const tasks = await pool.query(
      'SELECT * FROM tasks WHERE date = $1 AND NOT done AND is_personal = false',
      [today]
    );

    if (tasks.rows.length > 0) {
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

// Send daily report (6 PM Riyadh)
cron.schedule('0 18 * * *', async () => {
  try {
    const yesterday = new Date(getRiyadhDate());
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.getFullYear() + '-' + String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + String(yesterday.getDate()).padStart(2, '0');

    if (isVacationDay()) {
      const personalCompleted = await pool.query(
        'SELECT COUNT(*) as count FROM tasks WHERE done AND is_personal = true AND date >= $1',
        [yesterdayStr]
      );

      const personalPending = await pool.query(
        'SELECT COUNT(*) as count FROM tasks WHERE NOT done AND is_personal = true'
      );

      let msg = `🔒 ملخص المهام الشخصية (الجمعة):\n`;
      msg += `✅ المنجزة: ${personalCompleted.rows[0].count}\n`;
      msg += `⏳ المعلقة: ${personalPending.rows[0].count}\n`;
      msg += `\n🎉 يوم عطلة - استمتع به!`;

      await sendMsg(OWNER, msg);
    } else {
      const completed = await pool.query(
        'SELECT COUNT(*) as count FROM tasks WHERE done AND is_personal = false AND date >= $1',
        [yesterdayStr]
      );

      const pending = await pool.query(
        'SELECT COUNT(*) as count FROM tasks WHERE NOT done AND is_personal = false'
      );

      let msg = `📊 ملخص يومك:\n`;
      msg += `✅ منجزة: ${completed.rows[0].count}\n`;
      msg += `⏳ معلقة: ${pending.rows[0].count}`;

      await sendMsg(OWNER, msg);
    }
  } catch (e) {
    console.error('Report error:', e);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// SECURITY & HEADERS
// ──────────────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

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
║  🔒 تمييز المهام الشخصية              ║
║  📥 تصدير إلى Excel/Drive             ║
╚════════════════════════════════════════╝
  `);
});

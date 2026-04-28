require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { google } = require('googleapis');
const FormData = require('form-data');

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
const ADMIN_CHAT = process.env.ADMIN_CHAT || '';
const GREEN_TOKEN = process.env.GREEN_TOKEN || '';
const INSTANCE_ID = process.env.INSTANCE_ID || '';
const CLAUDE_KEY = process.env.CLAUDE_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';

// ──────────────────────────────────────────────────────────────────────────────
// INITIALIZATION
// ──────────────────────────────────────────────────────────────────────────────

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      type VARCHAR(20) DEFAULT 'task',
      priority VARCHAR(10) DEFAULT 'normal',
      date TEXT,
      time TEXT,
      done BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);
  
  await pool.query(
    "INSERT INTO settings (key,value) VALUES ('busy_mode','false') ON CONFLICT (key) DO NOTHING"
  );
}

initDB().catch(console.error);

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
      data
    );
  } catch (e) {
    console.error('Send error:', e.message);
  }
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function fmt12(t) {
  const [h, m] = t.split(':');
  const hour = h % 12 || 12;
  const period = h < 12 ? 'ص' : 'م';
  return `${hour}:${m} ${period}`;
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

    // ─── معالجة الرسائل الصوتية
    if (type === 'audioMessage' && msg.audioMessageData) {
      const audioUrl = msg.audioMessageData.urlFile;
      const transcript = await transcribeAudio(audioUrl);
      
      if (transcript) {
        await handleOwnerMessage(transcript, senderPhone);
      }
      return;
    }

    // ─── معالجة النصوص
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
// HANDLE OWNER MESSAGES (SMART & AUTO)
// ──────────────────────────────────────────────────────────────────────────────

async function handleOwnerMessage(text, phone) {
  try {
    // ─── إضافة مهمة بسيطة (مباشر — بدون تأكيد)
    if (text.startsWith('add ') || text.startsWith('اضف ')) {
      const title = text.replace(/^(add|اضف)\s+/i, '').trim();
      if (!title) {
        await sendMsg(phone, '❌ اكتب عنوان المهمة');
        return;
      }
      
      const dup = await pool.query(
        'SELECT id FROM tasks WHERE LOWER(title) = LOWER($1) AND NOT done',
        [title]
      );
      
      if (dup.rows.length > 0) {
        await sendMsg(phone, '⚠️ المهمة موجودة مسبقاً');
        return;
      }
      
      await pool.query(
        'INSERT INTO tasks (title, type, date) VALUES ($1, $2, $3)',
        [title, 'task', todayStr()]
      );
      
      await sendMsg(phone, `✅ تم: ${title}`);
      return;
    }

    // ─── تسجيل اجتماع (مباشر — لا يسأل تأكيد)
    if (text.includes('اجتماع') || text.includes('meeting')) {
      let title = text.replace(/اجتماع|meeting/i, '').trim();
      let time = '';
      
      const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
      if (timeMatch) {
        time = `${timeMatch[1].padStart(2,'0')}:${timeMatch[2]}`;
        title = title.replace(timeMatch[0], '').trim();
      }
      
      if (!title) {
        await sendMsg(phone, '❌ اكتب اسم الاجتماع (مثل: اجتماع احمد 3:00 م)');
        return;
      }
      
      // تحقق من عدم التكرار بنفس الوقت والاسم
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

    // ─── حذف آخر مهمة
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

    // ─── عرض المهام
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
        msg += `${i+1}. *${t.title}*\n`;
        if (t.date) msg += `   📅 ${t.date}`;
        if (t.time) msg += ` ${fmt12(t.time)}`;
        msg += '\n\n';
      });
      
      await sendMsg(phone, msg);
      return;
    }

    // ─── رسائل عامة
    await sendMsg(phone, 'أوامر: add/اضف، اجتماع، حذف، مهام');

  } catch (e) {
    console.error('Owner message error:', e);
    await sendMsg(phone, '❌ خطأ: ' + e.message);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// HANDLE WIFE MESSAGES
// ──────────────────────────────────────────────────────────────────────────────

async function handleWifeMessage(text, phone) {
  // أرسل كل رسائل الزوجة مباشرة للمالك
  await sendMsg(OWNER, `💬 *من الزوجة*:\n${text}`);
  await sendMsg(phone, '✅ تم التسجيل');
}

// ──────────────────────────────────────────────────────────────────────────────
// HANDLE VISITOR MESSAGES
// ──────────────────────────────────────────────────────────────────────────────

async function handleVisitorMessage(text, phone) {
  await sendMsg(phone, '👋 شكراً على التواصل. سيتم الرد عليك قريباً.');
}

// ──────────────────────────────────────────────────────────────────────────────
// TRANSCRIBE AUDIO (FUTURE)
// ──────────────────────────────────────────────────────────────────────────────

async function transcribeAudio(audioUrl) {
  try {
    // سيتم إضافة Whisper API لاحقاً
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
    const { title, type, priority, date, time, done } = req.body;
    
    const result = await pool.query(
      'INSERT INTO tasks (title, type, priority, date, time, done) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [title, type || 'task', priority || 'normal', date, time, done || false]
    );
    
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, done, priority, date, time } = req.body;
    
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
// SERVE DASHBOARDS
// ──────────────────────────────────────────────────────────────────────────────

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/kanban', (req, res) => {
  res.sendFile(path.join(__dirname, 'kanban.html'));
});

// ──────────────────────────────────────────────────────────────────────────────
// HTTPS REDIRECT
// ──────────────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !req.secure) {
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
  res.setHeader('Content-Security-Policy', "default-src 'self' https://fonts.googleapis.com https://cdnjs.cloudflare.com");
  next();
});

// ──────────────────────────────────────────────────────────────────────────────
// START SERVER
// ──────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

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

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: 'كثير الطلبات' });
app.use('/webhook', limiter);
app.use('/tasks', limiter);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const OWNER       = process.env.OWNER_PHONE    || '966557654321';
const WIFE        = process.env.WIFE_PHONE      || '';
const GREEN_TOKEN = process.env.GREEN_TOKEN     || '';
const INSTANCE_ID = process.env.INSTANCE_ID     || '';
const CLAUDE_KEY  = process.env.CLAUDE_API_KEY  || '';

// ── حالة الاجتماع المعلّق (لطلب مصدر/بحث)
let pendingMeeting = null; // { title, time, date }

// ──────────────────────────────────────────────────────────────────────────────
// TIMEZONE - الرياض
// ──────────────────────────────────────────────────────────────────────────────

function rDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
}

function todayStr() {
  const d = rDate();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function nowHHMM() {
  const d = rDate();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function rDay() { return rDate().getDay(); } // 0=أحد 5=جمعة

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h < 12 ? 'ص' : 'م'}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// DB INIT
// ──────────────────────────────────────────────────────────────────────────────

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          BIGSERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      type        VARCHAR(20)  DEFAULT 'task',
      priority    VARCHAR(10)  DEFAULT 'normal',
      date        TEXT,
      time        TEXT,
      done        BOOLEAN      DEFAULT FALSE,
      created_at  TIMESTAMP    DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS meetings (
      id          BIGSERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      date        TEXT,
      time        TEXT,
      source      TEXT,
      notes       TEXT,
      done        BOOLEAN   DEFAULT FALSE,
      created_at  TIMESTAMP DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )`);

  await pool.query(
    "INSERT INTO settings (key,value) VALUES ('busy_mode','false') ON CONFLICT (key) DO NOTHING"
  );

  console.log('✅ Database initialized');
}

initDB().catch(console.error);

// ──────────────────────────────────────────────────────────────────────────────
// SEND WHATSAPP
// ──────────────────────────────────────────────────────────────────────────────

async function sendMsg(phone, text) {
  try {
    await axios.post(
      `https://api.green-api.com/waInstance${INSTANCE_ID}/sendMessage/${GREEN_TOKEN}`,
      { chatId: phone + '@c.us', message: text },
      { timeout: 8000 }
    );
  } catch (e) {
    console.error('Send error:', e.message);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// CLAUDE - ذكاء اصطناعي
// ──────────────────────────────────────────────────────────────────────────────

async function askClaude(systemPrompt, userMsg) {
  if (!CLAUDE_KEY) return null;
  try {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5',
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }]
      },
      {
        headers: {
          'x-api-key': CLAUDE_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: 15000
      }
    );
    return res.data.content[0].text.trim();
  } catch (e) {
    console.error('Claude error:', e.message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// WEBHOOK
// ──────────────────────────────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  res.status(200).send('ok');
  try {
    const body = req.body;
    if (!body.body?.messages?.length) return;

    const msg         = body.body.messages[0];
    const senderPhone = msg.senderData?.senderPhone;
    const rawText     = msg.textMessage || '';
    const text        = rawText.trim();

    if (!senderPhone || !text) return;

    if (senderPhone === OWNER)      await handleOwner(text, senderPhone);
    else if (senderPhone === WIFE)  await handleWife(text, senderPhone);
    else                            await sendMsg(senderPhone, '👋 شكراً على التواصل. سيتم الرد قريباً.');
  } catch (e) {
    console.error('Webhook error:', e);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// HANDLE OWNER
// ──────────────────────────────────────────────────────────────────────────────

async function handleOwner(text, phone) {
  const t = text.toLowerCase().trim();

  // ── إذا فيه اجتماع معلّق ينتظر رد
  if (pendingMeeting) {
    await handleMeetingSourceReply(text, phone);
    return;
  }

  // ── إضافة مهمة
  if (t.startsWith('add ') || t.startsWith('اضف ')) {
    const title = text.replace(/^(add|اضف)\s+/i, '').trim();
    if (!title) { await sendMsg(phone, '❌ اكتب عنوان المهمة'); return; }

    const dup = await pool.query(
      'SELECT id FROM tasks WHERE LOWER(title)=LOWER($1) AND NOT done', [title]
    );
    if (dup.rows.length) { await sendMsg(phone, '⚠️ المهمة موجودة مسبقاً'); return; }

    await pool.query(
      'INSERT INTO tasks (title,type,date) VALUES ($1,$2,$3)',
      [title, 'task', todayStr()]
    );
    await sendMsg(phone, `✅ تم: ${title}`);
    return;
  }

  // ── تسجيل اجتماع
  if (t.includes('اجتماع') || t.includes('meeting')) {
    let title = text.replace(/اجتماع|meeting/ig, '').trim();
    let time  = '';

    const tm = text.match(/(\d{1,2}):(\d{2})/);
    if (tm) {
      time  = `${tm[1].padStart(2,'0')}:${tm[2]}`;
      title = title.replace(tm[0], '').trim();
    }

    // كشف صباحاً/مساءً
    if (text.includes('مساء') || text.includes('م') && time) {
      const [h, m] = time.split(':').map(Number);
      if (h < 12) time = `${h + 12}:${String(m).padStart(2,'0')}`;
    }

    if (!title) { await sendMsg(phone, '❌ اكتب اسم الاجتماع'); return; }

    const dup = await pool.query(
      `SELECT id FROM meetings WHERE LOWER(title) LIKE LOWER($1) AND date=$2 AND time=$3 AND NOT done`,
      [`%${title}%`, todayStr(), time]
    );
    if (dup.rows.length) { await sendMsg(phone, '⚠️ الاجتماع مسجل بالفعل'); return; }

    // احفظ مؤقتاً وسأل عن المصدر
    pendingMeeting = { title, time, date: todayStr() };

    const timeStr = time ? ` الساعة ${fmt12(time)}` : '';
    await sendMsg(phone,
      `✅ اجتماع *${title}*${timeStr}\n\n` +
      `هل تبي أبحث لك عن مصدر أو ملف معين قبل الاجتماع؟\n` +
      `- اكتب *اسم المصدر أو الموضوع*\n` +
      `- أو *لا* للمتابعة بدون`
    );
    return;
  }

  // ── عرض المهام
  if (t === 'مهام' || t === 'tasks') {
    const tasks = await pool.query(
      `SELECT * FROM tasks WHERE NOT done AND date >= $1 ORDER BY date,time LIMIT 10`,
      [todayStr()]
    );
    if (!tasks.rows.length) { await sendMsg(phone, '✅ لا توجد مهام متبقية'); return; }

    let msg = '📋 *مهامك اليوم:*\n\n';
    tasks.rows.forEach((t, i) => {
      const p = t.priority === 'high' ? '🔴 ' : t.priority === 'low' ? '🟢 ' : '🟡 ';
      msg += `${i+1}. ${p}*${t.title}*`;
      if (t.time) msg += ` — ${fmt12(t.time)}`;
      msg += '\n';
    });

    await sendMsg(phone, msg);
    return;
  }

  // ── إنجاز مهمة
  if (t.startsWith('خلص ') || t.startsWith('done ')) {
    const keyword = text.replace(/^(خلص|done)\s+/i, '').trim();
    const task = await pool.query(
      `SELECT id,title FROM tasks WHERE LOWER(title) LIKE LOWER($1) AND NOT done LIMIT 1`,
      [`%${keyword}%`]
    );
    if (!task.rows.length) { await sendMsg(phone, '❌ ما لقيت المهمة'); return; }
    await pool.query('UPDATE tasks SET done=true WHERE id=$1', [task.rows[0].id]);
    await sendMsg(phone, `✅ أنجزت: ${task.rows[0].title}`);
    return;
  }

  // ── حذف آخر مهمة
  if (t === 'حذف' || t === 'undo') {
    const last = await pool.query('SELECT id,title FROM tasks ORDER BY created_at DESC LIMIT 1');
    if (!last.rows.length) { await sendMsg(phone, '❌ لا توجد مهام'); return; }
    await pool.query('DELETE FROM tasks WHERE id=$1', [last.rows[0].id]);
    await sendMsg(phone, `🗑 تم حذف: ${last.rows[0].title}`);
    return;
  }

  // ── تفويض مهمة للذكاء الاصطناعي (أي شي ثاني)
  const reply = await askClaude(
    `أنت نواف، مساعد شخصي ذكي لعبدالعزيز مدير إداري في الرياض.
قواعد صارمة:
- تجاوب دائماً على اللي يقوله عبدالعزيز الآن، مو على موضوع سابق.
- لو سألك سؤال جديد أو غير الموضوع، امشي معه فوراً.
- ردودك قصيرة ومباشرة، بالنجدية الواضحة.
- لا تكرر السؤال عليه ولا تعلق على صياغته.
- لا تستخدم: ينطيك، بخبر، كيفك، شلونك.`,
    text
  );

  if (reply) {
    await sendMsg(phone, reply);
  } else {
    await sendMsg(phone, 'أوامر: اضف، اجتماع، مهام، خلص، حذف');
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// HANDLE MEETING SOURCE REPLY
// ──────────────────────────────────────────────────────────────────────────────

async function handleMeetingSourceReply(text, phone) {
  const t = text.toLowerCase().trim();
  const meeting = pendingMeeting;
  pendingMeeting = null; // امسح الحالة فوراً

  // احفظ الاجتماع في DB
  await pool.query(
    'INSERT INTO meetings (title,date,time,source) VALUES ($1,$2,$3,$4)',
    [meeting.title, meeting.date, meeting.time, t === 'لا' || t === 'no' ? null : text]
  );

  // كذلك في tasks عشان يظهر في الداشبورد
  await pool.query(
    'INSERT INTO tasks (title,type,date,time) VALUES ($1,$2,$3,$4)',
    [meeting.title, 'meeting', meeting.date, meeting.time]
  );

  if (t === 'لا' || t === 'no') {
    const timeStr = meeting.time ? ` الساعة ${fmt12(meeting.time)}` : '';
    await sendMsg(phone, `✅ تمام، اجتماع *${meeting.title}*${timeStr} مسجل`);
    return;
  }

  // بحث بالذكاء الاصطناعي
  await sendMsg(phone, `🔍 أبحث في *${text}*...`);

  const searchResult = await askClaude(
    `أنت نواف. ابحث وجهّز ملخصاً مفيداً عن الموضوع التالي قبل اجتماع عبدالعزيز.
الاجتماع: ${meeting.title}
المصدر المطلوب: ${text}
اعطه أهم 3 نقاط يحتاجها في الاجتماع، بشكل مختصر وعملي.`,
    `جهّز لي ملخص سريع عن: ${text} — لاجتماع ${meeting.title}`
  );

  if (searchResult) {
    const timeStr = meeting.time ? ` الساعة ${fmt12(meeting.time)}` : '';
    await sendMsg(phone,
      `📋 *ملخص لاجتماع ${meeting.title}*${timeStr}\n\n${searchResult}`
    );
  } else {
    await sendMsg(phone, `✅ تم تسجيل الاجتماع مع مصدر: ${text}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// HANDLE WIFE
// ──────────────────────────────────────────────────────────────────────────────

async function handleWife(text, phone) {
  await sendMsg(OWNER, `💬 *من الزوجة:*\n${text}`);
  await sendMsg(phone, '✅ تم');
}

// ──────────────────────────────────────────────────────────────────────────────
// MORNING BRIEFING - 9:00 ص (إلا الجمعة)
// ──────────────────────────────────────────────────────────────────────────────

cron.schedule('0 9 * * 0,1,2,3,4,6', async () => {
  // 0=أحد 1=اثنين 2=ثلاثاء 3=أربعاء 4=خميس 5=جمعة(محذوف) 6=سبت
  try {
    const today = todayStr();
    const tasks = await pool.query(
      `SELECT * FROM tasks WHERE NOT done AND date = $1 ORDER BY time ASC NULLS LAST`,
      [today]
    );

    const meetings = await pool.query(
      `SELECT * FROM meetings WHERE NOT done AND date = $1 ORDER BY time ASC`,
      [today]
    );

    if (!tasks.rows.length && !meetings.rows.length) {
      await sendMsg(OWNER, '☀️ صباح الخير عبدالعزيز — يومك خالي من المهام، استغله صح!');
      return;
    }

    // اختر المهمة الأهم (أولوية أو وقت)
    const topTask = tasks.rows.find(t => t.priority === 'high') || tasks.rows[0];

    let msg = `☀️ *صباح الخير عبدالعزيز*\n\n`;

    if (topTask) {
      msg += `🎯 *مهمتك الأهم اليوم:*\n${topTask.title}`;
      if (topTask.time) msg += ` — ${fmt12(topTask.time)}`;
      msg += '\n\n';
    }

    if (tasks.rows.length > 1) {
      msg += `📋 *باقي مهامك (${tasks.rows.length - 1}):*\n`;
      tasks.rows.slice(1, 4).forEach((t, i) => {
        msg += `${i+1}. ${t.title}`;
        if (t.time) msg += ` — ${fmt12(t.time)}`;
        msg += '\n';
      });
      if (tasks.rows.length > 4) msg += `...و${tasks.rows.length - 4} أخرى\n`;
      msg += '\n';
    }

    if (meetings.rows.length) {
      msg += `📅 *اجتماعاتك اليوم:*\n`;
      meetings.rows.forEach(m => {
        msg += `• ${m.title}`;
        if (m.time) msg += ` — ${fmt12(m.time)}`;
        msg += '\n';
      });
    }

    await sendMsg(OWNER, msg);
  } catch (e) {
    console.error('Morning briefing error:', e);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// END OF DAY SUMMARY - 5:55 م (إلا الجمعة)
// ──────────────────────────────────────────────────────────────────────────────

cron.schedule('55 17 * * 0,1,2,3,4,6', async () => {
  try {
    const today = todayStr();

    const done = await pool.query(
      `SELECT COUNT(*) as c FROM tasks WHERE done AND date = $1`, [today]
    );
    const pending = await pool.query(
      `SELECT * FROM tasks WHERE NOT done AND date = $1 ORDER BY priority DESC`, [today]
    );

    const doneCount = parseInt(done.rows[0].c);
    let msg = `🌅 *ملخص يومك عبدالعزيز*\n\n`;
    msg += `✅ أنجزت: *${doneCount}* مهمة\n`;

    if (pending.rows.length) {
      msg += `⏳ متبقي: *${pending.rows.length}*\n\n`;
      msg += `📌 *اللي ما خلص:*\n`;
      pending.rows.slice(0, 5).forEach((t, i) => {
        msg += `${i+1}. ${t.title}\n`;
      });

      // لو فيه مهام معلقة - سؤال واحد
      if (pending.rows.length > 0) {
        msg += `\nتبي تنقلها لبكره؟ رد *نعم* أو *لا*`;
      }
    } else {
      msg += `\n🎉 خلصت كل شي — يوم ممتاز!`;
    }

    await sendMsg(OWNER, msg);
  } catch (e) {
    console.error('End of day error:', e);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// MEETING PRE-BRIEF - 10 دقائق قبل كل اجتماع
// ──────────────────────────────────────────────────────────────────────────────

cron.schedule('* * * * *', async () => {
  try {
    const now  = nowHHMM();
    const d    = rDate();
    const in10 = new Date(d.getTime() + 10 * 60 * 1000);
    const hh   = String(in10.getHours()).padStart(2,'0');
    const mm   = String(in10.getMinutes()).padStart(2,'0');
    const target = `${hh}:${mm}`;

    const meetings = await pool.query(
      `SELECT * FROM meetings WHERE date=$1 AND time=$2 AND NOT done`,
      [todayStr(), target]
    );

    for (const m of meetings.rows) {
      let msg = `⏰ *تنبيه اجتماع خلال 10 دقائق*\n\n📅 ${m.title} — ${fmt12(m.time)}`;

      if (m.source) {
        msg += `\n\n📌 المصدر: ${m.source}`;
      }

      if (m.notes) {
        msg += `\n📝 ${m.notes}`;
      }

      await sendMsg(OWNER, msg);
    }
  } catch (e) {
    console.error('Meeting prebriefing error:', e);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// LATE TASK REMINDER - الأسبوعي يوم الخميس 10 ص
// ──────────────────────────────────────────────────────────────────────────────

cron.schedule('0 10 * * 4', async () => {
  try {
    const tasks = await pool.query(
      `SELECT *, (CURRENT_DATE - date::date) as days_old 
       FROM tasks 
       WHERE NOT done AND date < $1
       ORDER BY days_old DESC LIMIT 5`,
      [todayStr()]
    );

    if (!tasks.rows.length) return;

    let msg = `📋 *مهام متأخرة — خذ نظرة*\n\n`;
    tasks.rows.forEach((t, i) => {
      const days = t.days_old;
      const note = days > 7 ? `(${days} يوم — تحتاج قرار)` : `(${days} أيام)`;
      msg += `${i+1}. ${t.title} ${note}\n`;
    });

    await sendMsg(OWNER, msg);
  } catch (e) {
    console.error('Late tasks error:', e);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// REST API - TASKS
// ──────────────────────────────────────────────────────────────────────────────

app.get('/tasks', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM tasks ORDER BY date DESC, time DESC');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/tasks', async (req, res) => {
  try {
    const { title, type, priority, date, time, done } = req.body;
    const r = await pool.query(
      'INSERT INTO tasks (title,type,priority,date,time,done) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [title, type||'task', priority||'normal', date, time, done||false]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, done, priority, date, time } = req.body;
    const updates = [], values = [];
    let p = 1;
    if (title    !== undefined) { updates.push(`title=$${p++}`);    values.push(title); }
    if (done     !== undefined) { updates.push(`done=$${p++}`);     values.push(done); }
    if (priority !== undefined) { updates.push(`priority=$${p++}`); values.push(priority); }
    if (date     !== undefined) { updates.push(`date=$${p++}`);     values.push(date); }
    if (time     !== undefined) { updates.push(`time=$${p++}`);     values.push(time); }
    if (!updates.length) return res.json({ error: 'nothing' });
    values.push(id);
    const r = await pool.query(`UPDATE tasks SET ${updates.join(',')} WHERE id=$${p} RETURNING *`, values);
    res.json(r.rows[0] || { error: 'not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/tasks/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ──────────────────────────────────────────────────────────────────────────────
// KANBAN
// ──────────────────────────────────────────────────────────────────────────────

app.get('/kanban/columns', async (req, res) => {
  try {
    const cols = await pool.query(`
      SELECT c.id, c.name, c.color, c.created_at,
        json_agg(json_build_object('id',t.id,'title',t.title,'date',t.date,'done',t.done,'priority',t.priority,'assignee',t.assignee))
        FILTER (WHERE t.id IS NOT NULL) as cards
      FROM kanban_columns c
      LEFT JOIN tasks t ON t.column_id = c.id
      GROUP BY c.id ORDER BY c.created_at ASC
    `);
    res.json(cols.rows.map(c => ({ ...c, cards: c.cards || [] })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/kanban/columns', async (req, res) => {
  try {
    const r = await pool.query(
      'INSERT INTO kanban_columns (name,color) VALUES ($1,$2) RETURNING *',
      [req.body.name, req.body.color || '#2c5aa0']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/kanban/columns/:id', async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE kanban_columns SET name=$1 WHERE id=$2 RETURNING *',
      [req.body.name, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/kanban/columns/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE column_id=$1', [req.params.id]);
    await pool.query('DELETE FROM kanban_columns WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/kanban/cards', async (req, res) => {
  try {
    const { column_id, title, date, time, priority, assignee } = req.body;
    const r = await pool.query(
      'INSERT INTO tasks (title,date,time,column_id,type,priority,assignee) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [title, date||null, time||null, column_id, 'task', priority||'medium', assignee||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/kanban/cards/:id', async (req, res) => {
  try {
    const { column_id, done } = req.body;
    const updates = [], values = [];
    let p = 1;
    if (column_id !== undefined) { updates.push(`column_id=$${p++}`); values.push(column_id); }
    if (done      !== undefined) { updates.push(`done=$${p++}`);      values.push(done); }
    if (!updates.length) return res.json({ error: 'nothing' });
    values.push(req.params.id);
    const r = await pool.query(`UPDATE tasks SET ${updates.join(',')} WHERE id=$${p} RETURNING *`, values);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/kanban/cards/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ──────────────────────────────────────────────────────────────────────────────
// EXPORT
// ──────────────────────────────────────────────────────────────────────────────

app.post('/export/google-drive', async (req, res) => {
  try {
    res.json({ success: true, message: 'جاهز للرفع' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ──────────────────────────────────────────────────────────────────────────────
// PAGES
// ──────────────────────────────────────────────────────────────────────────────

app.get('/',          (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/kanban',    (req, res) => res.sendFile(path.join(__dirname, 'kanban.html')));
app.get('/health',    (req, res) => res.json({ status: 'ok', time: nowHHMM(), date: todayStr() }));

// ──────────────────────────────────────────────────────────────────────────────
// START
// ──────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║  ✅ نواف — نسخة متقدمة               ║
║  📊 /dashboard                        ║
║  🕒 توقيت الرياض                     ║
║  ☀️  تذكير 9 ص (إلا الجمعة)          ║
║  🌅  ملخص 5:55 م                     ║
║  📅  تنبيه اجتماع قبل 10 دقائق       ║
║  🧠  يمشي مع المستخدم                ║
╚═══════════════════════════════════════╝
  `);
});

const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use((req,res,next)=>{res.header('Access-Control-Allow-Origin','*');res.header('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');res.header('Access-Control-Allow-Headers','Content-Type');if(req.method==='OPTIONS')return res.sendStatus(200);next();});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PHONE    = '966563466639';
const INSTANCE = 'instance165171';
const TOKEN    = '79scxmp5uv1687hb';
const API_URL  = `https://api.ultramsg.com/${INSTANCE}`;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:gLAYYfVCLDpxMTsCirlWkplBaDYxqzvU@postgres.railway.internal:5432/railway',
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id BIGINT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT DEFAULT 'task',
      date TEXT,
      time TEXT,
      note TEXT DEFAULT '',
      done BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ قاعدة البيانات جاهزة');
}
initDB();

let sentReminders = new Set();

async function sendWA(to, message) {
  try {
    await axios.post(`${API_URL}/messages/chat`, null, {
      params: { token: TOKEN, to, body: message }
    });
  } catch(e) { console.error('WA Error:', e.message); }
}

function fmt12(time24) {
  if (!time24) return '';
  const [h, m] = time24.split(':').map(Number);
  const p = h < 12 ? 'ص' : 'م';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2,'0')} ${p}`;
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function buildTaskMsg(t) {
  const icons = { meeting: '📅 اجتماع', task: '✅ مهمة', reminder: '🔔 تذكير' };
  const h = new Date().getHours();
  const gr = h < 12 ? 'صباح الخير' : h < 17 ? 'مساء الخير' : 'مساء النور';
  let msg = `${gr} عبدالعزيز 🌟\n\n`;
  msg += `${icons[t.type] || '📌 مهمة'}\n`;
  msg += `📌 *${t.title}*\n`;
  msg += `⏰ ${fmt12(t.time)}\n`;
  if (t.note) msg += `📝 ${t.note}\n`;
  msg += `\n─────────────\n`;
  msg += `رد بـ *منجز* لتأكيد الإنجاز\n`;
  msg += `رد بـ *تأجيل* لتأجيلها ساعة\n`;
  msg += `\n_مهامي_ ✨`;
  return msg;
}

async function parseTaskFromMessage(msg) {
  try {
    const todayISO = new Date().toISOString().split('T')[0];
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-20240307',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `اليوم هو ${todayISO}. استخرج معلومات المهمة من هذه الرسالة وأعد JSON فقط بدون أي نص إضافي:\n{"title":"عنوان المهمة","type":"task أو meeting أو reminder","date":"YYYY-MM-DD","time":"HH:MM","note":"ملاحظة اختيارية"}\n\nإذا لم يُذكر تاريخ فاستخدم اليوم. إذا لم يُذكر وقت فاستخدم "09:00".\nالأنواع: task=مهمة عامة، meeting=اجتماع، reminder=تذكير.\n\nالرسالة: "${msg}"`
      }]
    }, {
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    });
    const text = response.data.content[0].text.trim();
    return JSON.parse(text);
  } catch(e) {
    console.error('AI Error:', e.message);
    return null;
  }
}

cron.schedule('* * * * *', async () => {
  const today = todayStr();
  const now = new Date();
  const cur = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  try {
    const res = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 AND time=$2', [today, cur]);
    for (const t of res.rows) {
      if (!sentReminders.has(t.id)) {
        sentReminders.add(t.id);
        await sendWA(PHONE, buildTaskMsg(t));
        console.log(`📤 أُرسل تذكير: ${t.title}`);
      }
    }
  } catch(e) { console.error('Cron error:', e.message); }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  const msg  = body?.data?.body?.trim();
  const from = body?.data?.from;
  if (!msg || !from) return;
  console.log(`📩 رسالة من واتساب: ${msg}`);

  if (msg === 'منجز' || msg === 'تم' || msg === '1') {
    try {
      const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date DESC, time DESC LIMIT 1');
      const t = result.rows[0];
      if (!t) return;
      await pool.query('UPDATE tasks SET done=true WHERE id=$1', [t.id]);
      await sendWA(PHONE, `✅ ممتاز عبدالعزيز!\n\n*${t.title}* تم تحديدها كمنجزة 🎉`);
    } catch(e) { console.error(e.message); }
    return;
  }

  if (msg === 'تأجيل' || msg === '2') {
    try {
      const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date DESC, time DESC LIMIT 1');
      const t = result.rows[0];
      if (!t) return;
      const [h, m] = t.time.split(':').map(Number);
      const d = new Date();
      d.setHours(h + 1, m);
      const newTime = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      await pool.query('UPDATE tasks SET time=$1 WHERE id=$2', [newTime, t.id]);
      sentReminders.delete(t.id);
      await sendWA(PHONE, `⏰ تم تأجيل *${t.title}* لـ ${fmt12(newTime)}`);
    } catch(e) { console.error(e.message); }
    return;
  }

  if (msg === 'مهامي' || msg === 'قائمة') {
    try {
      const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date, time LIMIT 5');
      if (result.rows.length === 0) {
        await sendWA(PHONE, '📋 لا توجد مهام معلقة حالياً ✅');
        return;
      }
      let list = '📋 *مهامك المعلقة:*\n\n';
      result.rows.forEach((t, i) => {
        list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`;
      });
      await sendWA(PHONE, list);
    } catch(e) { console.error(e.message); }
    return;
  }

  const parsed = await parseTaskFromMessage(msg);
  if (parsed && parsed.title) {
    try {
      const id = Date.now();
      await pool.query('INSERT INTO tasks (id, title, type, date, time, note) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, parsed.title, parsed.type||'task', parsed.date, parsed.time, parsed.note||'']);
      await sendWA(PHONE, `✅ تم تسجيل المهمة!\n\n📌 *${parsed.title}*\n⏰ ${fmt12(parsed.time)}\n📅 ${parsed.date}\n\nسأذكرك في الوقت المحدد 🔔`);
      console.log(`✨ مهمة جديدة من واتساب: ${parsed.title}`);
    } catch(e) { console.error(e.message); }
  }
});

app.get('/tasks', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tasks ORDER BY date, time');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/tasks', async (req, res) => {
  const { title, type, date, time, note } = req.body;
  if (!title || !date || !time) return res.status(400).json({ error: 'بيانات ناقصة' });
  const id = Date.now();
  try {
    await pool.query('INSERT INTO tasks (id, title, type, date, time, note) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, title, type||'task', date, time, note||'']);
    res.json({ id, title, type: type||'task', date, time, note: note||'', done: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/tasks/:id', async (req, res) => {
  const { done } = req.body;
  try {
    await pool.query('UPDATE tasks SET done=$1 WHERE id=$2', [done, req.params.id]);
    const result = await pool.query('SELECT * FROM tasks WHERE id=$1', [req.params.id]);
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/tasks/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE id=$1', [req.params.id]);
    sentReminders.delete(parseInt(req.params.id));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/tasks/:id/send', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tasks WHERE id=$1', [req.params.id]);
    const t = result.rows[0];
    if (!t) return res.status(404).json({ error: 'غير موجودة' });
    await sendWA(PHONE, buildTaskMsg(t));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => {
  res.json({ status: '🟢 مهامي شغّال', time: new Date().toLocaleString('ar-SA') });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 مهامي سيرفر شغّال على port ${PORT}`));

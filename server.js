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
      location TEXT DEFAULT '',
      done BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS location TEXT DEFAULT ''`);
  console.log('✅ قاعدة البيانات جاهزة');
}
initDB();

let sentReminders = new Set();
const userState = {};

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

function addMinutesToTime(time24, minutes) {
  const [h, m] = time24.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const newH = Math.floor(total / 60) % 24;
  const newM = total % 60;
  return `${String(newH).padStart(2,'0')}:${String(newM).padStart(2,'0')}`;
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
  if (t.location) msg += `📍 ${t.location}\n`;
  msg += `\n─────────────\n`;
  msg += `رد بـ *منجز* لتأكيد الإنجاز\n`;
  msg += `رد بـ *تأجيل* لتأجيلها\n`;
  msg += `\n_مهامي_ ✨`;
  return msg;
}

async function parseTaskFromMessage(msg) {
  try {
    const todayISO = new Date().toISOString().split('T')[0];
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `اليوم هو ${todayISO}. استخرج معلومات المهمة من هذه الرسالة وأعد JSON فقط بدون أي نص إضافي أو markdown:
{"title":"عنوان المهمة","type":"task أو meeting أو reminder","date":"YYYY-MM-DD أو null","time":"HH:MM أو null","note":"ملاحظة أو فارغة"}

قواعد تحديد النوع:
- إذا ذكر كلمة اجتماع أو meeting أو لقاء أو مقابلة → type: meeting
- إذا ذكر تذكير أو ذكرني أو reminder → type: reminder
- غير ذلك → type: task

مهم: إذا لم يُذكر تاريخ اجعل date: null. إذا لم يُذكر وقت اجعل time: null.

الرسالة: "${msg}"`
      }]
    }, {
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    });
    const text = response.data.content[0].text.trim().replace(/```json|```/g, '').trim();
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

  const state = userState[from] || { step: 'idle' };

  // --- انتظار الوقت والتاريخ ---
  if (state.step === 'waiting_datetime') {
    const parsed = await parseTaskFromMessage(`${state.taskTitle} ${msg}`);
    if (parsed && parsed.date && parsed.time) {
      if (state.taskType === 'meeting') {
        userState[from] = { ...state, step: 'waiting_location', date: parsed.date, time: parsed.time };
        await sendWA(from, `📍 أين موقع الاجتماع؟\nأرسل رابط قوقل ماب أو اسم المكان\nأو أرسل *تخطي* إذا لم يكن محدداً`);
      } else {
        const id = Date.now();
        await pool.query('INSERT INTO tasks (id, title, type, date, time, note, location) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [id, state.taskTitle, state.taskType||'task', parsed.date, parsed.time, state.taskNote||'', '']);
        const icon = state.taskType === 'reminder' ? '🔔' : '✅';
        await sendWA(from, `${icon} تم تسجيل ${state.taskType === 'reminder' ? 'التذكير' : 'المهمة'}!\n\n📌 *${state.taskTitle}*\n⏰ ${fmt12(parsed.time)}\n📅 ${parsed.date}\n\nسأذكرك في الوقت المحدد 🔔`);
        userState[from] = { step: 'idle' };
      }
    } else {
      await sendWA(from, `❓ لم أفهم الوقت والتاريخ. أرسل مثلاً:\n"غداً الساعة 3 العصر"\n"2026-03-14 15:00"`);
    }
    return;
  }

  // --- انتظار الموقع ---
  if (state.step === 'waiting_location') {
    const location = msg === 'تخطي' ? '' : msg;
    const id = Date.now();
    await pool.query('INSERT INTO tasks (id, title, type, date, time, note, location) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, state.taskTitle, 'meeting', state.date, state.time, state.taskNote||'', location]);
    let reply = `✅ تم تسجيل الاجتماع!\n\n📅 *${state.taskTitle}*\n⏰ ${fmt12(state.time)}\n📅 ${state.date}`;
    if (location) reply += `\n📍 ${location}`;
    reply += `\n\nسأذكرك في الوقت المحدد 🔔`;
    await sendWA(from, reply);
    userState[from] = { step: 'idle' };
    return;
  }

  // --- انتظار اختيار المهمة المنجزة ---
  if (state.step === 'waiting_done_selection') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
      const t = state.tasks[num - 1];
      await pool.query('UPDATE tasks SET done=true WHERE id=$1', [t.id]);
      await sendWA(from, `✅ ممتاز عبدالعزيز!\n\n*${t.title}* تم تحديدها كمنجزة 🎉`);
      userState[from] = { step: 'idle' };
    } else {
      await sendWA(from, `❓ أرسل رقم المهمة فقط من القائمة`);
    }
    return;
  }

  // --- انتظار اختيار المهمة للتأجيل ---
  if (state.step === 'waiting_postpone_selection') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
      const t = state.tasks[num - 1];
      userState[from] = { step: 'waiting_postpone_duration', task: t };
      await sendWA(from, `⏰ *كم تريد تأجيل "${t.title}"؟*\n\n1. 15 دقيقة\n2. 30 دقيقة\n3. ساعة\n4. ساعتين\n5. أرسل عدد الدقائق يدوياً`);
    } else {
      await sendWA(from, `❓ أرسل رقم المهمة فقط من القائمة`);
    }
    return;
  }

  // --- انتظار مدة التأجيل ---
  if (state.step === 'waiting_postpone_duration') {
    const t = state.task;
    const durations = { '1': 15, '2': 30, '3': 60, '4': 120 };
    let minutes = 0;

    if (durations[msg]) {
      minutes = durations[msg];
    } else {
      const num = parseInt(msg);
      if (!isNaN(num) && num > 0 && num <= 1440) {
        minutes = num;
      } else {
        await sendWA(from, `❓ أرسل رقم من القائمة أو عدد الدقائق (مثال: 45)`);
        return;
      }
    }

    const newTime = addMinutesToTime(t.time, minutes);
    await pool.query('UPDATE tasks SET time=$1 WHERE id=$2', [newTime, t.id]);
    sentReminders.delete(t.id);
    const label = minutes < 60 ? `${minutes} دقيقة` : minutes === 60 ? 'ساعة' : minutes === 120 ? 'ساعتين' : `${minutes} دقيقة`;
    await sendWA(from, `⏰ تم تأجيل *${t.title}*\nمدة ${label} → ${fmt12(newTime)}`);
    userState[from] = { step: 'idle' };
    return;
  }

  // --- انتظار اختيار المهمة للحذف ---
  if (state.step === 'waiting_delete_selection') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
      const t = state.tasks[num - 1];
      await pool.query('DELETE FROM tasks WHERE id=$1', [t.id]);
      sentReminders.delete(t.id);
      await sendWA(from, `🗑️ تم حذف *${t.title}* بنجاح`);
      userState[from] = { step: 'idle' };
    } else {
      await sendWA(from, `❓ أرسل رقم المهمة فقط من القائمة`);
    }
    return;
  }

  // --- انتظار اختيار المهمة للتعديل ---
  if (state.step === 'waiting_edit_selection') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
      const t = state.tasks[num - 1];
      userState[from] = { step: 'waiting_edit_field', task: t };
      let opts = `✏️ *تعديل: ${t.title}*\n\nاختر ماذا تريد تعديله:\n\n1. العنوان\n2. الوقت\n3. التاريخ\n4. الملاحظة`;
      if (t.type === 'meeting') opts += `\n5. الموقع`;
      opts += `\n\nأرسل الرقم فقط`;
      await sendWA(from, opts);
    } else {
      await sendWA(from, `❓ أرسل رقم المهمة فقط من القائمة`);
    }
    return;
  }

  // --- انتظار اختيار الحقل للتعديل ---
  if (state.step === 'waiting_edit_field') {
    const num = parseInt(msg);
    const t = state.task;
    const fields = { 1: 'title', 2: 'time', 3: 'date', 4: 'note', 5: 'location' };
    const labels = {
      1: 'العنوان الجديد',
      2: 'الوقت الجديد (مثال: 3:00 م أو 15:00)',
      3: 'التاريخ الجديد (مثال: غداً أو 2026-03-15)',
      4: 'الملاحظة الجديدة (أو أرسل تخطي لحذفها)',
      5: 'الموقع الجديد (رابط قوقل ماب أو اسم المكان أو تخطي لحذفه)'
    };
    if (fields[num] && (num !== 5 || t.type === 'meeting')) {
      userState[from] = { step: 'waiting_edit_value', task: t, field: fields[num] };
      await sendWA(from, `✏️ أرسل ${labels[num]}:`);
    } else {
      await sendWA(from, `❓ أرسل رقم صحيح من القائمة`);
    }
    return;
  }

  // --- انتظار القيمة الجديدة للتعديل ---
  if (state.step === 'waiting_edit_value') {
    const t = state.task;
    const field = state.field;
    let newValue = msg === 'تخطي' ? '' : msg;

    if (field === 'time' && msg !== 'تخطي') {
      const parsed = await parseTaskFromMessage(`مهمة الساعة ${msg}`);
      if (parsed && parsed.time) newValue = parsed.time;
      else {
        await sendWA(from, `❓ لم أفهم الوقت. أرسل مثلاً: "3 العصر" أو "15:00"`);
        return;
      }
    } else if (field === 'date' && msg !== 'تخطي') {
      const parsed = await parseTaskFromMessage(`مهمة في ${msg}`);
      if (parsed && parsed.date) newValue = parsed.date;
      else {
        await sendWA(from, `❓ لم أفهم التاريخ. أرسل مثلاً: "غداً" أو "2026-03-15"`);
        return;
      }
    }

    await pool.query(`UPDATE tasks SET ${field}=$1 WHERE id=$2`, [newValue, t.id]);
    const fieldNames = { title: 'العنوان', time: 'الوقت', date: 'التاريخ', note: 'الملاحظة', location: 'الموقع' };
    let reply = `✅ تم تعديل ${fieldNames[field]} بنجاح!\n\n📌 *${field === 'title' ? newValue : t.title}*`;
    if (field === 'time') reply += `\n⏰ ${fmt12(newValue)}`;
    if (field === 'date') reply += `\n📅 ${newValue}`;
    await sendWA(from, reply);
    userState[from] = { step: 'idle' };
    return;
  }

  // --- منجز ---
  if (msg === 'منجز' || msg === 'تم') {
    try {
      const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date, time LIMIT 10');
      if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام معلقة حالياً ✅'); return; }
      if (result.rows.length === 1) {
        const t = result.rows[0];
        await pool.query('UPDATE tasks SET done=true WHERE id=$1', [t.id]);
        await sendWA(from, `✅ ممتاز عبدالعزيز!\n\n*${t.title}* تم تحديدها كمنجزة 🎉`);
        return;
      }
      let list = '✅ *أي مهمة أنجزت؟*\n\n';
      result.rows.forEach((t, i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
      list += `أرسل الرقم فقط`;
      await sendWA(from, list);
      userState[from] = { step: 'waiting_done_selection', tasks: result.rows };
    } catch(e) { console.error(e.message); }
    return;
  }

  // --- تأجيل ---
  if (msg === 'تأجيل') {
    try {
      const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date, time LIMIT 10');
      if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام معلقة حالياً ✅'); return; }
      if (result.rows.length === 1) {
        const t = result.rows[0];
        userState[from] = { step: 'waiting_postpone_duration', task: t };
        await sendWA(from, `⏰ *كم تريد تأجيل "${t.title}"؟*\n\n1. 15 دقيقة\n2. 30 دقيقة\n3. ساعة\n4. ساعتين\n5. أرسل عدد الدقائق يدوياً`);
        return;
      }
      let list = '⏰ *أي مهمة تريد تأجيلها؟*\n\n';
      result.rows.forEach((t, i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
      list += `أرسل الرقم فقط`;
      await sendWA(from, list);
      userState[from] = { step: 'waiting_postpone_selection', tasks: result.rows };
    } catch(e) { console.error(e.message); }
    return;
  }

  // --- حذف ---
  if (msg === 'احذف' || msg === 'حذف') {
    try {
      const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date, time LIMIT 10');
      if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام لحذفها ✅'); return; }
      if (result.rows.length === 1) {
        const t = result.rows[0];
        await pool.query('DELETE FROM tasks WHERE id=$1', [t.id]);
        sentReminders.delete(t.id);
        await sendWA(from, `🗑️ تم حذف *${t.title}* بنجاح`);
        return;
      }
      let list = '🗑️ *أي مهمة تريد حذفها؟*\n\n';
      result.rows.forEach((t, i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
      list += `أرسل الرقم فقط`;
      await sendWA(from, list);
      userState[from] = { step: 'waiting_delete_selection', tasks: result.rows };
    } catch(e) { console.error(e.message); }
    return;
  }

  // --- تعديل ---
  if (msg === 'عدل' || msg === 'تعديل') {
    try {
      const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date, time LIMIT 10');
      if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام لتعديلها ✅'); return; }
      if (result.rows.length === 1) {
        const t = result.rows[0];
        userState[from] = { step: 'waiting_edit_field', task: t };
        let opts = `✏️ *تعديل: ${t.title}*\n\nاختر ماذا تريد تعديله:\n\n1. العنوان\n2. الوقت\n3. التاريخ\n4. الملاحظة`;
        if (t.type === 'meeting') opts += `\n5. الموقع`;
        opts += `\n\nأرسل الرقم فقط`;
        await sendWA(from, opts);
        return;
      }
      let list = '✏️ *أي مهمة تريد تعديلها؟*\n\n';
      result.rows.forEach((t, i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
      list += `أرسل الرقم فقط`;
      await sendWA(from, list);
      userState[from] = { step: 'waiting_edit_selection', tasks: result.rows };
    } catch(e) { console.error(e.message); }
    return;
  }

  // --- قائمة المهام ---
  if (msg === 'مهامي' || msg === 'قائمة') {
    try {
      const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date, time LIMIT 10');
      if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام معلقة حالياً ✅'); return; }
      let list = '📋 *مهامك المعلقة:*\n\n';
      result.rows.forEach((t, i) => {
        const icon = t.type === 'meeting' ? '📅' : t.type === 'reminder' ? '🔔' : '✅';
        list += `${i+1}. ${icon} *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`;
      });
      await sendWA(from, list);
    } catch(e) { console.error(e.message); }
    return;
  }

  // --- مساعدة ---
  if (msg === 'مساعدة' || msg === 'help') {
    await sendWA(from, `📖 *أوامر مهامي:*\n\n• أرسل مهمة مثل: "اجتماع مع الفريق غداً الساعة 3"\n• *مهامي* - عرض المهام المعلقة\n• *منجز* - تحديد مهمة كمنجزة\n• *تأجيل* - تأجيل مهمة (تختار المدة)\n• *عدل* - تعديل مهمة\n• *احذف* - حذف مهمة\n• *مساعدة* - عرض هذه القائمة`);
    return;
  }

  // --- رسالة جديدة ---
  const parsed = await parseTaskFromMessage(msg);
  if (parsed && parsed.title) {
    if (!parsed.date || !parsed.time) {
      userState[from] = { step: 'waiting_datetime', taskTitle: parsed.title, taskType: parsed.type||'task', taskNote: parsed.note||'' };
      const icon = parsed.type === 'meeting' ? '📅' : parsed.type === 'reminder' ? '🔔' : '📌';
      let question = `${icon} فهمت أنك تريد إضافة:\n*${parsed.title}*\n\n`;
      if (!parsed.date && !parsed.time) question += `❓ متى وفي أي وقت؟\nمثال: "غداً الساعة 3 العصر"`;
      else if (!parsed.date) question += `❓ في أي يوم؟\nمثال: "غداً" أو "2026-03-15"`;
      else question += `❓ في أي وقت؟\nمثال: "الساعة 3 العصر"`;
      await sendWA(from, question);
      return;
    }
    if (parsed.type === 'meeting') {
      userState[from] = { step: 'waiting_location', taskTitle: parsed.title, taskType: 'meeting', taskNote: parsed.note||'', date: parsed.date, time: parsed.time };
      await sendWA(from, `📍 أين موقع الاجتماع؟\nأرسل رابط قوقل ماب أو اسم المكان\nأو أرسل *تخطي* إذا لم يكن محدداً`);
    } else {
      try {
        const id = Date.now();
        await pool.query('INSERT INTO tasks (id, title, type, date, time, note, location) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [id, parsed.title, parsed.type||'task', parsed.date, parsed.time, parsed.note||'', '']);
        const icon = parsed.type === 'reminder' ? '🔔' : '✅';
        await sendWA(from, `${icon} تم تسجيل ${parsed.type === 'reminder' ? 'التذكير' : 'المهمة'}!\n\n📌 *${parsed.title}*\n⏰ ${fmt12(parsed.time)}\n📅 ${parsed.date}\n\nسأذكرك في الوقت المحدد 🔔`);
        console.log(`✨ ${parsed.type} جديد: ${parsed.title}`);
      } catch(e) { console.error(e.message); }
    }
  } else {
    await sendWA(from, `❓ لم أفهم رسالتك.\n\nأرسل *مساعدة* لعرض الأوامر المتاحة`);
  }
});

app.get('/tasks', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tasks ORDER BY date, time');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/tasks', async (req, res) => {
  const { title, type, date, time, note, location } = req.body;
  if (!title || !date || !time) return res.status(400).json({ error: 'بيانات ناقصة' });
  const id = Date.now();
  try {
    await pool.query('INSERT INTO tasks (id, title, type, date, time, note, location) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, title, type||'task', date, time, note||'', location||'']);
    res.json({ id, title, type: type||'task', date, time, note: note||'', location: location||'', done: false });
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

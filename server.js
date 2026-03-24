const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use((req,res,next)=>{res.header('Access-Control-Allow-Origin','*');res.header('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');res.header('Access-Control-Allow-Headers','Content-Type');if(req.method==='OPTIONS')return res.sendStatus(200);next();});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── الإعدادات ─────────────────────────────────────────────────────────────
const OWNER_PHONE = '966563466639';
const INSTANCE    = 'instance165167';
const TOKEN       = 't2i3ustg3svr28yr';
const API_URL     = `https://api.ultramsg.com/${INSTANCE}`;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── قاعدة البيانات ────────────────────────────────────────────────────────
async function initDB() {
  // مهام عبدالعزيز
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

  // تذكيرات الزوار الشخصية
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visitor_reminders (
      id BIGINT PRIMARY KEY,
      phone TEXT NOT NULL,
      title TEXT NOT NULL,
      date TEXT,
      time TEXT,
      done BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // حالة المحادثة (تبقى بعد ريستارت)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_states (
      phone TEXT PRIMARY KEY,
      state JSONB NOT NULL DEFAULT '{"step":"idle"}',
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // التذكيرات المُرسلة (تبقى بعد ريستارت)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sent_reminders (
      key TEXT PRIMARY KEY,
      sent_at TIMESTAMP DEFAULT NOW()
    )
  `);

  console.log('✅ قاعدة البيانات جاهزة');
}
initDB();

// ─── إدارة الحالة ──────────────────────────────────────────────────────────
async function getState(phone) {
  try {
    const res = await pool.query('SELECT state FROM user_states WHERE phone=$1', [phone]);
    return res.rows.length > 0 ? res.rows[0].state : { step: 'idle' };
  } catch(e) { return { step: 'idle' }; }
}

async function setState(phone, state) {
  await pool.query(`
    INSERT INTO user_states (phone, state, updated_at) VALUES ($1,$2,NOW())
    ON CONFLICT (phone) DO UPDATE SET state=$2, updated_at=NOW()
  `, [phone, JSON.stringify(state)]);
}

async function clearState(phone) {
  await setState(phone, { step: 'idle' });
}

// ─── التذكيرات المُرسلة ────────────────────────────────────────────────────
async function isReminderSent(key) {
  const res = await pool.query('SELECT 1 FROM sent_reminders WHERE key=$1', [key]);
  return res.rows.length > 0;
}

async function markReminderSent(key) {
  await pool.query(`INSERT INTO sent_reminders (key) VALUES ($1) ON CONFLICT DO NOTHING`, [key]);
}

async function clearReminder(key) {
  await pool.query('DELETE FROM sent_reminders WHERE key=$1', [key]);
}

// ─── مساعدات ───────────────────────────────────────────────────────────────
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

function normalizePhone(from) {
  return from.replace('@c.us','').replace('+','');
}

function isOwner(from) {
  return normalizePhone(from) === normalizePhone(OWNER_PHONE);
}

function buildOwnerTaskMsg(t) {
  const icons = { meeting: '📅 اجتماع', task: '✅ مهمة', reminder: '🔔 تذكير' };
  const h = new Date().getHours();
  const gr = h < 12 ? 'صباح الخير' : h < 17 ? 'مساء الخير' : 'مساء النور';
  let msg = `${gr} عبدالعزيز 🌟\n\n${icons[t.type] || '📌 مهمة'}\n📌 *${t.title}*\n⏰ ${fmt12(t.time)}`;
  if (t.note) msg += `\n📝 ${t.note}`;
  if (t.location) msg += `\n📍 ${t.location}`;
  msg += `\n\n─────────────\nرد بـ *منجز* لتأكيد الإنجاز\nرد بـ *تأجيل* لتأجيلها ساعة\n\n_مهامي_ ✨`;
  return msg;
}

// ─── AI: تحليل الرسالة ─────────────────────────────────────────────────────
async function parseMessage(msg, senderIsOwner) {
  try {
    const prompt = `اليوم هو ${todayStr()}.

حلل هذه الرسالة وأعد JSON فقط بدون أي نص إضافي:

{
  "target": "owner أو sender",
  "intent": "add_task أو add_reminder أو list_tasks أو unknown",
  "title": "عنوان المهمة أو التذكير أو null",
  "type": "task أو meeting أو reminder",
  "date": "YYYY-MM-DD أو null",
  "time": "HH:MM أو null",
  "note": ""
}

قواعد target:
- ذكر "عبدالعزيز" أو "ذكر عبدالعزيز" أو "اجتماع معك" أو "موعد معك" → target: owner
- "ذكرني" أو يتحدث عن نفسه → target: sender
- إذا senderIsOwner=${senderIsOwner} → target: owner دائماً

قواعد intent:
- "مهامي" أو "قائمة" أو "وش مهامي" → intent: list_tasks, title: null
- إضافة شيء لعبدالعزيز → intent: add_task
- "ذكرني" → intent: add_reminder, target: sender

قواعد type:
- اجتماع/لقاء/مقابلة/موعد مع → meeting
- ذكرني/تذكير → reminder
- غير ذلك → task

الرسالة: "${msg}"`;

    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    });

    const text = response.data.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch(e) {
    console.error('AI Error:', e.message);
    return null;
  }
}

async function parseDatetime(msg) {
  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{ role: 'user', content: `اليوم ${todayStr()}. استخرج التاريخ والوقت من: "${msg}"\nأعد JSON فقط: {"date":"YYYY-MM-DD أو null","time":"HH:MM أو null"}` }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    });
    const text = response.data.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch(e) { return null; }
}

// ─── كرون: إرسال التذكيرات ─────────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  const today = todayStr();
  const now = new Date();
  const cur = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  try {
    // تذكيرات عبدالعزيز
    const ownerTasks = await pool.query(
      'SELECT * FROM tasks WHERE done=false AND date=$1 AND time=$2', [today, cur]
    );
    for (const t of ownerTasks.rows) {
      const key = `owner_${t.id}`;
      if (!await isReminderSent(key)) {
        await markReminderSent(key);
        await sendWA(OWNER_PHONE, buildOwnerTaskMsg(t));
        console.log(`📤 تذكير لعبدالعزيز: ${t.title}`);
      }
    }

    // تذكيرات الزوار
    const visitorReminders = await pool.query(
      'SELECT * FROM visitor_reminders WHERE done=false AND date=$1 AND time=$2', [today, cur]
    );
    for (const r of visitorReminders.rows) {
      const key = `visitor_${r.id}`;
      if (!await isReminderSent(key)) {
        await markReminderSent(key);
        await sendWA(r.phone, `🔔 *تذكيرك:*\n\n📌 *${r.title}*\n⏰ ${fmt12(r.time)}\n\n_مهامي_ ✨`);
        console.log(`📤 تذكير للزائر ${r.phone}: ${r.title}`);
      }
    }
  } catch(e) { console.error('Cron error:', e.message); }
});

// ─── الويب هوك ────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  const msg  = body?.data?.body?.trim();
  const from = body?.data?.from;
  if (!msg || !from) return;

  const owner = isOwner(from);
  console.log(`📩 ${owner ? '👑 المالك' : '👤 زائر'} [${normalizePhone(from)}]: ${msg}`);

  const state = await getState(from);

  // ══════════════════════════════════════════════════════════
  // حالات الانتظار — مشتركة بين المالك والزوار
  // ══════════════════════════════════════════════════════════

  // انتظار وقت مهمة عبدالعزيز
  if (state.step === 'waiting_datetime') {
    const parsed = await parseDatetime(msg);
    if (parsed?.date && parsed?.time) {
      if (state.taskType === 'meeting') {
        await setState(from, { ...state, step: 'waiting_location', date: parsed.date, time: parsed.time });
        await sendWA(from, `📍 أين موقع الاجتماع؟\nأرسل رابط قوقل ماب أو اسم المكان\nأو *تخطي*`);
      } else {
        const id = Date.now();
        await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [id, state.taskTitle, state.taskType||'task', parsed.date, parsed.time, state.taskNote||'', '']);
        await sendWA(from, `✅ تم تسجيل *${state.taskTitle}* في مهام عبدالعزيز\n⏰ ${fmt12(parsed.time)} - ${parsed.date}`);
        if (!owner) await sendWA(OWNER_PHONE, `📌 *مهمة جديدة من ${normalizePhone(from)}*\n\n*${state.taskTitle}*\n⏰ ${fmt12(parsed.time)}\n📅 ${parsed.date}`);
        await clearState(from);
      }
    } else {
      await sendWA(from, `❓ لم أفهم. مثال: "غداً الساعة 3 العصر"`);
    }
    return;
  }

  // انتظار موقع الاجتماع
  if (state.step === 'waiting_location') {
    const location = msg === 'تخطي' ? '' : msg;
    const id = Date.now();
    await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, state.taskTitle, 'meeting', state.date, state.time, state.taskNote||'', location]);
    let reply = `✅ تم تسجيل الاجتماع!\n📅 *${state.taskTitle}*\n⏰ ${fmt12(state.time)}\n📅 ${state.date}`;
    if (location) reply += `\n📍 ${location}`;
    await sendWA(from, reply);
    if (!owner) await sendWA(OWNER_PHONE, `📅 *اجتماع جديد من ${normalizePhone(from)}*\n\n*${state.taskTitle}*\n⏰ ${fmt12(state.time)}\n📅 ${state.date}${location ? `\n📍 ${location}` : ''}`);
    await clearState(from);
    return;
  }

  // انتظار وقت تذكير الزائر الشخصي
  if (state.step === 'waiting_visitor_datetime') {
    const parsed = await parseDatetime(msg);
    if (parsed?.date && parsed?.time) {
      const id = Date.now();
      await pool.query('INSERT INTO visitor_reminders (id,phone,title,date,time) VALUES ($1,$2,$3,$4,$5)',
        [id, normalizePhone(from), state.title, parsed.date, parsed.time]);
      await sendWA(from, `✅ تم! سأذكرك بـ *${state.title}*\n⏰ ${fmt12(parsed.time)}\n📅 ${parsed.date} 🔔`);
      await clearState(from);
    } else {
      await sendWA(from, `❓ لم أفهم. مثال: "غداً الساعة 5 العصر"`);
    }
    return;
  }

  // ══════════════════════════════════════════════════════════
  // أوامر المالك الحصرية
  // ══════════════════════════════════════════════════════════

  if (owner) {

    if (state.step === 'waiting_done_selection') {
      const num = parseInt(msg);
      if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
        const t = state.tasks[num-1];
        await pool.query('UPDATE tasks SET done=true WHERE id=$1', [t.id]);
        await sendWA(from, `✅ *${t.title}* تم إنجازها 🎉`);
        await clearState(from);
      } else { await sendWA(from, `❓ أرسل رقم من القائمة`); }
      return;
    }

    if (state.step === 'waiting_postpone_selection') {
      const num = parseInt(msg);
      if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
        const t = state.tasks[num-1];
        const [h, m] = t.time.split(':').map(Number);
        const d = new Date(); d.setHours(h+1, m);
        const newTime = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        await pool.query('UPDATE tasks SET time=$1 WHERE id=$2', [newTime, t.id]);
        await clearReminder(`owner_${t.id}`);
        await sendWA(from, `⏰ تم تأجيل *${t.title}* لـ ${fmt12(newTime)}`);
        await clearState(from);
      } else { await sendWA(from, `❓ أرسل رقم من القائمة`); }
      return;
    }

    if (state.step === 'waiting_delete_selection') {
      const num = parseInt(msg);
      if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
        const t = state.tasks[num-1];
        await pool.query('DELETE FROM tasks WHERE id=$1', [t.id]);
        await clearReminder(`owner_${t.id}`);
        await sendWA(from, `🗑️ تم حذف *${t.title}*`);
        await clearState(from);
      } else { await sendWA(from, `❓ أرسل رقم من القائمة`); }
      return;
    }

    if (state.step === 'waiting_edit_selection') {
      const num = parseInt(msg);
      if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
        const t = state.tasks[num-1];
        await setState(from, { step: 'waiting_edit_field', task: t });
        let opts = `✏️ *تعديل: ${t.title}*\n\n1. العنوان\n2. الوقت\n3. التاريخ\n4. الملاحظة`;
        if (t.type === 'meeting') opts += `\n5. الموقع`;
        opts += `\n\nأرسل الرقم`;
        await sendWA(from, opts);
      } else { await sendWA(from, `❓ أرسل رقم من القائمة`); }
      return;
    }

    if (state.step === 'waiting_edit_field') {
      const num = parseInt(msg);
      const fields = { 1:'title', 2:'time', 3:'date', 4:'note', 5:'location' };
      const labels = { 1:'العنوان الجديد', 2:'الوقت الجديد', 3:'التاريخ الجديد', 4:'الملاحظة الجديدة', 5:'الموقع الجديد' };
      if (fields[num] && (num !== 5 || state.task.type === 'meeting')) {
        await setState(from, { step: 'waiting_edit_value', task: state.task, field: fields[num] });
        await sendWA(from, `✏️ أرسل ${labels[num]}:`);
      } else { await sendWA(from, `❓ أرسل رقم صحيح`); }
      return;
    }

    if (state.step === 'waiting_edit_value') {
      const { task: t, field } = state;
      let newValue = msg;
      if (field === 'time' || field === 'date') {
        const parsed = await parseDatetime(field === 'time' ? msg : `في ${msg}`);
        if (field === 'time' && parsed?.time) newValue = parsed.time;
        else if (field === 'date' && parsed?.date) newValue = parsed.date;
        else { await sendWA(from, `❓ لم أفهم. حاول مجدداً`); return; }
      }
      await pool.query(`UPDATE tasks SET ${field}=$1 WHERE id=$2`, [newValue, t.id]);
      const names = { title:'العنوان', time:'الوقت', date:'التاريخ', note:'الملاحظة', location:'الموقع' };
      await sendWA(from, `✅ تم تعديل ${names[field]}!`);
      await clearState(from);
      return;
    }

    // أوامر المالك الثابتة
    if (msg === 'منجز' || msg === 'تم') {
      const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
      if (!result.rows.length) { await sendWA(from, '📋 لا توجد مهام معلقة ✅'); return; }
      if (result.rows.length === 1) {
        await pool.query('UPDATE tasks SET done=true WHERE id=$1', [result.rows[0].id]);
        await sendWA(from, `✅ *${result.rows[0].title}* تم إنجازها 🎉`); return;
      }
      let list = '✅ *أي مهمة أنجزت؟*\n\n';
      result.rows.forEach((t,i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
      await sendWA(from, list + `أرسل الرقم`);
      await setState(from, { step: 'waiting_done_selection', tasks: result.rows });
      return;
    }

    if (msg === 'تأجيل') {
      const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
      if (!result.rows.length) { await sendWA(from, '📋 لا توجد مهام ✅'); return; }
      if (result.rows.length === 1) {
        const t = result.rows[0];
        const [h, m] = t.time.split(':').map(Number);
        const d = new Date(); d.setHours(h+1, m);
        const newTime = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        await pool.query('UPDATE tasks SET time=$1 WHERE id=$2', [newTime, t.id]);
        await clearReminder(`owner_${t.id}`);
        await sendWA(from, `⏰ تم تأجيل *${t.title}* لـ ${fmt12(newTime)}`); return;
      }
      let list = '⏰ *أي مهمة تأجل؟*\n\n';
      result.rows.forEach((t,i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
      await sendWA(from, list + `أرسل الرقم`);
      await setState(from, { step: 'waiting_postpone_selection', tasks: result.rows });
      return;
    }

    if (msg === 'احذف' || msg === 'حذف') {
      const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
      if (!result.rows.length) { await sendWA(from, '📋 لا توجد مهام ✅'); return; }
      if (result.rows.length === 1) {
        await pool.query('DELETE FROM tasks WHERE id=$1', [result.rows[0].id]);
        await sendWA(from, `🗑️ تم حذف *${result.rows[0].title}*`); return;
      }
      let list = '🗑️ *أي مهمة تحذف؟*\n\n';
      result.rows.forEach((t,i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
      await sendWA(from, list + `أرسل الرقم`);
      await setState(from, { step: 'waiting_delete_selection', tasks: result.rows });
      return;
    }

    if (msg === 'عدل' || msg === 'تعديل') {
      const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
      if (!result.rows.length) { await sendWA(from, '📋 لا توجد مهام ✅'); return; }
      if (result.rows.length === 1) {
        const t = result.rows[0];
        await setState(from, { step: 'waiting_edit_field', task: t });
        let opts = `✏️ *تعديل: ${t.title}*\n\n1. العنوان\n2. الوقت\n3. التاريخ\n4. الملاحظة`;
        if (t.type === 'meeting') opts += `\n5. الموقع`;
        await sendWA(from, opts + `\n\nأرسل الرقم`); return;
      }
      let list = '✏️ *أي مهمة تعدل؟*\n\n';
      result.rows.forEach((t,i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
      await sendWA(from, list + `أرسل الرقم`);
      await setState(from, { step: 'waiting_edit_selection', tasks: result.rows });
      return;
    }

    if (msg === 'مساعدة' || msg === 'help') {
      await sendWA(from, `📖 *أوامر مهامي:*\n\n• أرسل مهمة مثل: "اجتماع مع الفريق غداً الساعة 3"\n• *مهامي* - عرض المهام\n• *منجز* - إنجاز مهمة\n• *تأجيل* - تأجيل ساعة\n• *عدل* - تعديل مهمة\n• *احذف* - حذف مهمة`);
      return;
    }
  }

  // ══════════════════════════════════════════════════════════
  // تحليل AI — مشترك للجميع
  // ══════════════════════════════════════════════════════════

  const parsed = await parseMessage(msg, owner);
  if (!parsed) {
    const helpMsg = owner
      ? `❓ لم أفهم. أرسل *مساعدة* للأوامر`
      : `👋 أهلاً! أنا مساعد عبدالعزيز.\n\n• 📋 *مهامي* — عرض مهام عبدالعزيز\n• 📅 "اجتماع مع عبدالعزيز غداً الساعة 3"\n• 📌 "ذكر عبدالعزيز باجتماعنا الساعة 2"\n• 🔔 "ذكرني بموعد الطبيب الساعة 5"`;
    await sendWA(from, helpMsg);
    return;
  }

  console.log(`🤖 AI: intent=${parsed.intent}, target=${parsed.target}, title=${parsed.title}`);

  // ── عرض قائمة مهام عبدالعزيز ──
  if (parsed.intent === 'list_tasks') {
    const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
    if (!result.rows.length) { await sendWA(from, '📋 لا توجد مهام معلقة لعبدالعزيز ✅'); return; }
    let list = '📋 *مهام عبدالعزيز المعلقة:*\n\n';
    result.rows.forEach((t,i) => {
      const icon = t.type==='meeting'?'📅':t.type==='reminder'?'🔔':'✅';
      list += `${i+1}. ${icon} *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`;
    });
    await sendWA(from, list);
    return;
  }

  // ── إضافة مهمة/اجتماع لعبدالعزيز ──
  if (parsed.intent === 'add_task' && parsed.target === 'owner') {
    if (!parsed.title) { await sendWA(from, `❓ لم أفهم عنوان المهمة`); return; }

    if (!parsed.date || !parsed.time) {
      await setState(from, { step: 'waiting_datetime', taskTitle: parsed.title, taskType: parsed.type||'task', taskNote: parsed.note||'' });
      await sendWA(from, `${parsed.type==='meeting'?'📅':'📌'} فهمت: *${parsed.title}*\n\n❓ متى وفي أي وقت؟\nمثال: "غداً الساعة 3 العصر"`);
      return;
    }

    if (parsed.type === 'meeting') {
      // اجتماع يحتاج موقع
      await setState(from, { step: 'waiting_location', taskTitle: parsed.title, taskType: 'meeting', taskNote: parsed.note||'', date: parsed.date, time: parsed.time });
      await sendWA(from, `📍 أين موقع الاجتماع؟\nأو *تخطي*`);
    } else {
      const id = Date.now();
      await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, parsed.title, parsed.type||'task', parsed.date, parsed.time, parsed.note||'', '']);
      await sendWA(from, `✅ تم تسجيل *${parsed.title}* في مهام عبدالعزيز\n⏰ ${fmt12(parsed.time)} - ${parsed.date}`);
      if (!owner) await sendWA(OWNER_PHONE, `📌 *مهمة جديدة من ${normalizePhone(from)}*\n\n*${parsed.title}*\n⏰ ${fmt12(parsed.time)}\n📅 ${parsed.date}`);
    }
    return;
  }

  // ── تذكير شخصي للمرسِل ──
  if (parsed.intent === 'add_reminder' && parsed.target === 'sender') {
    if (!parsed.title) { await sendWA(from, `❓ لم أفهم ماذا تريد أذكرك به`); return; }

    if (!parsed.date || !parsed.time) {
      await setState(from, { step: 'waiting_visitor_datetime', title: parsed.title });
      await sendWA(from, `🔔 سأذكرك بـ *${parsed.title}*\n\n❓ متى؟\nمثال: "غداً الساعة 5 العصر"`);
      return;
    }

    const id = Date.now();
    await pool.query('INSERT INTO visitor_reminders (id,phone,title,date,time) VALUES ($1,$2,$3,$4,$5)',
      [id, normalizePhone(from), parsed.title, parsed.date, parsed.time]);
    await sendWA(from, `✅ تم! سأذكرك بـ *${parsed.title}*\n⏰ ${fmt12(parsed.time)}\n📅 ${parsed.date} 🔔`);
    return;
  }

  // رسالة غير مفهومة
  const helpMsg = owner
    ? `❓ لم أفهم رسالتك. أرسل *مساعدة* للأوامر`
    : `👋 أهلاً! أنا مساعد عبدالعزيز.\n\n• 📋 *مهامي* — عرض مهام عبدالعزيز\n• 📅 "اجتماع مع عبدالعزيز غداً الساعة 3"\n• 📌 "ذكر عبدالعزيز باجتماعنا الساعة 2"\n• 🔔 "ذكرني بموعد الطبيب الساعة 5"`;
  await sendWA(from, helpMsg);
});

// ─── API للواجهة ───────────────────────────────────────────────────────────
app.get('/tasks', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tasks ORDER BY date,time');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/tasks', async (req, res) => {
  const { title, type, date, time, note, location } = req.body;
  if (!title || !date || !time) return res.status(400).json({ error: 'بيانات ناقصة' });
  const id = Date.now();
  try {
    await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, title, type||'task', date, time, note||'', location||'']);
    res.json({ id, title, type:type||'task', date, time, note:note||'', location:location||'', done:false });
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
    await clearReminder(`owner_${req.params.id}`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/tasks/:id/send', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tasks WHERE id=$1', [req.params.id]);
    const t = result.rows[0];
    if (!t) return res.status(404).json({ error: 'غير موجودة' });
    await sendWA(OWNER_PHONE, buildOwnerTaskMsg(t));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/visitor-reminders', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM visitor_reminders ORDER BY date,time');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => {
  res.json({ status: '🟢 مهامي شغّال', time: new Date().toLocaleString('ar-SA') });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 مهامي شغّال على port ${PORT}`));

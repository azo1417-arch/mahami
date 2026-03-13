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
      priority TEXT DEFAULT 'medium',
      repeat TEXT DEFAULT 'none',
      category TEXT DEFAULT 'عام',
      done BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS location TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'medium'`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repeat TEXT DEFAULT 'none'`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'عام'`);
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
  console.log('✅ قاعدة البيانات جاهزة');
}
initDB();

let sentReminders = new Set();
const userState = {};

// الفئات المتاحة
const CATEGORIES = ['عام', 'عمل', 'شخصي', 'صحة', 'عائلة', 'مالي'];
const CATEGORY_ICONS = { 'عام':'📌', 'عمل':'💼', 'شخصي':'👤', 'صحة':'💊', 'عائلة':'👨‍👩‍👧', 'مالي':'💰' };

async function getSetting(key) {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key=$1', [key]);
    return r.rows[0]?.value || null;
  } catch(e) { return null; }
}
async function setSetting(key, value) {
  await pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', [key, value]);
}

async function sendWA(to, message) {
  try {
    await axios.post(`${API_URL}/messages/chat`, null, { params: { token: TOKEN, to, body: message } });
  } catch(e) { console.error('WA Error:', e.message); }
}

function fmt12(time24) {
  if (!time24) return '';
  const [h, m] = time24.split(':').map(Number);
  const p = h < 12 ? 'ص' : 'م';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2,'0')} ${p}`;
}

function getSaudiNow() {
  return new Date(new Date().getTime() + 3 * 60 * 60 * 1000);
}
function todayStr() { return getSaudiNow().toISOString().split('T')[0]; }
function tomorrowStr() {
  const d = getSaudiNow(); d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}
function nowTimeStr() {
  const now = getSaudiNow();
  return `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
}
function addMinutesToTime(time24, minutes) {
  const [h, m] = time24.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total/60)%24).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;
}
function priorityIcon(p) {
  if (p === 'high') return '🔴';
  if (p === 'low') return '🟢';
  return '🟡';
}
function typeIcon(type) {
  if (type === 'meeting') return '📅';
  if (type === 'reminder') return '🔔';
  return '✅';
}
function typeLabel(type) {
  if (type === 'meeting') return 'اجتماع';
  if (type === 'reminder') return 'تذكير';
  return 'مهمة';
}
function catIcon(cat) { return CATEGORY_ICONS[cat] || '📌'; }

function buildTaskMsg(t) {
  const h = getSaudiNow().getHours();
  const gr = h < 12 ? 'صباح الخير' : 'مساء الخير';
  const icons = { meeting: '📅 اجتماع', task: '✅ مهمة', reminder: '🔔 تذكير' };
  let msg = `${gr} عبدالعزيز 🌟\n\n${icons[t.type]||'📌 مهمة'}\n`;
  msg += `${priorityIcon(t.priority)} *${t.title}*\n`;
  msg += `⏰ ${fmt12(t.time)}\n`;
  if (t.category && t.category !== 'عام') msg += `${catIcon(t.category)} ${t.category}\n`;
  if (t.note) msg += `📝 ${t.note}\n`;
  if (t.location) msg += `📍 ${t.location}\n`;
  msg += `\n─────────────\nرد بـ *منجز* لتأكيد الإنجاز\nرد بـ *تأجيل* لتأجيلها\n\n_مهامي_ ✨`;
  return msg;
}

function buildShareMsg(tasks, label) {
  let msg = `📋 *جدول مهام عبدالعزيز*\n`;
  msg += `📌 ${label}\n\n`;
  const byDate = {};
  tasks.forEach(t => {
    if (!byDate[t.date]) byDate[t.date] = [];
    byDate[t.date].push(t);
  });
  const dayNames = { 0:'الأحد', 1:'الاثنين', 2:'الثلاثاء', 3:'الأربعاء', 4:'الخميس', 5:'الجمعة', 6:'السبت' };
  Object.keys(byDate).sort().forEach(date => {
    const d = new Date(date);
    const dayName = dayNames[d.getDay()];
    if (Object.keys(byDate).length > 1) msg += `📅 *${dayName} ${date}*\n`;
    byDate[date].sort((a,b)=>a.time.localeCompare(b.time)).forEach((t, i) => {
      msg += `${i+1}. ${typeIcon(t.type)} *${t.title}*\n`;
      msg += `    ⏰ ${fmt12(t.time)}`;
      if (t.priority === 'high') msg += ` 🔴 عاجل`;
      msg += `\n`;
      if (t.location) msg += `    📍 ${t.location}\n`;
      if (t.note) msg += `    📝 ${t.note}\n`;
    });
    msg += `\n`;
  });
  msg += `📊 الإجمالي: ${tasks.length} ${tasks.length === 1 ? 'مهمة' : 'مهام'}\n`;
  msg += `_أُرسل عبر عبدالعزيز_ ✨`;
  return msg;
}

// فحص تعارض المواعيد
async function checkConflict(date, time, excludeId = null) {
  const timeStart = addMinutesToTime(time, -30);
  const timeEnd = addMinutesToTime(time, 30);
  let q = `SELECT * FROM tasks WHERE done=false AND date=$1 AND time>=$2 AND time<=$3`;
  const params = [date, timeStart, timeEnd];
  if (excludeId) { q += ` AND id!=$4`; params.push(excludeId); }
  const res = await pool.query(q, params);
  return res.rows;
}

async function parseTaskFromMessage(msg) {
  try {
    const todayISO = todayStr();
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: `اليوم هو ${todayISO}. استخرج معلومات المهمة من هذه الرسالة وأعد JSON فقط بدون أي نص إضافي أو markdown:
{"title":"عنوان المهمة","type":"task أو meeting أو reminder","date":"YYYY-MM-DD أو null","time":"HH:MM أو null","note":"ملاحظة أو فارغة","priority":"high أو medium أو low","repeat":"none أو daily أو weekly أو monthly","category":"عام أو عمل أو شخصي أو صحة أو عائلة أو مالي"}

قواعد:
- اجتماع/لقاء/مقابلة → type: meeting
- تذكير/ذكرني → type: reminder
- عاجل/مهم جداً → priority: high
- غير مهم/بسيط → priority: low
- كل يوم → repeat: daily, كل أسبوع → repeat: weekly, كل شهر → repeat: monthly
- استنتج الفئة من السياق: عمل/اجتماع/مشروع→عمل، رياضة/دكتور/دواء→صحة، عائلة/أهل→عائلة، راتب/فاتورة/بنك→مالي، غير ذلك→عام
- إذا لم يُذكر تاريخ → date: null, إذا لم يُذكر وقت → time: null

الرسالة: "${msg}"` }]
    }, { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
    const text = response.data.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch(e) { console.error('AI Error:', e.message); return null; }
}

// ==================== CRON ====================

cron.schedule('* * * * *', async () => {
  const today = todayStr();
  const cur = nowTimeStr();
  const in15 = addMinutesToTime(cur, 15);
  try {
    const res = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 AND time=$2', [today, cur]);
    for (const t of res.rows) {
      if (!sentReminders.has(`exact_${t.id}`)) {
        sentReminders.add(`exact_${t.id}`);
        await sendWA(PHONE, buildTaskMsg(t));
        if (t.repeat && t.repeat !== 'none') {
          const nextDate = new Date(t.date);
          if (t.repeat === 'daily') nextDate.setDate(nextDate.getDate() + 1);
          else if (t.repeat === 'weekly') nextDate.setDate(nextDate.getDate() + 7);
          else if (t.repeat === 'monthly') nextDate.setMonth(nextDate.getMonth() + 1);
          else if (t.repeat.startsWith('custom:')) {
            const days = t.repeat.replace('custom:', '').split(',').map(Number);
            const curDay = getSaudiNow().getDay();
            let nextDay = days.find(d => d > curDay) || days[0];
            let diff = nextDay > curDay ? nextDay - curDay : 7 - curDay + nextDay;
            nextDate.setDate(nextDate.getDate() + diff);
          }
          const newDate = nextDate.toISOString().split('T')[0];
          await pool.query('UPDATE tasks SET done=false, date=$1 WHERE id=$2', [newDate, t.id]);
          sentReminders.delete(`exact_${t.id}`);
          sentReminders.delete(`pre_${t.id}`);
        }
      }
    }
    const res15 = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 AND time=$2', [today, in15]);
    for (const t of res15.rows) {
      if (!sentReminders.has(`pre_${t.id}`)) {
        sentReminders.add(`pre_${t.id}`);
        await sendWA(PHONE, `⏰ *تذكير مسبق - بعد 15 دقيقة!*\n\n${typeIcon(t.type)} *${t.title}*\n🕐 ${fmt12(t.time)}${t.location ? `\n📍 ${t.location}` : ''}`);
      }
    }
    const customTime = await getSetting('daily_reminder_time');
    if (customTime && cur === customTime) await sendDailyReminder();
  } catch(e) { console.error('Cron error:', e.message); }
});

// تذكير صباحي افتراضي الساعة 8 بتوقيت السعودية = 05:00 UTC
cron.schedule('0 5 * * *', async () => {
  const customTime = await getSetting('daily_reminder_time');
  if (customTime) return;
  await sendDailyReminder();
});

// تذكير مسائي الساعة 9 م بتوقيت السعودية = 18:00 UTC
cron.schedule('0 18 * * *', async () => {
  const tomorrow = tomorrowStr();
  try {
    const res = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time', [tomorrow]);
    if (res.rows.length === 0) return;
    let msg = `🌙 *مهامك غداً:*\n\n`;
    res.rows.forEach((t,i) => { msg += `${i+1}. ${typeIcon(t.type)} ${priorityIcon(t.priority)} ${catIcon(t.category)} *${t.title}*\n   ⏰ ${fmt12(t.time)}\n\n`; });
    msg += `_مهامي_ ✨`;
    await sendWA(PHONE, msg);
  } catch(e) { console.error('Evening reminder error:', e.message); }
});

// تقرير الإنجاز الأسبوعي كل جمعة الساعة 9 م بتوقيت السعودية = 18:00 UTC
cron.schedule('0 18 * * 5', async () => {
  try {
    const weekAgo = new Date(getSaudiNow().getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const done = await pool.query('SELECT * FROM tasks WHERE done=true AND created_at>=$1', [weekAgo]);
    const pending = await pool.query('SELECT COUNT(*) FROM tasks WHERE done=false');
    const total = done.rows.length + parseInt(pending.rows[0].count);
    const pct = total > 0 ? Math.round((done.rows.length / total) * 100) : 0;

    // تحليل حسب الفئة
    const byCat = {};
    done.rows.forEach(t => { byCat[t.category||'عام'] = (byCat[t.category||'عام']||0) + 1; });
    const catSummary = Object.entries(byCat).map(([k,v]) => `${catIcon(k)} ${k}: ${v}`).join(' | ');

    let stars = pct >= 80 ? '🌟🌟🌟' : pct >= 50 ? '🌟🌟' : '🌟';
    let msg = `📊 *تقرير الأسبوع - عبدالعزيز*\n\n`;
    msg += `${stars}\n\n`;
    msg += `✅ مهام أنجزتها: *${done.rows.length}*\n`;
    msg += `📋 مهام معلقة: *${pending.rows[0].count}*\n`;
    msg += `📈 نسبة الإنجاز: *${pct}%*\n\n`;
    if (catSummary) msg += `📁 *حسب الفئة:*\n${catSummary}\n\n`;
    if (pct >= 80) msg += `💪 أسبوع رائع! استمر على هذا المستوى`;
    else if (pct >= 50) msg += `👍 أسبوع جيد! يمكنك تحسينه الأسبوع القادم`;
    else msg += `💡 الأسبوع القادم فرصة جديدة، ركز على المهام العاجلة`;
    msg += `\n\n_مهامي_ ✨`;
    await sendWA(PHONE, msg);
  } catch(e) { console.error('Weekly report error:', e.message); }
});

async function sendDailyReminder() {
  const today = todayStr();
  try {
    const overdue = await pool.query(
      `SELECT * FROM tasks WHERE done=false AND (date < $1 OR (date = $1 AND time < $2)) ORDER BY date, time`,
      [today, nowTimeStr()]
    );
    const todayTasks = await pool.query(
      `SELECT * FROM tasks WHERE done=false AND date=$1 AND time >= $2 ORDER BY time`,
      [today, nowTimeStr()]
    );
    if (overdue.rows.length === 0 && todayTasks.rows.length === 0) return;
    const h = getSaudiNow().getHours();
    const gr = h < 12 ? 'صباح الخير' : 'مساء الخير';
    let msg = `${gr} عبدالعزيز ☀️\n\n`;
    if (overdue.rows.length > 0) {
      msg += `⚠️ *مهام متأخرة:*\n${'─'.repeat(20)}\n`;
      overdue.rows.forEach((t,i) => {
        msg += `${i+1}. ${typeIcon(t.type)} ${priorityIcon(t.priority)} *${t.title}*\n   📅 ${t.date} - ⏰ ${fmt12(t.time)}\n\n`;
      });
    }
    if (todayTasks.rows.length > 0) {
      msg += `📋 *مهام اليوم:*\n${'─'.repeat(20)}\n`;
      todayTasks.rows.forEach((t,i) => {
        msg += `${i+1}. ${typeIcon(t.type)} ${priorityIcon(t.priority)} ${catIcon(t.category||'عام')} *${t.title}*\n   ⏰ ${fmt12(t.time)}${t.location ? ` - 📍 ${t.location}` : ''}\n\n`;
      });
    }
    msg += `_مهامي_ ✨`;
    await sendWA(PHONE, msg);
  } catch(e) { console.error('Daily reminder error:', e.message); }
}

async function handlePostpone(from, t) {
  userState[from] = { step: 'waiting_postpone_duration', task: t };
  await sendWA(from, `⏰ *كم تريد تأجيل "${t.title}"؟*\n\n1. 15 دقيقة\n2. 30 دقيقة\n3. ساعة\n4. ساعتين\n5. أرسل عدد الدقائق يدوياً`);
}

// ==================== WEBHOOK ====================

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  const msg  = body?.data?.body?.trim();
  const from = body?.data?.from;
  const fromMe = body?.data?.fromMe;
  if (!msg || !from) return;
  if (fromMe) return;
  console.log(`📩 ${msg}`);

  const state = userState[from] || { step: 'idle' };

  // --- انتظار الوقت والتاريخ ---
  if (state.step === 'waiting_datetime') {
    const parsed = await parseTaskFromMessage(`${state.taskTitle} ${msg}`);
    if (parsed && parsed.date && parsed.time) {
      // فحص التعارض
      const conflicts = await checkConflict(parsed.date, parsed.time);
      if (conflicts.length > 0) {
        const c = conflicts[0];
        userState[from] = { ...state, step: 'waiting_conflict_confirm', date: parsed.date, time: parsed.time, conflictTask: c };
        await sendWA(from, `⚠️ *تنبيه تعارض!*\n\nعندك بالفعل:\n📌 *${c.title}*\n⏰ ${fmt12(c.time)}\n\nهل تريد الإضافة رغم ذلك؟\n1. نعم أضف\n2. لا غير الوقت`);
        return;
      }
      if (state.taskType === 'meeting') {
        userState[from] = { ...state, step: 'waiting_location', date: parsed.date, time: parsed.time };
        await sendWA(from, `📍 أين موقع الاجتماع؟\nأو أرسل *تخطي*`);
      } else {
        const id = Date.now();
        await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location,priority,repeat,category) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [id, state.taskTitle, state.taskType||'task', parsed.date, parsed.time, state.taskNote||'', '', state.taskPriority||'medium', state.taskRepeat||'none', state.taskCategory||'عام']);
        const repeatLabel = state.taskRepeat==='daily'?'\n🔄 يومية':state.taskRepeat==='weekly'?'\n🔄 أسبوعية':state.taskRepeat==='monthly'?'\n🔄 شهرية':'';
        await sendWA(from, `✅ تم التسجيل!\n\n${priorityIcon(state.taskPriority||'medium')} *${state.taskTitle}*\n⏰ ${fmt12(parsed.time)}\n📅 ${parsed.date}\n${catIcon(state.taskCategory||'عام')} ${state.taskCategory||'عام'}${repeatLabel}`);
        userState[from] = { step: 'idle' };
      }
    } else {
      await sendWA(from, `❓ لم أفهم. مثال: "غداً الساعة 3 العصر"`);
    }
    return;
  }

  // --- تعارض المواعيد ---
  if (state.step === 'waiting_conflict_confirm') {
    if (msg === '1' || msg === 'نعم') {
      if (state.taskType === 'meeting') {
        userState[from] = { ...state, step: 'waiting_location' };
        await sendWA(from, `📍 أين موقع الاجتماع؟\nأو أرسل *تخطي*`);
      } else {
        const id = Date.now();
        await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location,priority,repeat,category) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [id, state.taskTitle, state.taskType||'task', state.date, state.time, state.taskNote||'', '', state.taskPriority||'medium', state.taskRepeat||'none', state.taskCategory||'عام']);
        await sendWA(from, `✅ تم التسجيل!\n\n${priorityIcon(state.taskPriority||'medium')} *${state.taskTitle}*\n⏰ ${fmt12(state.time)}\n📅 ${state.date}`);
        userState[from] = { step: 'idle' };
      }
    } else {
      userState[from] = { ...state, step: 'waiting_datetime' };
      await sendWA(from, `⏰ أرسل الوقت الجديد:`);
    }
    return;
  }

  // --- انتظار الموقع ---
  if (state.step === 'waiting_location') {
    const location = msg === 'تخطي' ? '' : msg;
    const id = Date.now();
    await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location,priority,repeat,category) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, state.taskTitle, 'meeting', state.date, state.time, state.taskNote||'', location, state.taskPriority||'medium', state.taskRepeat||'none', state.taskCategory||'عمل']);
    let reply = `✅ تم تسجيل الاجتماع!\n\n📅 *${state.taskTitle}*\n⏰ ${fmt12(state.time)}\n📅 ${state.date}`;
    if (location) reply += `\n📍 ${location}`;
    await sendWA(from, reply);
    userState[from] = { step: 'idle' };
    return;
  }

  // --- انتظار نوع المشاركة ---
  if (state.step === 'waiting_share_type') {
    const today = todayStr(); const now = nowTimeStr();
    let tasks = [], label = '';
    if (msg === '1') {
      tasks = (await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 AND time>=$2 ORDER BY time', [today, now])).rows;
      label = `مهام اليوم - ${today}`;
    } else if (msg === '2') {
      tasks = (await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time', [tomorrowStr()])).rows;
      label = `مهام غداً - ${tomorrowStr()}`;
    } else if (msg === '3') {
      tasks = (await pool.query(`SELECT * FROM tasks WHERE done=false AND (date < $1 OR (date=$1 AND time < $2)) ORDER BY date, time`, [today, now])).rows;
      label = `المهام المتأخرة`;
    } else if (msg === '4') {
      tasks = (await pool.query(`SELECT * FROM tasks WHERE done=false AND (date > $1 OR (date=$1 AND time > $2)) ORDER BY date, time LIMIT 30`, [today, now])).rows;
      label = `المهام القادمة`;
    } else if (msg === '5') {
      tasks = (await pool.query('SELECT * FROM tasks WHERE done=true ORDER BY created_at DESC LIMIT 20')).rows;
      label = `المهام المنجزة`;
    } else {
      await sendWA(from, `❓ أرسل رقم من 1 إلى 5`);
      return;
    }
    if (tasks.length === 0) { await sendWA(from, `📋 لا توجد مهام في هذه الفئة`); userState[from] = { step: 'idle' }; return; }
    userState[from] = { step: 'waiting_share_number', tasks, label };
    await sendWA(from, `📱 أرسل رقم واتساب الشخص:\nمثال: 966501234567`);
    return;
  }

  // --- انتظار رقم الشخص ---
  if (state.step === 'waiting_share_number') {
    const number = msg.replace(/\D/g, '');
    if (number.length < 9 || number.length > 15) { await sendWA(from, `❓ رقم غير صحيح`); return; }
    await sendWA(number, buildShareMsg(state.tasks, state.label));
    await sendWA(from, `✅ تم الإرسال لـ +${number}\n📋 عدد المهام: ${state.tasks.length}`);
    userState[from] = { step: 'idle' };
    return;
  }

  // --- انتظار وقت التذكير اليومي ---
  if (state.step === 'waiting_daily_reminder_time') {
    const parsed = await parseTaskFromMessage(`مهمة الساعة ${msg}`);
    if (parsed && parsed.time) {
      await setSetting('daily_reminder_time', parsed.time);
      await sendWA(from, `✅ تم ضبط التذكير اليومي على ${fmt12(parsed.time)} 🔔`);
      userState[from] = { step: 'idle' };
    } else { await sendWA(from, `❓ لم أفهم. مثال: "7 الصبح"`); }
    return;
  }

  // --- تأكيد حذف الكل ---
  if (state.step === 'waiting_delete_all_confirm') {
    if (msg === 'نعم' || msg === 'تأكيد') { await pool.query('DELETE FROM tasks WHERE done=false'); sentReminders.clear(); await sendWA(from, `🗑️ تم حذف جميع المهام المعلقة`); }
    else await sendWA(from, `❌ تم إلغاء الحذف`);
    userState[from] = { step: 'idle' }; return;
  }

  // --- تأكيد حذف المنجزة ---
  if (state.step === 'waiting_delete_done_confirm') {
    if (msg === 'نعم' || msg === 'تأكيد') { await pool.query('DELETE FROM tasks WHERE done=true'); await sendWA(from, `🗑️ تم حذف المهام المنجزة`); }
    else await sendWA(from, `❌ تم إلغاء الحذف`);
    userState[from] = { step: 'idle' }; return;
  }

  // --- اختيار المهمة المنجزة ---
  if (state.step === 'waiting_done_selection') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
      const t = state.tasks[num-1];
      await pool.query('UPDATE tasks SET done=true WHERE id=$1', [t.id]);
      await sendWA(from, `✅ ممتاز عبدالعزيز!\n\n*${t.title}* منجزة 🎉`);
      userState[from] = { step: 'idle' };
    } else await sendWA(from, `❓ أرسل رقم من القائمة`);
    return;
  }

  // --- اختيار المهمة للتأجيل ---
  if (state.step === 'waiting_postpone_selection') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= state.tasks.length) await handlePostpone(from, state.tasks[num-1]);
    else await sendWA(from, `❓ أرسل رقم من القائمة`);
    return;
  }

  // --- مدة التأجيل ---
  if (state.step === 'waiting_postpone_duration') {
    const t = state.task;
    const durations = { '1':15, '2':30, '3':60, '4':120 };
    let minutes = durations[msg] || parseInt(msg);
    if (!minutes || minutes <= 0 || minutes > 1440) { await sendWA(from, `❓ أرسل رقم من القائمة أو عدد الدقائق`); return; }
    const newTime = addMinutesToTime(t.time, minutes);
    await pool.query('UPDATE tasks SET time=$1 WHERE id=$2', [newTime, t.id]);
    sentReminders.delete(`exact_${t.id}`); sentReminders.delete(`pre_${t.id}`);
    const label = minutes < 60 ? `${minutes} دقيقة` : minutes === 60 ? 'ساعة' : minutes === 120 ? 'ساعتين' : `${minutes} دقيقة`;
    await sendWA(from, `⏰ تم تأجيل *${t.title}*\nمدة ${label} ← ${fmt12(newTime)}`);
    userState[from] = { step: 'idle' }; return;
  }

  // --- اختيار المهمة للحذف ---
  if (state.step === 'waiting_delete_selection') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
      const t = state.tasks[num-1];
      await pool.query('DELETE FROM tasks WHERE id=$1', [t.id]);
      sentReminders.delete(`exact_${t.id}`); sentReminders.delete(`pre_${t.id}`);
      await sendWA(from, `🗑️ تم حذف *${t.title}*`);
      userState[from] = { step: 'idle' };
    } else await sendWA(from, `❓ أرسل رقم من القائمة`);
    return;
  }

  // --- اختيار المهمة للتعديل ---
  if (state.step === 'waiting_edit_selection') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
      const t = state.tasks[num-1];
      userState[from] = { step: 'waiting_edit_field', task: t };
      let opts = `✏️ *تعديل: ${t.title}*\n\n1. العنوان\n2. الوقت\n3. التاريخ\n4. الملاحظة\n5. الأولوية\n6. الفئة`;
      if (t.type === 'meeting') opts += `\n7. الموقع`;
      await sendWA(from, opts + `\n\nأرسل الرقم فقط`);
    } else await sendWA(from, `❓ أرسل رقم من القائمة`);
    return;
  }

  // --- اختيار الحقل للتعديل ---
  if (state.step === 'waiting_edit_field') {
    const num = parseInt(msg);
    const t = state.task;
    if (num === 5) {
      userState[from] = { step: 'waiting_edit_priority', task: t };
      await sendWA(from, `الأولوية:\n1. 🔴 عالية\n2. 🟡 متوسطة\n3. 🟢 منخفضة`);
    } else if (num === 6) {
      userState[from] = { step: 'waiting_edit_category', task: t };
      const opts = CATEGORIES.map((c,i) => `${i+1}. ${catIcon(c)} ${c}`).join('\n');
      await sendWA(from, `📁 اختر الفئة:\n\n${opts}`);
    } else if (num === 7 && t.type === 'meeting') {
      userState[from] = { step: 'waiting_edit_value', task: t, field: 'location' };
      await sendWA(from, `📍 الموقع الجديد (أو تخطي لحذفه):`);
    } else {
      const fields = { 1:'title', 2:'time', 3:'date', 4:'note' };
      const labels = { 1:'العنوان الجديد', 2:'الوقت الجديد', 3:'التاريخ الجديد', 4:'الملاحظة الجديدة' };
      if (fields[num]) {
        userState[from] = { step: 'waiting_edit_value', task: t, field: fields[num] };
        await sendWA(from, `✏️ أرسل ${labels[num]}:`);
      } else await sendWA(from, `❓ أرسل رقم صحيح`);
    }
    return;
  }

  // --- تعديل الأولوية ---
  if (state.step === 'waiting_edit_priority') {
    const priorities = { '1':'high', '2':'medium', '3':'low' };
    const p = priorities[msg];
    if (p) { await pool.query('UPDATE tasks SET priority=$1 WHERE id=$2', [p, state.task.id]); await sendWA(from, `✅ تم تحديث الأولوية → ${priorityIcon(p)}`); userState[from] = { step: 'idle' }; }
    else await sendWA(from, `❓ أرسل 1 أو 2 أو 3`);
    return;
  }

  // --- تعديل الفئة ---
  if (state.step === 'waiting_edit_category') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= CATEGORIES.length) {
      const cat = CATEGORIES[num-1];
      await pool.query('UPDATE tasks SET category=$1 WHERE id=$2', [cat, state.task.id]);
      await sendWA(from, `✅ تم تحديث الفئة → ${catIcon(cat)} ${cat}`);
      userState[from] = { step: 'idle' };
    } else await sendWA(from, `❓ أرسل رقم من القائمة`);
    return;
  }

  // --- قيمة التعديل ---
  if (state.step === 'waiting_edit_value') {
    const { task: t, field } = state;
    let newValue = msg === 'تخطي' ? '' : msg;
    if (field === 'time' && msg !== 'تخطي') {
      const parsed = await parseTaskFromMessage(`مهمة الساعة ${msg}`);
      if (parsed && parsed.time) newValue = parsed.time;
      else { await sendWA(from, `❓ لم أفهم. مثال: "3 العصر"`); return; }
    } else if (field === 'date' && msg !== 'تخطي') {
      const parsed = await parseTaskFromMessage(`مهمة في ${msg}`);
      if (parsed && parsed.date) newValue = parsed.date;
      else { await sendWA(from, `❓ لم أفهم. مثال: "غداً"`); return; }
    }
    await pool.query(`UPDATE tasks SET ${field}=$1 WHERE id=$2`, [newValue, t.id]);
    const names = { title:'العنوان', time:'الوقت', date:'التاريخ', note:'الملاحظة', location:'الموقع' };
    let reply = `✅ تم تعديل ${names[field]}!\n\n📌 *${field==='title'?newValue:t.title}*`;
    if (field==='time') reply += `\n⏰ ${fmt12(newValue)}`;
    if (field==='date') reply += `\n📅 ${newValue}`;
    await sendWA(from, reply);
    userState[from] = { step: 'idle' }; return;
  }

  // ==================== الأوامر الرئيسية ====================

  if (msg === 'منجز' || msg === 'تم') {
    const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
    if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام معلقة ✅'); return; }
    if (result.rows.length === 1) { await pool.query('UPDATE tasks SET done=true WHERE id=$1', [result.rows[0].id]); await sendWA(from, `✅ ممتاز! *${result.rows[0].title}* منجزة 🎉`); return; }
    let list = '✅ *أي مهمة أنجزت؟*\n\n';
    result.rows.forEach((t,i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
    await sendWA(from, list + `أرسل الرقم فقط`);
    userState[from] = { step: 'waiting_done_selection', tasks: result.rows }; return;
  }

  if (msg === 'تأجيل') {
    const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
    if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام معلقة ✅'); return; }
    if (result.rows.length === 1) { await handlePostpone(from, result.rows[0]); return; }
    let list = '⏰ *أي مهمة تريد تأجيلها؟*\n\n';
    result.rows.forEach((t,i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
    await sendWA(from, list + `أرسل الرقم فقط`);
    userState[from] = { step: 'waiting_postpone_selection', tasks: result.rows }; return;
  }

  if (msg === 'احذف' || msg === 'حذف') {
    const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
    if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام لحذفها ✅'); return; }
    if (result.rows.length === 1) { await pool.query('DELETE FROM tasks WHERE id=$1', [result.rows[0].id]); await sendWA(from, `🗑️ تم حذف *${result.rows[0].title}*`); return; }
    let list = '🗑️ *أي مهمة تريد حذفها؟*\n\n';
    result.rows.forEach((t,i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
    await sendWA(from, list + `أرسل الرقم فقط`);
    userState[from] = { step: 'waiting_delete_selection', tasks: result.rows }; return;
  }

  if (msg === 'احذف الكل' || msg === 'حذف الكل') {
    const r = await pool.query('SELECT COUNT(*) FROM tasks WHERE done=false');
    const count = parseInt(r.rows[0].count);
    if (count === 0) { await sendWA(from, '📋 لا توجد مهام معلقة ✅'); return; }
    userState[from] = { step: 'waiting_delete_all_confirm' };
    await sendWA(from, `⚠️ هل تريد حذف جميع المهام المعلقة (${count} مهمة)؟\n\nأرسل *نعم* للتأكيد`); return;
  }

  if (msg === 'احذف المنجزة' || msg === 'حذف المنجزة') {
    const r = await pool.query('SELECT COUNT(*) FROM tasks WHERE done=true');
    const count = parseInt(r.rows[0].count);
    if (count === 0) { await sendWA(from, '📋 لا توجد مهام منجزة ✅'); return; }
    userState[from] = { step: 'waiting_delete_done_confirm' };
    await sendWA(from, `⚠️ هل تريد حذف ${count} مهمة منجزة؟\n\nأرسل *نعم* للتأكيد`); return;
  }

  if (msg === 'عدل' || msg === 'تعديل') {
    const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
    if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام لتعديلها ✅'); return; }
    if (result.rows.length === 1) {
      const t = result.rows[0];
      userState[from] = { step: 'waiting_edit_field', task: t };
      let opts = `✏️ *تعديل: ${t.title}*\n\n1. العنوان\n2. الوقت\n3. التاريخ\n4. الملاحظة\n5. الأولوية\n6. الفئة`;
      if (t.type === 'meeting') opts += `\n7. الموقع`;
      await sendWA(from, opts + `\n\nأرسل الرقم فقط`); return;
    }
    let list = '✏️ *أي مهمة تريد تعديلها؟*\n\n';
    result.rows.forEach((t,i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
    await sendWA(from, list + `أرسل الرقم فقط`);
    userState[from] = { step: 'waiting_edit_selection', tasks: result.rows }; return;
  }

  if (msg === 'مهامي' || msg === 'قائمة') {
    const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 15');
    if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام معلقة ✅'); return; }
    const today = todayStr(); const now = nowTimeStr();
    let list = '📋 *مهامك:*\n\n';
    result.rows.forEach((t,i) => {
      const overdue = (t.date < today || (t.date === today && t.time < now));
      list += `${i+1}. ${typeIcon(t.type)} ${priorityIcon(t.priority)} ${catIcon(t.category||'عام')} *${t.title}*${overdue?' ⚠️':''}\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`;
    });
    await sendWA(from, list); return;
  }

  if (msg === 'اليوم') {
    const result = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time', [todayStr()]);
    if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام اليوم ✅'); return; }
    const now = nowTimeStr();
    let list = `📋 *مهام اليوم:*\n\n`;
    result.rows.forEach((t,i) => {
      const overdue = t.time < now;
      list += `${i+1}. ${typeIcon(t.type)} ${priorityIcon(t.priority)} ${catIcon(t.category||'عام')} *${t.title}*${overdue?' ⚠️':''}\n   ⏰ ${fmt12(t.time)}\n\n`;
    });
    await sendWA(from, list); return;
  }

  if (msg === 'غداً' || msg === 'غدا') {
    const result = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time', [tomorrowStr()]);
    if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام غداً ✅'); return; }
    let list = `📋 *مهام غداً:*\n\n`;
    result.rows.forEach((t,i) => { list += `${i+1}. ${typeIcon(t.type)} ${priorityIcon(t.priority)} ${catIcon(t.category||'عام')} *${t.title}*\n   ⏰ ${fmt12(t.time)}\n\n`; });
    await sendWA(from, list); return;
  }

  if (msg === 'الاجتماعات') {
    const result = await pool.query("SELECT * FROM tasks WHERE done=false AND type='meeting' ORDER BY date,time LIMIT 10");
    if (result.rows.length === 0) { await sendWA(from, '📅 لا توجد اجتماعات مجدولة'); return; }
    let list = '📅 *اجتماعاتك:*\n\n';
    result.rows.forEach((t,i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}${t.location?`\n   📍 ${t.location}`:''}\n\n`; });
    await sendWA(from, list); return;
  }

  if (msg === 'المنجزة') {
    const result = await pool.query('SELECT * FROM tasks WHERE done=true ORDER BY created_at DESC LIMIT 10');
    if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام منجزة بعد'); return; }
    let list = '✅ *المهام المنجزة:*\n\n';
    result.rows.forEach((t,i) => { list += `${i+1}. ${typeIcon(t.type)} ${catIcon(t.category||'عام')} ${t.title}\n   📅 ${t.date}\n\n`; });
    await sendWA(from, list); return;
  }

  if (msg === 'المتأخرة') {
    const today = todayStr(); const now = nowTimeStr();
    const result = await pool.query(`SELECT * FROM tasks WHERE done=false AND (date < $1 OR (date=$1 AND time < $2)) ORDER BY date, time`, [today, now]);
    if (result.rows.length === 0) { await sendWA(from, '✅ لا توجد مهام متأخرة'); return; }
    let list = '⚠️ *المهام المتأخرة:*\n\n';
    result.rows.forEach((t,i) => { list += `${i+1}. ${typeIcon(t.type)} ${priorityIcon(t.priority)} *${t.title}*\n   📅 ${t.date} - ⏰ ${fmt12(t.time)}\n\n`; });
    await sendWA(from, list); return;
  }

  if (msg === 'القادمة') {
    const today = todayStr(); const now = nowTimeStr();
    const result = await pool.query(`SELECT * FROM tasks WHERE done=false AND (date > $1 OR (date=$1 AND time > $2)) ORDER BY date, time LIMIT 15`, [today, now]);
    if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام قادمة'); return; }
    let list = '🔜 *المهام القادمة:*\n\n';
    result.rows.forEach((t,i) => { list += `${i+1}. ${typeIcon(t.type)} ${priorityIcon(t.priority)} ${catIcon(t.category||'عام')} *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
    await sendWA(from, list); return;
  }

  if (msg === 'عاجل') {
    const result = await pool.query("SELECT * FROM tasks WHERE done=false AND priority='high' ORDER BY date,time LIMIT 10");
    if (result.rows.length === 0) { await sendWA(from, '🔴 لا توجد مهام عاجلة ✅'); return; }
    let list = '🔴 *المهام العاجلة:*\n\n';
    result.rows.forEach((t,i) => { list += `${i+1}. ${typeIcon(t.type)} ${catIcon(t.category||'عام')} *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
    await sendWA(from, list); return;
  }

  // --- أوامر الفئات ---
  if (msg === 'الفئات' || msg === 'فئات') {
    const opts = CATEGORIES.map((c,i) => `${i+1}. ${catIcon(c)} ${c}`).join('\n');
    await sendWA(from, `📁 *الفئات المتاحة:*\n\n${opts}\n\nأرسل رقم الفئة لعرض مهامها`);
    userState[from] = { step: 'waiting_category_view' }; return;
  }

  if (state.step === 'waiting_category_view') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= CATEGORIES.length) {
      const cat = CATEGORIES[num-1];
      const result = await pool.query("SELECT * FROM tasks WHERE done=false AND category=$1 ORDER BY date,time LIMIT 10", [cat]);
      if (result.rows.length === 0) { await sendWA(from, `📋 لا توجد مهام في فئة ${catIcon(cat)} ${cat}`); }
      else {
        let list = `${catIcon(cat)} *مهام ${cat}:*\n\n`;
        result.rows.forEach((t,i) => { list += `${i+1}. ${typeIcon(t.type)} ${priorityIcon(t.priority)} *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
        await sendWA(from, list);
      }
      userState[from] = { step: 'idle' };
    } else await sendWA(from, `❓ أرسل رقم من 1 إلى ${CATEGORIES.length}`);
    return;
  }

  if (msg === 'شارك مهامي' || msg === 'شارك') {
    userState[from] = { step: 'waiting_share_type' };
    await sendWA(from, `📤 *ماذا تريد مشاركته؟*\n\n1. مهام اليوم\n2. مهام غداً\n3. المهام المتأخرة\n4. المهام القادمة\n5. المهام المنجزة\n\nأرسل الرقم فقط`); return;
  }

  if (msg === 'تقرير') {
    const weekAgo = new Date(getSaudiNow().getTime() - 7*24*60*60*1000).toISOString().split('T')[0];
    const today = todayStr(); const now = nowTimeStr();
    const done = await pool.query('SELECT COUNT(*) FROM tasks WHERE done=true AND created_at>=$1', [weekAgo]);
    const pending = await pool.query('SELECT COUNT(*) FROM tasks WHERE done=false');
    const overdue = await pool.query(`SELECT COUNT(*) FROM tasks WHERE done=false AND (date<$1 OR (date=$1 AND time<$2))`, [today, now]);
    const upcoming = await pool.query(`SELECT COUNT(*) FROM tasks WHERE done=false AND (date>$1 OR (date=$1 AND time>$2))`, [today, now]);
    const meetings = await pool.query("SELECT COUNT(*) FROM tasks WHERE done=false AND type='meeting'");
    const customTime = await getSetting('daily_reminder_time');
    const total = parseInt(done.rows[0].count) + parseInt(pending.rows[0].count);
    const pct = total > 0 ? Math.round(parseInt(done.rows[0].count)/total*100) : 0;
    await sendWA(from, `📊 *تقريرك الأسبوعي:*\n\n✅ منجزة: ${done.rows[0].count}\n📈 نسبة الإنجاز: ${pct}%\n⚠️ متأخرة: ${overdue.rows[0].count}\n🔜 قادمة: ${upcoming.rows[0].count}\n📋 إجمالي معلقة: ${pending.rows[0].count}\n📅 اجتماعات: ${meetings.rows[0].count}\n⏰ تذكير يومي: ${customTime ? fmt12(customTime) : 'الساعة 8 صباحاً'}\n\n_مهامي_ ✨`); return;
  }

  if (msg === 'ملخص') {
    const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 20');
    if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام معلقة ✅'); return; }
    const taskList = result.rows.map(t=>`- ${t.title} (${t.date} ${fmt12(t.time)})`).join('\n');
    try {
      const response = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001', max_tokens: 300,
        messages: [{ role: 'user', content: `اعمل ملخصاً سريعاً ومشجعاً بالعربي لهذه المهام في 3-4 أسطر:\n${taskList}` }]
      }, { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
      await sendWA(from, `📝 *ملخص مهامك:*\n\n${response.data.content[0].text.trim()}`);
    } catch(e) { await sendWA(from, `📝 لديك ${result.rows.length} مهمة معلقة`); }
    return;
  }

  if (msg === 'رتب مهامي' || msg === 'رتب') {
    const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 20');
    if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام لترتيبها ✅'); return; }
    const taskList = result.rows.map(t=>`- ${t.title} (${typeLabel(t.type)}، ${t.priority}، ${t.date} ${fmt12(t.time)})`).join('\n');
    try {
      const response = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001', max_tokens: 400,
        messages: [{ role: 'user', content: `رتب هذه المهام حسب الأولوية بالعربي مع سبب قصير:\n${taskList}` }]
      }, { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
      await sendWA(from, `🔄 *مهامك مرتبة:*\n\n${response.data.content[0].text.trim()}`);
    } catch(e) { await sendWA(from, `❓ تعذر الترتيب حالياً`); }
    return;
  }

  if (msg.startsWith('ذكرني يومياً') || msg.startsWith('ذكرني يوميا') || msg === 'وقت التذكير') {
    userState[from] = { step: 'waiting_daily_reminder_time' };
    await sendWA(from, `⏰ في أي وقت تريد التذكير اليومي؟\nمثال: "7 الصبح" أو "08:30"`); return;
  }

  if (msg === 'مساعدة' || msg === 'help') {
    await sendWA(from, `📖 *أوامر مهامي:*\n\n*📋 عرض:*\n• مهامي\n• اليوم\n• غداً\n• القادمة\n• المتأخرة\n• الاجتماعات\n• المنجزة\n• عاجل\n• فئات\n\n*⚡ إجراءات:*\n• منجز\n• تأجيل\n• عدل\n• احذف\n• احذف الكل\n• احذف المنجزة\n\n*📤 مشاركة:*\n• شارك مهامي\n\n*📊 تقارير:*\n• تقرير\n• ملخص\n• رتب مهامي\n\n*⚙️ إعدادات:*\n• ذكرني يومياً الساعة 7\n• وقت التذكير\n\nأو أرسل مهمتك مباشرة! 🚀`); return;
  }

  // --- رسالة جديدة ---
  const parsed = await parseTaskFromMessage(msg);
  if (parsed && parsed.title) {
    if (!parsed.date || !parsed.time) {
      userState[from] = { step: 'waiting_datetime', taskTitle: parsed.title, taskType: parsed.type||'task', taskNote: parsed.note||'', taskPriority: parsed.priority||'medium', taskRepeat: parsed.repeat||'none', taskCategory: parsed.category||'عام' };
      const icon = parsed.type==='meeting'?'📅':parsed.type==='reminder'?'🔔':'📌';
      let q = `${icon} فهمت: *${parsed.title}* ${priorityIcon(parsed.priority||'medium')} ${catIcon(parsed.category||'عام')}\n\n`;
      if (!parsed.date && !parsed.time) q += `❓ متى وفي أي وقت؟\nمثال: "غداً الساعة 3 العصر"`;
      else if (!parsed.date) q += `❓ في أي يوم؟`;
      else q += `❓ في أي وقت؟`;
      await sendWA(from, q); return;
    }
    // فحص التعارض
    const conflicts = await checkConflict(parsed.date, parsed.time);
    if (conflicts.length > 0) {
      const c = conflicts[0];
      userState[from] = { step: 'waiting_conflict_confirm', taskTitle: parsed.title, taskType: parsed.type||'task', taskNote: parsed.note||'', taskPriority: parsed.priority||'medium', taskRepeat: parsed.repeat||'none', taskCategory: parsed.category||'عام', date: parsed.date, time: parsed.time, conflictTask: c };
      await sendWA(from, `⚠️ *تنبيه تعارض!*\n\nعندك بالفعل:\n📌 *${c.title}*\n⏰ ${fmt12(c.time)}\n\nهل تريد الإضافة رغم ذلك؟\n1. نعم أضف\n2. لا غير الوقت`);
      return;
    }
    if (parsed.type === 'meeting') {
      userState[from] = { step: 'waiting_location', taskTitle: parsed.title, taskType: 'meeting', taskNote: parsed.note||'', taskPriority: parsed.priority||'medium', taskRepeat: parsed.repeat||'none', taskCategory: parsed.category||'عمل', date: parsed.date, time: parsed.time };
      await sendWA(from, `📍 أين موقع الاجتماع؟\nأو أرسل *تخطي*`);
    } else {
      const id = Date.now();
      await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location,priority,repeat,category) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [id, parsed.title, parsed.type||'task', parsed.date, parsed.time, parsed.note||'', '', parsed.priority||'medium', parsed.repeat||'none', parsed.category||'عام']);
      const icon = parsed.type==='reminder'?'🔔':'✅';
      const repeatLabel = parsed.repeat==='daily'?'\n🔄 يومية':parsed.repeat==='weekly'?'\n🔄 أسبوعية':parsed.repeat==='monthly'?'\n🔄 شهرية':'';
      await sendWA(from, `${icon} تم التسجيل!\n\n${priorityIcon(parsed.priority||'medium')} *${parsed.title}*\n⏰ ${fmt12(parsed.time)}\n📅 ${parsed.date}\n${catIcon(parsed.category||'عام')} ${parsed.category||'عام'}${repeatLabel}`);
    }
  } else {
    await sendWA(from, `❓ لم أفهم رسالتك.\n\nأرسل *مساعدة* للأوامر المتاحة`);
  }
});

// ==================== REST API ====================

app.get('/tasks', async (req, res) => {
  try { const result = await pool.query('SELECT * FROM tasks ORDER BY date,time'); res.json(result.rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/tasks', async (req, res) => {
  const { title, type, date, time, note, location, priority, repeat, category } = req.body;
  if (!title || !date || !time) return res.status(400).json({ error: 'بيانات ناقصة' });
  const id = Date.now();
  try {
    await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location,priority,repeat,category) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, title, type||'task', date, time, note||'', location||'', priority||'medium', repeat||'none', category||'عام']);
    res.json({ id, title, type: type||'task', date, time, note: note||'', location: location||'', priority: priority||'medium', repeat: repeat||'none', category: category||'عام', done: false });
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
  try { await pool.query('DELETE FROM tasks WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
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
  res.json({ status: '🟢 مهامي شغّال', time: getSaudiNow().toLocaleString('ar-SA') });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 مهامي شغّال على port ${PORT}`));

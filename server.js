// ✅ توقيت الرياض
process.env.TZ = 'Asia/Riyadh';

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
      priority TEXT DEFAULT 'normal',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS location TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal'`);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_states (
      phone TEXT PRIMARY KEY,
      state JSONB NOT NULL DEFAULT '{"step":"idle"}',
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sent_reminders (
      key TEXT PRIMARY KEY,
      sent_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ✅ جدول المهام المتكررة
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recurring_tasks (
      id BIGINT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT DEFAULT 'task',
      time TEXT,
      note TEXT DEFAULT '',
      location TEXT DEFAULT '',
      frequency TEXT NOT NULL,
      day_of_week INT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ✅ ساعات الدوام
  await pool.query(`
    CREATE TABLE IF NOT EXISTS working_hours (
      id INT PRIMARY KEY DEFAULT 1,
      start_time TEXT NOT NULL DEFAULT '08:00',
      end_time TEXT NOT NULL DEFAULT '17:00',
      working_days TEXT NOT NULL DEFAULT '0,1,2,3,4',
      gap_minutes INT NOT NULL DEFAULT 60,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    INSERT INTO working_hours (id, start_time, end_time, working_days, gap_minutes)
    VALUES (1, '10:00', '18:00', '6,0,1,2,3,4', 60)
    ON CONFLICT (id) DO NOTHING
  `);

  // ✅ طلبات المواعيد
  await pool.query(`
    CREATE TABLE IF NOT EXISTS appointment_requests (
      id BIGINT PRIMARY KEY,
      phone TEXT NOT NULL,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      proposed_date TEXT NOT NULL,
      proposed_time TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
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
async function clearState(phone) { await setState(phone, { step: 'idle' }); }

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
  const now = new Date();
  const riyadh = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
  return riyadh.toISOString().split('T')[0];
}
function normalizePhone(from) { return from.replace('@c.us','').replace('+',''); }
function isOwner(from) { return normalizePhone(from) === normalizePhone(OWNER_PHONE); }

function buildOwnerTaskMsg(t, prefix = '') {
  const icons = { meeting: '📅 اجتماع', task: '✅ مهمة', reminder: '🔔 تذكير' };
  const h = new Date().getHours();
  const gr = h < 12 ? 'صباح الخير' : h < 17 ? 'مساء الخير' : 'مساء النور';
  const priorityIcon = t.priority === 'urgent' ? '🔴 *عاجل*\n' : '';
  let msg = `${prefix || gr + ' عبدالعزيز 🌟'}\n\n${priorityIcon}${icons[t.type] || '📌 مهمة'}\n📌 *${t.title}*\n⏰ ${fmt12(t.time)}`;
  if (t.note) msg += `\n📝 ${t.note}`;
  if (t.location) msg += `\n📍 ${t.location}`;
  msg += `\n\n─────────────\nرد بـ *منجز* لتأكيد الإنجاز\nرد بـ *تأجيل* لتأجيلها ساعة\n\n_مهامي_ ✨`;
  return msg;
}



// ─── فهم مرن للأوامر ───────────────────────────────────────────────────────
function detectCommand(msg) {
  const m = msg.trim().toLowerCase();

  // منجز
  if (/^(منجز|تم|خلصت|انجزت|أنجزت|سويتها|خلصتها|تمت|done|انتهيت|انتهى)$/.test(m)) return 'done';

  // تأجيل
  if (/^(تأجيل|أجل|اجل|تاجيل|postpone|لاحقاً|بعدين|مو الحين)$/.test(m)) return 'postpone';

  // حذف
  if (/^(احذف|حذف|امسح|مسح|شيل|delete|ما ابيها|ما أبيها|أزل|ازل|remove)$/.test(m)) return 'delete';

  // تعديل
  if (/^(عدل|تعديل|غير|بدل|edit|update|عدله|غيره)$/.test(m)) return 'edit';

  // مهامي
  if (/^(مهامي|قائمة|قائمتي|وش عندي|شو عندي|list|المهام|مهام|tasks)$/.test(m)) return 'list';

  // اليوم
  if (/^(اليوم|يومي|مهام اليوم|شو اليوم|وش اليوم|today|ي)$/.test(m)) return 'today';

  // المنجزة
  if (/^(المنجزة|المنجزات|المكتملة|اللي خلصت|done tasks|انجزت|أنجزت وش)$/.test(m)) return 'completed';

  // إحصائيات
  if (/^(إحصائيات|احصائيات|إحصاء|احصاء|stats|تقرير|ملخص|كم عندي|إ)$/.test(m)) return 'stats';

  // مساعدة
  if (/^(مساعدة|مساعده|help|ساعدني|وش الأوامر|وش الاوامر|كيف|\?)$/.test(m)) return 'help';

  // مشاركة
  if (/^(شارك|مشاركة|مشاركه|شاركها|وزع|أرسل مهامي|ارسل مهامي|share)$/.test(m)) return 'share';

  // دوام
  if (/^(دوام|ساعات الدوام|ساعات العمل|working hours|وقت الدوام)$/.test(m)) return 'workhours';

  // بحث
  const searchMatch = m.match(/^(بحث|ابحث|دور على|search|فين|وين)\s+(.+)$/);
  if (searchMatch) return `search:${searchMatch[2]}`;

  // جدول
  const schedMatch = m.match(/^(جدول|رتب موعد|حجز موعد|schedule)\s+(.+)$/);
  if (schedMatch) return `schedule:${schedMatch[2]}`;

  // تثبيت
  if (/^(ثبت|pin|مهم جداً|الأهم)$/.test(m)) return 'pin';

  // إيقاف التذكيرات
  const muteMatch = m.match(/^(أوقف|اوقف|صامت|mute|ما ابي تذكيرات|لا تذكرني)\s*(.*)$/);
  if (muteMatch) return `mute:${muteMatch[2]}`;

  // وضع عدم الإزعاج
  if (/^(عدم الإزعاج|dnd|لا تزعجني|وضع صامت)$/.test(m)) return 'dnd';

  // تراجع
  if (/^(تراجع|undo|رجع|رجوع|الغ اخر|ألغِ آخر)$/.test(m)) return 'undo';

  // ملاحظة سريعة
  const noteMatch = m.match(/^(سجل|ملاحظة|note|فكرة|اكتب)\s*[:\s]\s*(.+)$/);
  if (noteMatch) return `note:${noteMatch[2]}`;

  // ذكر شخص
  const remindMatch = m.match(/^(ذكر|ذكّر)\s+(\d+)\s+(.+)$/);
  if (remindMatch) return `remind_person:${remindMatch[2]}:${remindMatch[3]}`;

  return null;
}

// ─── جدولة ذكية للاجتماعات ─────────────────────────────────────────────────

async function getWorkingHours() {
  const res = await pool.query('SELECT * FROM working_hours WHERE id=1');
  return res.rows[0] || { start_time: '08:00', end_time: '17:00', working_days: '0,1,2,3,4', gap_minutes: 60 };
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

async function findFreeSlots(date, durationMins = 60) {
  const wh = await getWorkingHours();
  const dayOfWeek = new Date(date).getDay();
  const workingDays = wh.working_days.split(',').map(Number);

  if (!workingDays.includes(dayOfWeek)) return [];

  const startMins = timeToMinutes(wh.start_time);
  const endMins   = timeToMinutes(wh.end_time);
  const gap       = wh.gap_minutes;

  // جلب المهام الموجودة في هذا اليوم
  const existing = await pool.query(
    'SELECT time FROM tasks WHERE date=$1 AND done=false ORDER BY time', [date]
  );

  // بناء الأوقات المحجوزة (كل مهمة + ساعة buffer)
  const busy = existing.rows.map(r => {
    const t = timeToMinutes(r.time);
    return { start: t - gap, end: t + gap };
  });

  // إيجاد الفراغات
  const freeSlots = [];
  let cursor = startMins;

  while (cursor + durationMins <= endMins && freeSlots.length < 3) {
    const slotEnd = cursor + durationMins;
    const conflict = busy.some(b => cursor < b.end && slotEnd > b.start);

    if (!conflict) {
      freeSlots.push(minutesToTime(cursor));
      cursor += durationMins + gap;
    } else {
      cursor += 30;
    }
  }

  return freeSlots;
}

async function scheduleSmartMeeting(title, date, from, isOwner, visitorName = '') {
  const slots = await findFreeSlots(date);

  if (!slots.length) {
    return { success: false, message: `❌ لا يوجد وقت متاح في ${date}` };
  }

  if (slots.length === 1) {
    return { success: true, slots, single: true,
      message: `📅 *${title}*\n\n🕐 الوقت المقترح: *${fmt12(slots[0])}*\n📅 ${date}\n\nهل توافق؟ أرسل *موافق* أو *رفض*` };
  }

  let msg = `📅 *${title}*\n\n${visitorName ? `👤 من: ${visitorName}\n` : ''}الأوقات المتاحة في ${date}:\n\n`;
  slots.forEach((s, i) => { msg += `${i+1}. ⏰ ${fmt12(s)}\n`; });
  msg += `\nأرسل رقم الوقت المناسب أو *رفض*`;

  return { success: true, slots, single: false, message: msg };
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
  "note": "",
  "priority": "normal أو urgent",
  "recurring": "daily أو weekly أو null",
  "day_of_week": "0-6 أو null (0=الأحد)"
}

قواعد target:
- ذكر "عبدالعزيز" أو "ذكر عبدالعزيز" أو "اجتماع معك" أو "موعد معك" → target: owner
- "ذكرني" أو يتحدث عن نفسه → target: sender
- إذا senderIsOwner=${senderIsOwner} → target: owner دائماً

قواعد intent:
- "مهامي" أو "قائمة" أو "وش مهامي" → intent: list_tasks, title: null
- إضافة شيء لعبدالعزيز → intent: add_task
- "ذكرني" → intent: add_reminder, target: sender

قواعد priority:
- "عاجل" أو "مهم جداً" أو "ضروري" → priority: urgent
- غير ذلك → priority: normal

قواعد recurring:
- "كل يوم" → recurring: daily
- "كل أسبوع" أو "كل [اسم يوم]" → recurring: weekly, day_of_week: رقم اليوم
- غير ذلك → recurring: null

قواعد type:
- اجتماع/لقاء/مقابلة/موعد مع → meeting
- ذكرني/تذكير → reminder
- غير ذلك → task

الرسالة: "${msg}"`;

    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    });
    const text = response.data.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch(e) { console.error('AI Error:', e.message); return null; }
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


// ─── تحويل الرسالة الصوتية لنص ────────────────────────────────────────────
async function transcribeVoice(mediaUrl) {
  try {
    // تحميل الملف الصوتي
    const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
    const audioBuffer = Buffer.from(response.data);
    const base64Audio = audioBuffer.toString('base64');

    // إرسال للـ Claude لتحليل الصوت (عبر Whisper-style prompt)
    const result = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'هذه رسالة صوتية واتساب. المحتوى الصوتي غير متاح مباشرة، لكن المستخدم أرسل رسالة صوتية. أجب بـ: {"transcribed": false, "message": "عذراً، لا أقدر أسمع الرسائل الصوتية. أرسل رسالتك كنص"}'
          }
        ]
      }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    });

    return null;
  } catch(e) {
    console.error('Voice error:', e.message);
    return null;
  }
}

// ─── AI: تحسين فهم الرسائل الغامضة ────────────────────────────────────────
async function trySmartFallback(msg, from, owner) {
  try {
    const prompt = `أنت مساعد واتساب ذكي. المستخدم أرسل رسالة غير واضحة.
حاول تخمين ماذا يريد وأعد JSON:
{
  "understood": true أو false,
  "suggestion": "ماذا تعتقد أنه يريد؟ بجملة قصيرة",
  "action": "add_task أو list_tasks أو help أو unknown"
}
الرسالة: "${msg}"`;

    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    });
    const text = response.data.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch(e) { return { understood: false }; }
}

// ─── كرون: تذكيرات في الوقت المحدد ────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  const today = todayStr();
  const now = new Date();
  const cur = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  try {
    // ✅ فحص وضع الصمت
    let isMuted = false;
    try {
      const muteState = await pool.query("SELECT state FROM user_states WHERE phone=$1", [OWNER_PHONE + '_mute']);
      if (muteState.rows.length) {
        const muteUntil = new Date(muteState.rows[0].state.until);
        if (new Date() < muteUntil) isMuted = true;
        else await pool.query("DELETE FROM user_states WHERE phone=$1", [OWNER_PHONE + '_mute']);
      }
    } catch(e) {}

    if (isMuted) return;

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

    // ✅ تذكير مسبق قبل 15 دقيقة
    const in15 = new Date(now.getTime() + 15 * 60000);
    const time15 = `${String(in15.getHours()).padStart(2,'0')}:${String(in15.getMinutes()).padStart(2,'0')}`;
    const upcoming = await pool.query(
      'SELECT * FROM tasks WHERE done=false AND date=$1 AND time=$2', [today, time15]
    );
    for (const t of upcoming.rows) {
      const key = `pre15_${t.id}`;
      if (!await isReminderSent(key)) {
        await markReminderSent(key);
        await sendWA(OWNER_PHONE, buildOwnerTaskMsg(t, `⏰ تذكير مسبق — بعد 15 دقيقة`));
        console.log(`⏰ تذكير مسبق 15 دقيقة: ${t.title}`);
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

// ✅ كرون: تذكير بالمهام المتأخرة — كل ساعة
cron.schedule('0 * * * *', async () => {
  try {
    const now = new Date();
    const today = todayStr();
    const curTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    // مهام فات وقتها اليوم ولم تُنجز
    const overdue = await pool.query(
      "SELECT * FROM tasks WHERE done=false AND date=$1 AND time < $2 ORDER BY time",
      [today, curTime]
    );

    if (overdue.rows.length > 0) {
      let msg = `⚠️ *مهام فات وقتها ولم تُنجز:*\n\n`;
      overdue.rows.forEach((t, i) => {
        const icon = t.type==='meeting'?'📅':t.type==='reminder'?'🔔':'✅';
        msg += `${i+1}. ${icon} *${t.title}*\n   كان الوقت: ⏰ ${fmt12(t.time)}\n\n`;
      });
      msg += `رد بـ *منجز* أو *احذف* للتعامل معها`;

      const key = `overdue_${today}_${curTime}`;
      if (!await isReminderSent(key)) {
        await markReminderSent(key);
        await sendWA(OWNER_PHONE, msg);
        console.log(`⚠️ تنبيه مهام متأخرة: ${overdue.rows.length} مهام`);
      }
    }
  } catch(e) { console.error('Overdue check error:', e.message); }
});

// ✅ كرون: تلخيص صباحي كل يوم الساعة 8 صباحاً
cron.schedule('0 8 * * *', async () => {
  try {
    const today = todayStr();
    const result = await pool.query(
      'SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time', [today]
    );
    if (!result.rows.length) {
      await sendWA(OWNER_PHONE, `🌅 صباح الخير عبدالعزيز!\n\n📋 لا توجد مهام لهذا اليوم.\nاستمتع بيومك! 😊`);
      return;
    }
    let msg = `🌅 صباح الخير عبدالعزيز!\n\n📋 *مهام اليوم (${today}):*\n\n`;
    result.rows.forEach((t, i) => {
      const icon = t.type==='meeting'?'📅':t.type==='reminder'?'🔔':'✅';
      const urgent = t.priority==='urgent'?' 🔴':'';
      msg += `${i+1}. ${icon}${urgent} *${t.title}*\n   ⏰ ${fmt12(t.time)}\n\n`;
    });
    msg += `_يومك منتج_ 💪`;
    await sendWA(OWNER_PHONE, msg);
    console.log('📤 تلخيص صباحي أُرسل');
  } catch(e) { console.error('Morning summary error:', e.message); }
});

// ✅ كرون: تقرير أسبوعي كل جمعة الساعة 5 م
cron.schedule('0 17 * * 5', async () => {
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const today = todayStr();

    const done = await pool.query(
      'SELECT COUNT(*) FROM tasks WHERE done=true AND created_at >= $1', [weekAgo]
    );
    const pending = await pool.query('SELECT COUNT(*) FROM tasks WHERE done=false');
    const meetings = await pool.query(
      "SELECT COUNT(*) FROM tasks WHERE type='meeting' AND date >= $1 AND date <= $2", [weekAgo, today]
    );

    const msg = `📊 *تقريرك الأسبوعي*\n\n✅ المنجزة هذا الأسبوع: *${done.rows[0].count}*\n📋 المعلقة حالياً: *${pending.rows[0].count}*\n📅 الاجتماعات هذا الأسبوع: *${meetings.rows[0].count}*\n\nأسبوع موفق عبدالعزيز! 🌟`;
    await sendWA(OWNER_PHONE, msg);
    console.log('📤 تقرير أسبوعي أُرسل');
  } catch(e) { console.error('Weekly report error:', e.message); }
});

// ✅ كرون: إنشاء المهام المتكررة كل يوم الساعة 12 ص
cron.schedule('0 0 * * *', async () => {
  try {
    const now = new Date();
    const today = todayStr();
    const dayOfWeek = now.getDay();

    const recurring = await pool.query('SELECT * FROM recurring_tasks');
    for (const r of recurring.rows) {
      let shouldCreate = false;
      if (r.frequency === 'daily') shouldCreate = true;
      if (r.frequency === 'weekly' && r.day_of_week === dayOfWeek) shouldCreate = true;

      if (shouldCreate) {
        const exists = await pool.query(
          'SELECT 1 FROM tasks WHERE title=$1 AND date=$2', [r.title, today]
        );
        if (!exists.rows.length) {
          const id = Date.now() + Math.random();
          await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [id, r.title, r.type, today, r.time, r.note, r.location]);
          console.log(`🔁 مهمة متكررة أُضيفت: ${r.title}`);
        }
      }
    }
  } catch(e) { console.error('Recurring tasks error:', e.message); }
});

// ─── الويب هوك ────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  const msg  = body?.data?.body?.trim();
  const from = body?.data?.from;
  if (!msg || !from) return;

  const owner = isOwner(from);

  // ✅ كشف الرسائل الصوتية
  const msgType = body?.data?.type;
  if (msgType === 'audio' || msgType === 'ptt') {
    console.log(`🎙️ رسالة صوتية من ${normalizePhone(from)}`);
    await sendWA(from, `🎙️ استلمت رسالتك الصوتية!

حالياً البوت يدعم النصوص فقط.

أرسل رسالتك كنص مثل:
• "اجتماع مع الفريق غداً الساعة 3"
• "ذكرني بالتقرير الساعة 5"

أو أرسل *مساعدة* للأوامر 📖`);
    return;
  }

  console.log(`📩 ${owner ? '👑 المالك' : '👤 زائر'} [${normalizePhone(from)}]: ${msg}`);

  const state = await getState(from);


  // ✅ حالات الجدولة الذكية — انتظار اسم الزائر
  if (state.step === 'waiting_visitor_name') {
    const name = msg.trim();
    await setState(from, { ...state, step: 'waiting_visitor_date', visitorName: name });
    await sendWA(from, `👋 أهلاً ${name}!\n\nمتى تريد الموعد؟\nمثال: "غداً" أو "2026-03-25"`);
    return;
  }

  // انتظار تاريخ الموعد من الزائر
  if (state.step === 'waiting_visitor_date') {
    const parsed = await parseDatetime(`موعد في ${msg}`);
    if (!parsed?.date) {
      await sendWA(from, `❓ لم أفهم التاريخ. مثال: "غداً" أو "2026-03-25"`);
      return;
    }
    const result = await scheduleSmartMeeting(state.title, parsed.date, from, false, state.visitorName);
    if (!result.success) {
      await sendWA(from, result.message);
      await clearState(from);
      return;
    }
    await setState(from, { ...state, step: 'waiting_visitor_slot', slots: result.slots, date: parsed.date });
    await sendWA(from, result.message);
    return;
  }

  // انتظار اختيار الوقت من الزائر
  if (state.step === 'waiting_visitor_slot') {
    if (msg === 'رفض') {
      await clearState(from);
      await sendWA(from, `↩️ تم الإلغاء. يمكنك المحاولة بتاريخ آخر`);
      return;
    }
    const num = parseInt(msg);
    if (isNaN(num) || num < 1 || num > state.slots.length) {
      await sendWA(from, `❓ أرسل رقم من 1 إلى ${state.slots.length} أو *رفض*`);
      return;
    }
    const chosenTime = state.slots[num - 1];
    // حفظ الطلب معلقاً وأرسل لعبدالعزيز
    const reqId = Date.now();
    await pool.query(
      'INSERT INTO appointment_requests (id,phone,name,title,proposed_date,proposed_time) VALUES ($1,$2,$3,$4,$5,$6)',
      [reqId, normalizePhone(from), state.visitorName, state.title, state.date, chosenTime]
    );
    await sendWA(from, `✅ تم إرسال طلب الموعد!\n\n📅 *${state.title}*\n⏰ ${fmt12(chosenTime)}\n📅 ${state.date}\n\nسيتم إشعارك فور موافقة أ. عبدالعزيز 🔔`);
    await sendWA(OWNER_PHONE, `📅 *طلب موعد جديد*\n\n👤 ${state.visitorName}\n📌 *${state.title}*\n⏰ ${fmt12(chosenTime)}\n📅 ${state.date}\n\nأرسل *موافق ${reqId}* أو *رفض ${reqId}*`);
    await clearState(from);
    return;
  }

  // ✅ المالك يوافق أو يرفض طلب موعد
  if (owner && (msg.startsWith('موافق ') || msg.startsWith('رفض '))) {
    const parts = msg.split(' ');
    const action = parts[0];
    const reqId = parts[1];
    if (!reqId) { await sendWA(from, `❓ أرسل: موافق [رقم] أو رفض [رقم]`); return; }

    const req = await pool.query('SELECT * FROM appointment_requests WHERE id=$1', [reqId]);
    if (!req.rows.length) { await sendWA(from, `❓ الطلب غير موجود`); return; }
    const r = req.rows[0];

    if (action === 'موافق') {
      // أضف للجدول
      const taskId = Date.now();
      await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [taskId, r.title, 'meeting', r.proposed_date, r.proposed_time, `مع ${r.name}`, '']);
      await pool.query('UPDATE appointment_requests SET status=$1 WHERE id=$2', ['approved', reqId]);
      await sendWA(from, `✅ تم قبول الموعد وإضافته لجدولك!\n📅 *${r.title}*\n⏰ ${fmt12(r.proposed_time)} - ${r.proposed_date}`);
      await sendWA(r.phone, `✅ *تم قبول موعدك!*\n\n📅 *${r.title}*\n⏰ ${fmt12(r.proposed_time)}\n📅 ${r.proposed_date}\n\nنتطلع لرؤيتك! 🤝`);
    } else {
      await pool.query('UPDATE appointment_requests SET status=$1 WHERE id=$2', ['rejected', reqId]);
      await sendWA(from, `❌ تم رفض الطلب`);
      await sendWA(r.phone, `❌ عذراً، الموعد غير متاح.\nيمكنك المحاولة بوقت آخر.`);
    }
    return;
  }

  // ✅ المالك يجدول اجتماع ذكي (بدون وقت محدد)
  if (owner && state.step === 'waiting_smart_schedule_date') {
    const parsed = await parseDatetime(`موعد في ${msg}`);
    if (!parsed?.date) {
      await sendWA(from, `❓ لم أفهم التاريخ. مثال: "غداً"`);
      return;
    }
    const result = await scheduleSmartMeeting(state.title, parsed.date, from, true);
    if (!result.success) {
      await sendWA(from, result.message);
      await clearState(from);
      return;
    }
    if (result.single) {
      await setState(from, { step: 'waiting_owner_confirm_slot', title: state.title, date: parsed.date, slots: result.slots });
      await sendWA(from, result.message);
    } else {
      await setState(from, { step: 'waiting_owner_pick_slot', title: state.title, date: parsed.date, slots: result.slots });
      await sendWA(from, result.message);
    }
    return;
  }

  if (owner && state.step === 'waiting_owner_confirm_slot') {
    if (msg === 'موافق') {
      const id = Date.now();
      await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, state.title, 'meeting', state.date, state.slots[0], '', '']);
      await sendWA(from, `✅ تم جدولة *${state.title}*\n⏰ ${fmt12(state.slots[0])} - ${state.date}`);
      await clearState(from);
    } else if (msg === 'رفض') {
      await clearState(from);
      await sendWA(from, `↩️ تم الإلغاء`);
    } else {
      await sendWA(from, `أرسل *موافق* أو *رفض*`);
    }
    return;
  }

  if (owner && state.step === 'waiting_owner_pick_slot') {
    if (msg === 'رفض') { await clearState(from); await sendWA(from, `↩️ تم الإلغاء`); return; }
    const num = parseInt(msg);
    if (isNaN(num) || num < 1 || num > state.slots.length) {
      await sendWA(from, `❓ أرسل رقم من 1 إلى ${state.slots.length}`); return;
    }
    const id = Date.now();
    await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, state.title, 'meeting', state.date, state.slots[num-1], '', '']);
    await sendWA(from, `✅ تم جدولة *${state.title}*\n⏰ ${fmt12(state.slots[num-1])} - ${state.date}`);
    await clearState(from);
    return;
  }


  // ✅ مشاركة المهام — انتظار الرقم
  if (owner && state.step === 'waiting_share_phone') {
    const phone = msg.replace(/[^0-9]/g, '');
    if (phone.length < 9) {
      await sendWA(from, `❓ رقم غير صحيح. أرسل رقم واتساب كامل مثل: 966501234567`);
      return;
    }
    await setState(from, { ...state, step: 'waiting_share_type', sharePhone: phone });
    await sendWA(from, `📤 شاركة المهام مع ${phone}

ماذا تريد تشارك؟

1. مهام اليوم فقط
2. مهام الغد
3. مهام الأسبوع
4. كل المهام المعلقة

أرسل الرقم`);
    return;
  }

  // انتظار نوع المشاركة
  if (owner && state.step === 'waiting_share_type') {
    const num = parseInt(msg);
    if (isNaN(num) || num < 1 || num > 4) {
      await sendWA(from, `❓ أرسل رقم من 1 إلى 4`);
      return;
    }

    const today = todayStr();
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const weekLater = new Date(Date.now() + 7*86400000).toISOString().split('T')[0];

    let tasks, label;
    if (num === 1) {
      tasks = (await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time', [today])).rows;
      label = `مهام اليوم (${today})`;
    } else if (num === 2) {
      tasks = (await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time', [tomorrow])).rows;
      label = `مهام الغد (${tomorrow})`;
    } else if (num === 3) {
      tasks = (await pool.query('SELECT * FROM tasks WHERE done=false AND date>=$1 AND date<=$2 ORDER BY date,time', [today, weekLater])).rows;
      label = `مهام الأسبوع القادم`;
    } else {
      tasks = (await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 20')).rows;
      label = `كل المهام المعلقة`;
    }

    if (!tasks.length) {
      await sendWA(from, `📋 لا توجد مهام لمشاركتها`);
      await clearState(from);
      return;
    }

    // بناء رسالة المشاركة
    let shareMsg = `📋 *${label} — أ. عبدالعزيز:*

`;
    tasks.forEach((t, i) => {
      const icon = t.type==='meeting'?'📅':t.type==='reminder'?'🔔':'✅';
      const urgent = t.priority==='urgent'?' 🔴':'';
      shareMsg += `${i+1}. ${icon}${urgent} *${t.title}*
   ⏰ ${fmt12(t.time)} — ${t.date}

`;
    });
    shareMsg += `_أُرسلت من مهامي_ ✨`;

    await sendWA(state.sharePhone, shareMsg);
    await sendWA(from, `✅ تم إرسال *${tasks.length}* مهام إلى ${state.sharePhone} 📤`);
    console.log(`📤 مشاركة مهام مع ${state.sharePhone}: ${tasks.length} مهمة`);
    await clearState(from);
    return;
  }


  // تثبيت مهمة
  if (owner && state.step === 'waiting_pin_selection') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
      const t = state.tasks[num-1];
      await pool.query("UPDATE tasks SET priority='urgent' WHERE id=$1", [t.id]);
      await sendWA(from, `📌 تم تثبيت *${t.title}* كأولوية قصوى 🔴`);
      await clearState(from);
    } else { await sendWA(from, `❓ أرسل رقم من القائمة`); }
    return;
  }

  // ✅ حالة انتظار توضيح من المستخدم
  if (state.step === 'waiting_clarification') {
    if (msg === 'نعم' || msg === 'أيوه' || msg === 'ايوه') {
      await clearState(from);
      // أعد معالجة الاقتراح
      const reparsed = await parseMessage(state.suggestion, owner);
      if (reparsed?.intent === 'list_tasks') {
        const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
        let list = '📋 *مهامك المعلقة:*\n\n';
        result.rows.forEach((t,i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
        await sendWA(from, result.rows.length ? list : '📋 لا توجد مهام ✅');
      } else {
        await sendWA(from, `✅ حسناً! أرسل التفاصيل مرة أخرى بشكل أوضح`);
      }
    } else {
      await clearState(from);
      await sendWA(from, `↩️ حسناً، أرسل رسالتك مرة أخرى بشكل أوضح أو أرسل *مساعدة*`);
    }
    return;
  }

  // ✅ إلغاء في أي وقت
  if (msg === 'إلغاء' || msg === 'الغاء') {
    await clearState(from);
    await sendWA(from, `↩️ تم الإلغاء. كيف يمكنني مساعدتك؟`);
    return;
  }

  // ══════ حالات الانتظار ══════

  if (state.step === 'waiting_datetime') {
    const parsed = await parseDatetime(msg);
    if (parsed?.date && parsed?.time) {
      if (state.taskType === 'meeting') {
        await setState(from, { ...state, step: 'waiting_location', date: parsed.date, time: parsed.time });
        await sendWA(from, `📍 أين موقع الاجتماع؟\nأرسل رابط قوقل ماب أو اسم المكان\nأو *تخطي*`);
      } else {
        const id = Date.now();
        await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location,priority) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [id, state.taskTitle, state.taskType||'task', parsed.date, parsed.time, state.taskNote||'', '', state.priority||'normal']);
        await sendWA(from, `✅ تم تسجيل *${state.taskTitle}*\n⏰ ${fmt12(parsed.time)} - ${parsed.date}`);
        if (!owner) await sendWA(OWNER_PHONE, `📌 *مهمة جديدة من ${normalizePhone(from)}*\n\n*${state.taskTitle}*\n⏰ ${fmt12(parsed.time)}\n📅 ${parsed.date}`);
        await clearState(from);
      }
    } else {
      await sendWA(from, `❓ لم أفهم. مثال: "غداً الساعة 3 العصر"`);
    }
    return;
  }

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

  // ══════ أوامر المالك الحصرية ══════
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

    // ✅ فهم مرن للأوامر
    const cmd = detectCommand(msg);

    // ── منجز ──
    if (cmd === 'done') {
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

    // ── تأجيل ──
    if (cmd === 'postpone') {
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

    // ── حذف ──
    if (cmd === 'delete') {
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

    // ── تعديل ──
    if (cmd === 'edit') {
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

    // ✅ اليوم — مهام اليوم فقط
    if (cmd === 'today') {
      const result = await pool.query(
        'SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time', [todayStr()]
      );
      if (!result.rows.length) { await sendWA(from, `📋 لا توجد مهام لليوم ✅`); return; }
      let list = `📅 *مهام اليوم (${todayStr()}):*\n\n`;
      result.rows.forEach((t,i) => {
        const icon = t.type==='meeting'?'📅':t.type==='reminder'?'🔔':'✅';
        const urgent = t.priority==='urgent'?' 🔴':'';
        list += `${i+1}. ${icon}${urgent} *${t.title}*\n   ⏰ ${fmt12(t.time)}\n\n`;
      });
      await sendWA(from, list);
      return;
    }

    // ✅ المنجزة
    if (cmd === 'completed') {
      const result = await pool.query(
        'SELECT * FROM tasks WHERE done=true ORDER BY created_at DESC LIMIT 10'
      );
      if (!result.rows.length) { await sendWA(from, `📋 لا توجد مهام منجزة بعد`); return; }
      let list = `✅ *آخر المهام المنجزة:*\n\n`;
      result.rows.forEach((t,i) => {
        const icon = t.type==='meeting'?'📅':t.type==='reminder'?'🔔':'✅';
        list += `${i+1}. ${icon} ~~${t.title}~~\n   📅 ${t.date}\n\n`;
      });
      await sendWA(from, list);
      return;
    }

    // ✅ إحصائيات
    if (cmd === 'stats') {
      const today = todayStr();
      const weekAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString().split('T')[0];

      const todayTasks = await pool.query('SELECT COUNT(*) FROM tasks WHERE done=false AND date=$1', [today]);
      const donePeriod = await pool.query('SELECT COUNT(*) FROM tasks WHERE done=true AND created_at >= $1', [weekAgo]);
      const pending = await pool.query('SELECT COUNT(*) FROM tasks WHERE done=false');
      const meetings = await pool.query("SELECT COUNT(*) FROM tasks WHERE type='meeting' AND done=false AND date >= $1", [today]);
      const urgent = await pool.query("SELECT COUNT(*) FROM tasks WHERE priority='urgent' AND done=false");

      const msg2 = `📊 *إحصائياتك:*\n\n📅 مهام اليوم: *${todayTasks.rows[0].count}*\n📋 المعلقة الكل: *${pending.rows[0].count}*\n✅ أنجزت هذا الأسبوع: *${donePeriod.rows[0].count}*\n🤝 اجتماعات قادمة: *${meetings.rows[0].count}*\n🔴 عاجلة: *${urgent.rows[0].count}*`;
      await sendWA(from, msg2);
      return;
    }

    // ✅ بحث
    if (cmd && cmd.startsWith('search:')) {
      const keyword = cmd.replace('search:', '').trim();
      const result = await pool.query(
        "SELECT * FROM tasks WHERE title ILIKE $1 ORDER BY date,time LIMIT 10",
        [`%${keyword}%`]
      );
      if (!result.rows.length) { await sendWA(from, `🔍 لا توجد نتائج لـ "${keyword}"`); return; }
      let list = `🔍 *نتائج "${keyword}":*\n\n`;
      result.rows.forEach((t,i) => {
        const icon = t.type==='meeting'?'📅':t.type==='reminder'?'🔔':'✅';
        const status = t.done ? '~~' : '';
        list += `${i+1}. ${icon} ${status}*${t.title}*${status}\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`;
      });
      await sendWA(from, list);
      return;
    }

    // ── مهامي ──
    if (cmd === 'list') {
      const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY priority DESC, date,time LIMIT 10');
      if (!result.rows.length) { await sendWA(from, '📋 لا توجد مهام معلقة ✅'); return; }
      let list = '📋 *مهامك المعلقة:*\n\n';
      result.rows.forEach((t,i) => {
        const icon = t.type==='meeting'?'📅':t.type==='reminder'?'🔔':'✅';
        const urgent = t.priority==='urgent'?' 🔴':'';
        list += `${i+1}. ${icon}${urgent} *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`;
      });
      await sendWA(from, list);
      return;
    }

    // ── ساعات الدوام ──
    if (cmd === 'workhours' || msg.startsWith('دوام ')) {
      const wh = await getWorkingHours();
      const days = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
      const dayNames = wh.working_days.split(',').map(d => days[parseInt(d)]).join('، ');
      if (msg === 'دوام') {
        await sendWA(from, `⏰ *إعدادات الدوام الحالية:*\n\n🕐 من: ${fmt12(wh.start_time)}\n🕔 إلى: ${fmt12(wh.end_time)}\n📅 أيام العمل: ${dayNames}\n⏳ فراغ بين المواعيد: ${wh.gap_minutes} دقيقة\n\nلتعديل: أرسل *دوام 9:00 17:00*`);
      } else {
        const parts = msg.split(' ');
        if (parts.length >= 3) {
          await pool.query('UPDATE working_hours SET start_time=$1, end_time=$2, updated_at=NOW() WHERE id=1', [parts[1], parts[2]]);
          await sendWA(from, `✅ تم تحديث ساعات الدوام!\n🕐 ${fmt12(parts[1])} — ${fmt12(parts[2])}`);
        } else {
          await sendWA(from, `❓ أرسل: *دوام [وقت البداية] [وقت النهاية]*\nمثال: *دوام 8:00 17:00*`);
        }
      }
      return;
    }

    // ── جدول موعد ذكي ──
    if (cmd && cmd.startsWith('schedule:')) {
      const title = cmd.replace('schedule:', '').trim();
      await setState(from, { step: 'waiting_smart_schedule_date', title });
      await sendWA(from, `📅 جدولة: *${title}*\n\nفي أي يوم؟\nمثال: "غداً" أو "2026-03-25"`);
      return;
    }

    // ── مشاركة المهام ──
    if (cmd === 'share') {
      await setState(from, { step: 'waiting_share_phone' });
      await sendWA(from, `📤 *مشاركة المهام*

أرسل رقم واتساب الشخص:
مثال: 966501234567`);
      return;
    }


    // ── 📝 ملاحظة سريعة ──
    if (cmd && cmd.startsWith('note:')) {
      const noteText = cmd.replace('note:', '').trim();
      const id = Date.now();
      const today = todayStr();
      await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, noteText, 'task', today, '23:59', '', '']);
      await sendWA(from, `📝 تم تسجيل الملاحظة:\n\n*${noteText}*`);
      return;
    }

    // ── 🔕 إيقاف التذكيرات مؤقتاً ──
    if (cmd && cmd.startsWith('mute:')) {
      const hours = parseInt(cmd.replace('mute:', '').trim()) || 2;
      const muteUntil = new Date(Date.now() + hours * 3600000).toISOString();
      await pool.query(`
        INSERT INTO user_states (phone, state, updated_at) VALUES ($1,$2,NOW())
        ON CONFLICT (phone) DO UPDATE SET state=$2, updated_at=NOW()
      `, [OWNER_PHONE + '_mute', JSON.stringify({ until: muteUntil })]);
      await sendWA(from, `🔕 تم إيقاف التذكيرات لـ ${hours} ساعة\nحتى: ${new Date(muteUntil).toLocaleTimeString('ar-SA')}`);
      return;
    }

    // ── 🌙 وضع عدم الإزعاج ──
    if (cmd === 'dnd') {
      const until = new Date();
      until.setHours(8, 0, 0, 0);
      until.setDate(until.getDate() + 1);
      await pool.query(`
        INSERT INTO user_states (phone, state, updated_at) VALUES ($1,$2,NOW())
        ON CONFLICT (phone) DO UPDATE SET state=$2, updated_at=NOW()
      `, [OWNER_PHONE + '_mute', JSON.stringify({ until: until.toISOString() })]);
      await sendWA(from, `🌙 وضع عدم الإزعاج مفعّل\nلن أرسل تذكيرات حتى الساعة 8 ص غداً`);
      return;
    }

    // ── 👥 ذكّر شخص ──
    if (cmd && cmd.startsWith('remind_person:')) {
      const parts = cmd.replace('remind_person:', '').split(':');
      const personPhone = parts[0];
      const reminderText = parts[1];
      await sendWA(personPhone, `🔔 *تذكير من أ. عبدالعزيز:*\n\n${reminderText}`);
      await sendWA(from, `✅ تم إرسال التذكير لـ ${personPhone}`);
      return;
    }

    // ── ↩️ تراجع ──
    if (cmd === 'undo') {
      try {
        const last = await pool.query(
          "SELECT * FROM tasks ORDER BY created_at DESC LIMIT 1"
        );
        if (!last.rows.length) { await sendWA(from, `❓ لا يوجد شيء للتراجع عنه`); return; }
        const t = last.rows[0];
        const timeDiff = Date.now() - new Date(t.created_at).getTime();
        if (timeDiff > 5 * 60 * 1000) {
          await sendWA(from, `⏰ التراجع متاح فقط خلال 5 دقائق من آخر عملية`);
          return;
        }
        await pool.query('DELETE FROM tasks WHERE id=$1', [t.id]);
        await sendWA(from, `↩️ تم التراجع عن إضافة *${t.title}*`);
      } catch(e) { await sendWA(from, `❌ حدث خطأ في التراجع`); }
      return;
    }

    // ── 📌 تثبيت مهمة ──
    if (cmd === 'pin') {
      const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
      if (!result.rows.length) { await sendWA(from, '📋 لا توجد مهام ✅'); return; }
      if (result.rows.length === 1) {
        await pool.query("UPDATE tasks SET priority='urgent' WHERE id=$1", [result.rows[0].id]);
        await sendWA(from, `📌 تم تثبيت *${result.rows[0].title}* كأولوية قصوى 🔴`);
        return;
      }
      let list = '📌 *أي مهمة تثبت؟*\n\n';
      result.rows.forEach((t,i) => { list += `${i+1}. *${t.title}*\n`; });
      list += `\nأرسل الرقم`;
      await sendWA(from, list);
      await setState(from, { step: 'waiting_pin_selection', tasks: result.rows });
      return;
    }

    // ── مساعدة ──
    if (cmd === 'help') {
      await sendWA(from, `📖 *أوامر مهامي:*\n\n*إضافة:*\n• "اجتماع مع الفريق غداً الساعة 3"\n• "ذكرني بالتقرير الساعة 5"\n• أضف "عاجل" للأولوية 🔴\n• "كل أحد الساعة 9 اجتماع الفريق" (متكرر)\n• *جدول [عنوان]* - جدولة ذكية بحسب الفراغ 🧠\n\n*عرض:*\n• *مهامي* - كل المهام\n• *اليوم* - مهام اليوم\n• *المنجزة* - المنجزة\n• *إحصائيات* - ملخص سريع\n• *بحث [كلمة]* - بحث\n• *دوام* - عرض ساعات الدوام\n\n*إجراءات:*\n• *منجز* / *تأجيل* / *عدل* / *احذف*\n• *إلغاء* - إلغاء أي عملية\n• *موافق [رقم]* / *رفض [رقم]* - طلبات المواعيد
• *شارك* - مشاركة مهامك مع شخص 📤
• *ثبت* - تثبيت مهمة كأولوية 📌
• *تراجع* - التراجع عن آخر إضافة ↩️
• *أوقف [ساعات]* - إيقاف التذكيرات مؤقتاً 🔕
• *عدم الإزعاج* - لا تذكيرات حتى الصباح 🌙
• *سجل: [نص]* - ملاحظة سريعة 📝
• *ذكر [رقم] [نص]* - ذكّر شخص\n\n_تلخيص صباحي 8 ص_ 🌅 | _تقرير أسبوعي جمعة 5 م_ 📊 | _تنبيه متأخرة كل ساعة_ ⚠️`);
      return;
    }
  }

  // ══════ تحليل AI — مشترك للجميع ══════

  const parsed = await parseMessage(msg, owner);
  if (!parsed) {
    const helpMsg = owner
      ? `❓ لم أفهم. أرسل *مساعدة* للأوامر`
      : `👋 أهلاً! أنا مساعد عبدالعزيز.\n\n• 📋 *مهامي* — عرض مهام عبدالعزيز\n• 📅 "اجتماع مع عبدالعزيز غداً الساعة 3"\n• 📌 "ذكر عبدالعزيز باجتماعنا الساعة 2"\n• 🔔 "ذكرني بموعد الطبيب الساعة 5"`;
    await sendWA(from, helpMsg);
    return;
  }

  console.log(`🤖 AI: intent=${parsed.intent}, target=${parsed.target}, title=${parsed.title}`);

  // ── عرض قائمة مهام ──
  if (parsed.intent === 'list_tasks') {
    const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY priority DESC, date,time LIMIT 10');
    if (!result.rows.length) { await sendWA(from, '📋 لا توجد مهام معلقة ✅'); return; }
    let list = '📋 *مهام عبدالعزيز المعلقة:*\n\n';
    result.rows.forEach((t,i) => {
      const icon = t.type==='meeting'?'📅':t.type==='reminder'?'🔔':'✅';
      const urgent = t.priority==='urgent'?' 🔴':'';
      list += `${i+1}. ${icon}${urgent} *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`;
    });
    await sendWA(from, list);
    return;
  }

  // ── إضافة مهمة لعبدالعزيز ──
  if (parsed.intent === 'add_task' && parsed.target === 'owner') {
    if (!parsed.title) { await sendWA(from, `❓ لم أفهم عنوان المهمة`); return; }

    // مهمة متكررة
    if (parsed.recurring && parsed.time) {
      const id = Date.now();
      await pool.query('INSERT INTO recurring_tasks (id,title,type,time,note,location,frequency,day_of_week) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, parsed.title, parsed.type||'task', parsed.time, parsed.note||'', '', parsed.recurring, parsed.day_of_week]);
      const freqText = parsed.recurring === 'daily' ? 'كل يوم' : `كل أسبوع`;
      await sendWA(from, `🔁 تم تسجيل مهمة متكررة!\n📌 *${parsed.title}*\n⏰ ${fmt12(parsed.time)}\n🔄 ${freqText}`);
      return;
    }

    if (!parsed.date || !parsed.time) {
      await setState(from, { step: 'waiting_datetime', taskTitle: parsed.title, taskType: parsed.type||'task', taskNote: parsed.note||'', priority: parsed.priority||'normal' });
      await sendWA(from, `${parsed.type==='meeting'?'📅':'📌'} فهمت: *${parsed.title}*${parsed.priority==='urgent'?' 🔴':''}\n\n❓ متى وفي أي وقت؟\nمثال: "غداً الساعة 3 العصر"`);
      return;
    }

    if (parsed.type === 'meeting') {
      await setState(from, { step: 'waiting_location', taskTitle: parsed.title, taskType: 'meeting', taskNote: parsed.note||'', date: parsed.date, time: parsed.time });
      await sendWA(from, `📍 أين موقع الاجتماع؟\nأو *تخطي*`);
    } else {
      const id = Date.now();
      await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location,priority) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, parsed.title, parsed.type||'task', parsed.date, parsed.time, parsed.note||'', '', parsed.priority||'normal']);
      const urgentTxt = parsed.priority === 'urgent' ? ' 🔴' : '';
      await sendWA(from, `✅ تم تسجيل *${parsed.title}*${urgentTxt}\n⏰ ${fmt12(parsed.time)} - ${parsed.date}`);
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

  // ✅ ذكاء اصطناعي احتياطي — يحاول يفهم الرسالة بدل "لم أفهم"
  const fallback = await trySmartFallback(msg, from, owner);
  if (fallback?.understood && fallback.action !== 'unknown') {
    if (fallback.action === 'list_tasks') {
      const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY priority DESC, date,time LIMIT 10');
      if (!result.rows.length) { await sendWA(from, '📋 لا توجد مهام معلقة ✅'); return; }
      let list = '📋 *مهامك المعلقة:*\n\n';
      result.rows.forEach((t,i) => {
        const icon = t.type==='meeting'?'📅':t.type==='reminder'?'🔔':'✅';
        list += `${i+1}. ${icon} *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`;
      });
      await sendWA(from, list);
    } else if (fallback.action === 'help') {
      await sendWA(from, owner
        ? `📖 أرسل *مساعدة* لقائمة الأوامر الكاملة`
        : `👋 أهلاً! أنا مساعد عبدالعزيز.\n• 📋 *مهامي*\n• 📅 "اجتماع مع عبدالعزيز..."\n• 🔔 "ذكرني بـ..."`
      );
    } else {
      // يعيد المحاولة بالـ suggestion المفهومة
      await sendWA(from, `🤔 هل تقصد: "${fallback.suggestion}"؟\nأرسل *نعم* أو وضح أكثر`);
      await setState(from, { step: 'waiting_clarification', suggestion: fallback.suggestion, original: msg });
    }
  } else {
    const helpMsg = owner
      ? `❓ لم أفهم رسالتك.\nأرسل *مساعدة* لعرض الأوامر`
      : `👋 أهلاً! أنا مساعد عبدالعزيز.\n\n• 📋 *مهامي* — عرض مهام عبدالعزيز\n• 📅 "اجتماع مع عبدالعزيز غداً الساعة 3"\n• 📌 "ذكر عبدالعزيز باجتماعنا الساعة 2"\n• 🔔 "ذكرني بموعد الطبيب الساعة 5"`;
    await sendWA(from, helpMsg);
  }
});

// ─── API للواجهة ───────────────────────────────────────────────────────────
app.get('/tasks', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tasks ORDER BY date,time');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/tasks', async (req, res) => {
  const { title, type, date, time, note, location, priority } = req.body;
  if (!title || !date || !time) return res.status(400).json({ error: 'بيانات ناقصة' });
  const id = Date.now();
  try {
    await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location,priority) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, title, type||'task', date, time, note||'', location||'', priority||'normal']);
    res.json({ id, title, type:type||'task', date, time, note:note||'', location:location||'', priority:priority||'normal', done:false });
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

app.get('/recurring-tasks', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM recurring_tasks ORDER BY created_at');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/appointment-requests', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM appointment_requests ORDER BY created_at DESC');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/working-hours', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM working_hours WHERE id=1');
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/working-hours', async (req, res) => {
  const { start_time, end_time, working_days, gap_minutes } = req.body;
  try {
    await pool.query(
      'UPDATE working_hours SET start_time=$1, end_time=$2, working_days=$3, gap_minutes=$4, updated_at=NOW() WHERE id=1',
      [start_time, end_time, working_days, gap_minutes]
    );
    const result = await pool.query('SELECT * FROM working_hours WHERE id=1');
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/free-slots/:date', async (req, res) => {
  try {
    const slots = await findFreeSlots(req.params.date);
    res.json({ date: req.params.date, slots });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => {
  res.json({ status: '🟢 مهامي شغّال', time: new Date().toLocaleString('ar-SA') });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 مهامي شغّال على port ${PORT}`));

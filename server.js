const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use((req,res,next)=>{res.header('Access-Control-Allow-Origin','*');res.header('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');res.header('Access-Control-Allow-Headers','Content-Type');if(req.method==='OPTIONS')return res.sendStatus(200);next();});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(__dirname));
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

const PHONE       = '966563466639';
const GA_INSTANCE = '7107577151';
const GA_TOKEN    = 'bf8e5a28cfdc41fabb681fe798d38a303a7a681653c34caeb3';
const GA_URL      = `https://7107.api.greenapi.com/waInstance${GA_INSTANCE}`;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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
      priority TEXT DEFAULT 'normal',
      requested_by TEXT DEFAULT '',
      requested_by_name TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS location TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal'`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS requested_by TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS requested_by_name TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS visitors (
      phone TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      msg_count INTEGER DEFAULT 0,
      last_seen TIMESTAMP DEFAULT NOW(),
      last_request TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE visitors ADD COLUMN IF NOT EXISTS last_request TEXT DEFAULT ''`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ratings (
      id BIGINT PRIMARY KEY,
      phone TEXT,
      name TEXT,
      task_id BIGINT,
      rating INTEGER,
      feedback TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  // تأكد من وجود إعداد busy_mode
  await pool.query(`INSERT INTO settings (key, value) VALUES ('busy_mode', 'false') ON CONFLICT (key) DO NOTHING`);


  console.log('✅ قاعدة البيانات جاهزة');
}
initDB();

let sentReminders = new Set();
const userState = {};

// ─── إرسال واتساب ─────────────────────────────────────────────────────────
async function sendWA(to, message) {
  try {
    const chatId = to.includes('@') ? to : `${to}@c.us`;
    await axios.post(`${GA_URL}/sendMessage/${GA_TOKEN}`, { chatId, message });
  } catch(e) { console.error('WA Error:', e.message); }
}

// ─── مساعدات ──────────────────────────────────────────────────────────────
function fmt12(time24) {
  if (!time24) return '';
  const [h, m] = time24.split(':').map(Number);
  const p = h < 12 ? 'ص' : 'م';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2,'0')} ${p}`;
}

function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
}

function greeting() {
  const h = new Date().toLocaleString('en-US', { timeZone: 'Asia/Riyadh', hour: 'numeric', hour12: false });
  const hour = parseInt(h);
  return hour < 12 ? 'صباح الخير' : hour < 17 ? 'مساء الخير' : 'مساء النور';
}

// ─── رسالة الترحيب للزوار ─────────────────────────────────────────────────
function welcomeMsg() {
  return `${greeting()} 👋\nهلا وغلا! أنا المساعد الشخصي لعبدالعزيز ✨\n\nأقدر أساعدك في:\n📌 تسجيل مهمة أو طلب له\n📅 جدولة اجتماع معه\n🔔 تذكيره بشيء أو تذكيرك أنت بشيء\n\nكل اللي تحتاجه — قوله وأنا أوصّله على طول 🚀\n\nممكن تشرّفني باسمك عشان أقدر أخدمك أكثر؟ 😊`;
}

function menuMsg(name) {
  return `هلا ${name}! 😊\nوش أقدر أساعدك فيه اليوم؟\n\n1️⃣ تسجيل مهمة أو طلب لعبدالعزيز\n2️⃣ جدولة اجتماع معه\n3️⃣ تذكير عبدالعزيز بشيء\n4️⃣ تذكيرك أنت بشيء\n\nأرسل الرقم أو اكتب طلبك مباشرة 👇`;
}

function notUnderstandMsg() {
  return `ما فهمت وضح أكثر 😊\nأو اختر من القائمة:\n\n1️⃣ مهمة / 2️⃣ اجتماع / 3️⃣ تذكير لعبدالعزيز / 4️⃣ تذكيرك أنت`;
}

// ─── رسالة تذكير لعبدالعزيز ───────────────────────────────────────────────
function buildTaskMsg(t) {
  const icons = { meeting: '📅 اجتماع', task: '✅ مهمة', reminder: '🔔 تذكير' };
  const gr = greeting();
  let msg = `${gr} عبدالعزيز 🌟\n\n`;
  msg += `${icons[t.type] || '📌 مهمة'}\n`;
  msg += `📌 *${t.title}*\n`;
  if (t.time) msg += `⏰ ${fmt12(t.time)}\n`;
  if (t.note) msg += `📝 ${t.note}\n`;
  if (t.location) msg += `📍 ${t.location}\n`;
  msg += `\n─────────────\n`;
  msg += `رد بـ *منجز* لتأكيد الإنجاز\n`;
  msg += `رد بـ *تأجيل* لتأجيلها ساعة\n`;
  msg += `\n_مهامي_ ✨`;
  return msg;
}

// ─── إشعار طلب جديد لعبدالعزيز ───────────────────────────────────────────
function buildRequestNotification(name, phone, type, details, date, time) {
  const typeLabel = type === 'meeting' ? 'اجتماع' : type === 'reminder' ? 'تذكير' : 'مهمة';
  let msg = `📬 *طلب جديد من ${name}*\n\n`;
  msg += `📌 النوع: ${typeLabel}\n`;
  msg += `📝 التفاصيل: ${details}\n`;
  if (date) msg += `📅 التاريخ: ${date}\n`;
  if (time) msg += `⏰ الوقت: ${fmt12(time)}\n`;
  msg += `\n─────────────\n`;
  msg += `رد بـ *قبول ${name}* لاعتماد الطلب ✅\n`;
  msg += `رد بـ *رفض ${name}* لرفضه ❌`;
  return msg;
}

// ─── AI: استخراج المهمة ───────────────────────────────────────────────────
async function parseTaskFromMessage(msg) {
  try {
    const todayISO = todayStr();
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `اليوم هو ${todayISO}. استخرج معلومات المهمة من هذه الرسالة وأعد JSON فقط بدون أي نص إضافي أو markdown:
{"title":"عنوان المهمة","type":"task أو meeting أو reminder","date":"YYYY-MM-DD أو null","time":"HH:MM أو null","note":"ملاحظة أو فارغة"}

قواعد:
- اجتماع أو لقاء أو مقابلة → type: meeting
- تذكير أو ذكرني → type: reminder
- غير ذلك → type: task
- إذا لم يُذكر تاريخ → date: null
- إذا لم يُذكر وقت → time: null

الرسالة: "${msg}"`
      }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    });
    const text = response.data.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch(e) { console.error('AI Error:', e.message); return null; }
}

// ─── نظام التعلم الذاتي ───────────────────────────────────────────────────
async function getLessons() {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key='nawaf_lessons'");
    if (r.rows.length && r.rows[0].value) return r.rows[0].value;
    return '';
  } catch(e) { return ''; }
}

async function saveLessons(lessons) {
  try {
    await pool.query(`INSERT INTO settings (key, value) VALUES ('nawaf_lessons', $1) ON CONFLICT (key) DO UPDATE SET value=$1`, [lessons]);
  } catch(e) { console.error('Save lessons error:', e.message); }
}

async function learnFromConversation(visitorName, history, rating, feedback) {
  if (history.length < 2) return;
  try {
    const currentLessons = await getLessons();
    const historyText = history.map(h => `${h.role === 'visitor' ? visitorName : 'نواف'}: ${h.msg}`).join('\n');
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `أنت مدرب لتطوير "نواف" المساعد الذكي.

الدروس الحالية المحفوظة:
${currentLessons || 'لا يوجد دروس بعد'}

محادثة جديدة مع ${visitorName}:
${historyText}

${rating ? `تقييم الزائر: ${rating}/5` : ''}
${feedback ? `ملاحظة الزائر: ${feedback}` : ''}

حلل هذه المحادثة واستخرج دروساً جديدة لتطوير نواف.
أعد قائمة دروس محدثة (الحالية + الجديدة) بحد أقصى 15 درس.
كل درس في سطر يبدأ بـ "•"
ركز على: أسلوب الرد، فهم الطلبات، التعامل مع المواقف المختلفة.
لا تكرر الدروس الموجودة.`
      }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    });
    const lessons = response.data.content[0].text.trim();
    await saveLessons(lessons);
    console.log('🧠 نواف تعلم من محادثة جديدة');
  } catch(e) { console.error('Learn error:', e.message); }
}

// ─── AI: رد نواف الذكي للزوار ─────────────────────────────────────────────
async function nawafReply(visitorName, msg, history) {
  try {
    const historyText = history.slice(-6).map(h => `${h.role === 'visitor' ? visitorName : 'نواف'}: ${h.msg}`).join('\n');
    const lessons = await getLessons();

    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `أنت "نواف" المساعد الشخصي لعبدالعزيز على واتساب.
شخصيتك: خليجي ودي، دافئ، طبيعي، تتكلم عامية سعودية.
مهمتك: مساعدة الزوار في التواصل مع عبدالعزيز فقط.
لا تكشف أي معلومات شخصية عن عبدالعزيز.
لا تخرج عن إطار مساعدة عبدالعزيز.
إذا طال الكلام بدون طلب محدد، وجّه برفق للقائمة.

${lessons ? `دروس تعلمتها من محادثات سابقة:\n${lessons}\n` : ''}

سجل المحادثة:
${historyText}

${visitorName}: ${msg}

رد قصير وطبيعي بالعامية السعودية (جملة أو جملتين فقط).
إذا كان الكلام تحية أو دردشة، رد بشكل طبيعي.
إذا كان طلب محدد (مهمة/اجتماع/تذكير) قل له "تمام، أرسل لي التفاصيل".`
      }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    });
    return response.data.content[0].text.trim();
  } catch(e) { console.error('Nawaf AI Error:', e.message); return null; }
}

// ─── Cron: تذكيرات ────────────────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  const today = todayStr();
  const now = new Date();
  const cur = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  try {
    const res = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 AND time=$2', [today, cur]);
    for (const t of res.rows) {
      if (!sentReminders.has(`exact_${t.id}`)) {
        sentReminders.add(`exact_${t.id}`);
        await sendWA(PHONE, buildTaskMsg(t));
      }
    }
  } catch(e) { console.error('Cron error:', e.message); }

  try {
    const in15 = new Date(now.getTime() + 15 * 60000);
    const pre = `${String(in15.getHours()).padStart(2,'0')}:${String(in15.getMinutes()).padStart(2,'0')}`;
    const res = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 AND time=$2', [today, pre]);
    for (const t of res.rows) {
      if (!sentReminders.has(`pre15_${t.id}`)) {
        sentReminders.add(`pre15_${t.id}`);
        let msg = `⏰ *تذكير مسبق — بعد 15 دقيقة*\n\n📌 *${t.title}*\n🕐 ${fmt12(t.time)}\n`;
        if (t.note) msg += `📝 ${t.note}\n`;
        if (t.location) msg += `📍 ${t.location}\n`;
        msg += `\n_مهامي_ ✨`;
        await sendWA(PHONE, msg);
      }
    }
  } catch(e) { console.error('Pre-reminder error:', e.message); }

  try {
    const in60 = new Date(now.getTime() + 60 * 60000);
    const pre60 = `${String(in60.getHours()).padStart(2,'0')}:${String(in60.getMinutes()).padStart(2,'0')}`;
    const res = await pool.query("SELECT * FROM tasks WHERE done=false AND type='meeting' AND date=$1 AND time=$2", [today, pre60]);
    for (const t of res.rows) {
      if (!sentReminders.has(`meeting60_${t.id}`)) {
        sentReminders.add(`meeting60_${t.id}`);
        let msg = `📅 *تأكيد اجتماع — بعد ساعة*\n\n📌 *${t.title}*\n⏰ ${fmt12(t.time)}\n`;
        if (t.location) msg += `📍 *الموقع:* ${t.location}\n`;
        if (t.note) msg += `📝 ${t.note}\n`;
        msg += `\nاستعد واتفق مع المشاركين 💼\n_مهامي_ ✨`;
        await sendWA(PHONE, msg);
      }
    }
  } catch(e) { console.error('Meeting confirm error:', e.message); }
}, { timezone: 'Asia/Riyadh' });

// ─── وضع الغياب ───────────────────────────────────────────────────────────
async function isBusy() {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key='busy_mode'");
    return r.rows[0]?.value === 'true';
  } catch(e) { return false; }
}

async function setBusy(val) {
  await pool.query(`INSERT INTO settings (key, value) VALUES ('busy_mode', $1) ON CONFLICT (key) DO UPDATE SET value=$1`, [val ? 'true' : 'false']);
}

// ─── Cron: تقرير أسبوعي كل جمعة 5 م ─────────────────────────────────────
cron.schedule('0 17 * * 5', async () => {
  try {
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
    const today = todayStr();

    const total = await pool.query('SELECT COUNT(*) FROM tasks WHERE created_at >= $1', [weekAgoStr]);
    const approved = await pool.query("SELECT COUNT(*) FROM tasks WHERE status='approved' AND created_at >= $1", [weekAgoStr]);
    const rejected = await pool.query("SELECT COUNT(*) FROM tasks WHERE status='rejected' AND created_at >= $1", [weekAgoStr]);
    const pending = await pool.query("SELECT COUNT(*) FROM tasks WHERE status='pending' AND done=false", []);
    const visitors = await pool.query('SELECT COUNT(*) FROM visitors WHERE created_at >= $1', [weekAgoStr]);
    const ratings = await pool.query('SELECT AVG(rating) FROM ratings WHERE created_at >= $1', [weekAgoStr]);

    const avg = ratings.rows[0]?.avg ? parseFloat(ratings.rows[0].avg).toFixed(1) : '—';
    const stars = avg !== '—' ? '⭐'.repeat(Math.round(avg)) : '—';

    let msg = `📊 *تقرير الأسبوع*\n`;
    msg += `📅 ${weekAgoStr} ← ${today}\n`;
    msg += `─────────────\n\n`;
    msg += `📬 طلبات وصلت: *${total.rows[0].count}*\n`;
    msg += `✅ اعتمدت: *${approved.rows[0].count}*\n`;
    msg += `❌ رفضت: *${rejected.rows[0].count}*\n`;
    msg += `⏳ معلقة: *${pending.rows[0].count}*\n`;
    msg += `👤 زوار جدد: *${visitors.rows[0].count}*\n`;
    if (avg !== '—') msg += `⭐ متوسط التقييم: *${avg}/5* ${stars}\n`;
    msg += `\n_مهامي_ ✨`;

    await sendWA(PHONE, msg);

    // تعلم أسبوعي تلقائي
    try {
      const recentTasks = await pool.query(
        "SELECT * FROM tasks WHERE requested_by != '' AND created_at >= $1 ORDER BY created_at DESC LIMIT 20",
        [weekAgoStr]
      );
      const recentRatings = await pool.query('SELECT * FROM ratings WHERE created_at >= $1', [weekAgoStr]);
      if (recentTasks.rows.length > 0) {
        const summary = recentTasks.rows.map(t => `${t.requested_by_name}: طلب "${t.title}" (${t.status})`).join('\n');
        const ratingsSummary = recentRatings.rows.map(r => `${r.name}: ${r.rating}/5${r.feedback ? ` — "${r.feedback}"` : ''}`).join('\n');
        setImmediate(() => learnFromConversation('تحليل أسبوعي', [
          { role: 'visitor', msg: `ملخص الطلبات:\n${summary}` },
          { role: 'visitor', msg: ratingsSummary ? `ملخص التقييمات:\n${ratingsSummary}` : 'لا توجد تقييمات' }
        ], null, ''));
        console.log('🧠 بدأ التعلم الأسبوعي');
      }
    } catch(e) { console.error('Weekly learn error:', e.message); }

    console.log('📊 أُرسل التقرير الأسبوعي');
  } catch(e) { console.error('Weekly report error:', e.message); }
}, { timezone: 'Asia/Riyadh' });

// ─── Cron: ملخص صباحي 8 ص ────────────────────────────────────────────────
cron.schedule('0 8 * * *', async () => {
  const today = todayStr();
  try {
    const res = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time', [today]);
    const over = await pool.query('SELECT * FROM tasks WHERE done=false AND date < $1 ORDER BY date, time', [today]);
    let msg = `🌅 *صباح الخير عبدالعزيز*\n`;
    msg += `📅 ${new Date().toLocaleDateString('ar-SA', { weekday:'long', day:'numeric', month:'long', timeZone:'Asia/Riyadh' })}\n`;
    msg += `─────────────\n\n`;
    if (res.rows.length === 0) {
      msg += `✨ ما عندك مهام اليوم — يوم خفيف!\n`;
    } else {
      msg += `📋 *مهام اليوم (${res.rows.length}):*\n\n`;
      res.rows.forEach((t, i) => {
        const icon = t.type === 'meeting' ? '📅' : t.type === 'reminder' ? '🔔' : '✅';
        msg += `${i+1}. ${icon} *${t.title}*`;
        if (t.time) msg += ` — ${fmt12(t.time)}`;
        if (t.requested_by_name) msg += ` (من ${t.requested_by_name})`;
        msg += `\n`;
        if (t.location) msg += `   📍 ${t.location}\n`;
      });
    }
    if (over.rows.length > 0) {
      msg += `\n⚠️ *متأخرة (${over.rows.length}):*\n`;
      over.rows.slice(0, 3).forEach(t => { msg += `• ${t.title} — ${t.date}\n`; });
    }
    msg += `\n_مهامي_ ✨ — يوم موفق!`;
    await sendWA(PHONE, msg);
  } catch(e) { console.error('Morning summary error:', e.message); }
}, { timezone: 'Asia/Riyadh' });

// ─── Webhook ───────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;

  const typeWebhook = body?.typeWebhook;
  if (typeWebhook !== 'incomingMessageReceived') return;

  const msg  = body?.messageData?.textMessageData?.textMessage?.trim();
  const from = body?.senderData?.chatId?.replace('@c.us', '');
  if (!msg || !from) return;
  console.log(`📩 رسالة من: ${from} — ${msg}`);

  // ─── رسائل عبدالعزيز ─────────────────────────────────────────────────
  if (from === PHONE) {
    await handleOwnerMessage(from, msg);
    return;
  }

  // ─── رسائل الزوار ────────────────────────────────────────────────────
  await handleVisitorMessage(from, msg);
});

// ─── معالجة رسائل عبدالعزيز ──────────────────────────────────────────────
async function handleOwnerMessage(from, msg) {
  const state = userState[from] || { step: 'idle' };

  // ═══ أولاً: قبول/رفض/اعتمد — يُعالج فوراً قبل أي شيء ═══

  // --- اعتمد (آخر طلب معلق) ---
  if (msg === 'اعتمد' || msg === 'موافق' || msg === 'تم الاعتماد') {
    try {
      const result = await pool.query(
        "SELECT * FROM tasks WHERE status='pending' AND requested_by != '' ORDER BY created_at DESC LIMIT 1"
      );
      if (result.rows.length > 0) {
        const t = result.rows[0];
        const vName = t.requested_by_name;
        await pool.query('UPDATE tasks SET status=$1 WHERE id=$2', ['approved', t.id]);
        await sendWA(t.requested_by, `هلا ${vName} 👋\nعبدالعزيز اعتمد طلبك ✅\n📌 ${t.title}${t.date ? `\n📅 ${t.date}` : ''}${t.time ? `\n⏰ ${fmt12(t.time)}` : ''}`);
        await sendWA(from, `✅ تم اعتماد طلب ${vName} وإبلاغه`);
        setTimeout(async () => {
          await sendWA(t.requested_by, `هلا ${vName}! 😊\nتم تنفيذ طلبك ✅\nكيف كانت تجربتك معنا؟\n\n1️⃣ ضعيف\n3️⃣ متوسط\n5️⃣ ممتاز\n\nعندك ملاحظات أو اقتراحات؟ أهلاً بها، رأيك يطورنا! 😊`);
          userState[t.requested_by] = { ...userState[t.requested_by], step: 'waiting_rating', taskId: t.id, visitorName: vName };
        }, 30000);
      } else {
        await sendWA(from, `❓ ما في طلبات معلقة الحين`);
      }
    } catch(e) { console.error(e.message); }
    return;
  }

  // --- قبول [اسم] ---
  if (msg.startsWith('قبول ')) {
    const visitorName = msg.replace('قبول ', '').trim();
    try {
      const result = await pool.query(
        "SELECT * FROM tasks WHERE requested_by_name=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1",
        [visitorName]
      );
      if (result.rows.length > 0) {
        const t = result.rows[0];
        await pool.query('UPDATE tasks SET status=$1 WHERE id=$2', ['approved', t.id]);
        await sendWA(t.requested_by, `هلا ${visitorName} 👋\nعبدالعزيز اعتمد طلبك ✅\n📌 ${t.title}${t.date ? `\n📅 ${t.date}` : ''}${t.time ? `\n⏰ ${fmt12(t.time)}` : ''}`);
        await sendWA(from, `✅ تم قبول طلب ${visitorName} وإبلاغه`);
        setTimeout(async () => {
          await sendWA(t.requested_by, `هلا ${visitorName}! 😊\nتم تنفيذ طلبك ✅\nكيف كانت تجربتك معنا؟\n\n1️⃣ ضعيف\n3️⃣ متوسط\n5️⃣ ممتاز\n\nعندك ملاحظات أو اقتراحات؟ أهلاً بها، رأيك يطورنا! 😊`);
          userState[t.requested_by] = { ...userState[t.requested_by], step: 'waiting_rating', taskId: t.id, visitorName };
        }, 30000);
      } else {
        await sendWA(from, `❓ ما لقيت طلب معلق من ${visitorName}`);
      }
    } catch(e) { console.error(e.message); }
    return;
  }

  // --- رفض [اسم] ---
  if (msg.startsWith('رفض ')) {
    const visitorName = msg.replace('رفض ', '').trim();
    try {
      const result = await pool.query(
        "SELECT * FROM tasks WHERE requested_by_name=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1",
        [visitorName]
      );
      if (result.rows.length > 0) {
        const t = result.rows[0];
        await pool.query('UPDATE tasks SET status=$1 WHERE id=$2', ['rejected', t.id]);
        await sendWA(t.requested_by, `هلا ${visitorName} 👋\nاعتذر، عبدالعزيز غير قادر في هذا الوقت ❌\nلو تبغى وقت ثاني أنا هنا لخدمتك 😊`);
        await sendWA(from, `❌ تم رفض طلب ${visitorName} وإبلاغه`);
      } else {
        await sendWA(from, `❓ ما لقيت طلب معلق من ${visitorName}`);
      }
    } catch(e) { console.error(e.message); }
    return;
  }

  // --- رفض (آخر طلب معلق) ---
  if (msg === 'رفض' || msg === 'مرفوض') {
    try {
      const result = await pool.query(
        "SELECT * FROM tasks WHERE status='pending' AND requested_by != '' ORDER BY created_at DESC LIMIT 1"
      );
      if (result.rows.length > 0) {
        const t = result.rows[0];
        const vName = t.requested_by_name;
        await pool.query('UPDATE tasks SET status=$1 WHERE id=$2', ['rejected', t.id]);
        await sendWA(t.requested_by, `هلا ${vName} 👋\nاعتذر، عبدالعزيز غير قادر في هذا الوقت ❌\nلو تبغى وقت ثاني أنا هنا لخدمتك 😊`);
        await sendWA(from, `❌ تم رفض طلب ${vName} وإبلاغه`);
      } else {
        await sendWA(from, `❓ ما في طلبات معلقة الحين`);
      }
    } catch(e) { console.error(e.message); }
    return;
  }

  // ═══ باقي الأوامر ═══

  // --- وضع الغياب ---
  if (msg === 'مشغول' || msg === 'في اجتماع') {
    await setBusy(true);
    await sendWA(from, `🔕 تم تفعيل وضع الغياب — نواف سيرد على الزوار تلقائياً`);
    return;
  }

  if (msg === 'رجعت' || msg === 'خلصت' || msg.startsWith('خلصت')) {
    await setBusy(false);
    const today = todayStr();
    const now = new Date();
    const curTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const result = await pool.query(
      'SELECT * FROM tasks WHERE done=false AND date=$1 AND time>$2 ORDER BY time',
      [today, curTime]
    );
    if (result.rows.length === 0) {
      await sendWA(from, `✅ تم إيقاف وضع الغياب\n\nما في مهام باقية اليوم 🎉`);
    } else {
      let reply = `✅ تم إيقاف وضع الغياب\n\nباقي اليوم:\n\n`;
      result.rows.forEach((t, i) => {
        const icon = t.type === 'meeting' ? '📅' : t.type === 'reminder' ? '🔔' : '✅';
        reply += `${i+1}. ${icon} *${t.title}* — ${fmt12(t.time)}\n`;
      });
      await sendWA(from, reply);
    }
    return;
  }

  // --- انتظار الوقت والتاريخ ---
  if (state.step === 'waiting_datetime') {
    const parsed = await parseTaskFromMessage(`${state.taskTitle} ${msg}`);
    if (parsed && parsed.date && parsed.time) {
      if (state.taskType === 'meeting') {
        userState[from] = { ...state, step: 'waiting_location', date: parsed.date, time: parsed.time };
        await sendWA(from, `📍 أين موقع الاجتماع؟\nأو أرسل *تخطي*`);
      } else {
        const id = Date.now();
        await pool.query('INSERT INTO tasks (id, title, type, date, time, note, location) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [id, state.taskTitle, state.taskType||'task', parsed.date, parsed.time, state.taskNote||'', '']);
        await sendWA(from, `✅ تم التسجيل!\n📌 *${state.taskTitle}*\n⏰ ${fmt12(parsed.time)}\n📅 ${parsed.date}`);
        userState[from] = { step: 'idle' };
      }
    } else {
      await sendWA(from, `❓ لم أفهم الوقت. مثال: "غداً الساعة 3 العصر"`);
    }
    return;
  }

  // --- انتظار الموقع ---
  if (state.step === 'waiting_location') {
    const location = msg === 'تخطي' ? '' : msg;
    const id = Date.now();
    await pool.query('INSERT INTO tasks (id, title, type, date, time, note, location) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, state.taskTitle, 'meeting', state.date, state.time, state.taskNote||'', location]);
    let reply = `✅ تم تسجيل الاجتماع!\n📌 *${state.taskTitle}*\n⏰ ${fmt12(state.time)}\n📅 ${state.date}`;
    if (location) reply += `\n📍 ${location}`;
    await sendWA(from, reply);
    userState[from] = { step: 'idle' };
    return;
  }

  // --- انتظار اختيار للإنجاز ---
  if (state.step === 'waiting_done_selection') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
      const t = state.tasks[num - 1];
      await pool.query('UPDATE tasks SET done=true WHERE id=$1', [t.id]);
      await sendWA(from, `✅ *${t.title}* تم إنجازها 🎉`);
      userState[from] = { step: 'idle' };
    } else { await sendWA(from, `❓ أرسل رقم من القائمة`); }
    return;
  }

  // --- انتظار اختيار للتأجيل ---
  if (state.step === 'waiting_postpone_selection') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
      const t = state.tasks[num - 1];
      if (state.smartTime) {
        const parsed = await parseTaskFromMessage(`مهمة في ${state.smartTime}`);
        if (parsed && parsed.time) {
          await pool.query('UPDATE tasks SET time=$1 WHERE id=$2', [parsed.time, t.id]);
          sentReminders.delete(`exact_${t.id}`); sentReminders.delete(`pre15_${t.id}`);
          await sendWA(from, `⏰ تم تأجيل *${t.title}* لـ ${fmt12(parsed.time)}`);
        }
      } else {
        const [h, m] = t.time.split(':').map(Number);
        const d = new Date(); d.setHours(h + 1, m);
        const newTime = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        await pool.query('UPDATE tasks SET time=$1 WHERE id=$2', [newTime, t.id]);
        sentReminders.delete(`exact_${t.id}`);
        await sendWA(from, `⏰ تم تأجيل *${t.title}* لـ ${fmt12(newTime)}`);
      }
      userState[from] = { step: 'idle' };
    } else { await sendWA(from, `❓ أرسل رقم من القائمة`); }
    return;
  }

  // --- انتظار اختيار للحذف ---
  if (state.step === 'waiting_delete_selection') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
      const t = state.tasks[num - 1];
      await pool.query('DELETE FROM tasks WHERE id=$1', [t.id]);
      await sendWA(from, `🗑️ تم حذف *${t.title}*`);
      userState[from] = { step: 'idle' };
    } else { await sendWA(from, `❓ أرسل رقم من القائمة`); }
    return;
  }

  // --- انتظار اختيار للتعديل ---
  if (state.step === 'waiting_edit_selection') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
      const t = state.tasks[num - 1];
      userState[from] = { step: 'waiting_edit_field', task: t };
      let opts = `✏️ *تعديل: ${t.title}*\n\n1. العنوان\n2. الوقت\n3. التاريخ\n4. الملاحظة`;
      if (t.type === 'meeting') opts += `\n5. الموقع`;
      opts += `\n\nأرسل الرقم فقط`;
      await sendWA(from, opts);
    } else { await sendWA(from, `❓ أرسل رقم من القائمة`); }
    return;
  }

  // --- انتظار حقل التعديل ---
  if (state.step === 'waiting_edit_field') {
    const num = parseInt(msg);
    const t = state.task;
    const fields = { 1:'title', 2:'time', 3:'date', 4:'note', 5:'location' };
    const labels = { 1:'العنوان الجديد', 2:'الوقت الجديد', 3:'التاريخ الجديد', 4:'الملاحظة الجديدة', 5:'الموقع الجديد' };
    if (fields[num] && (num !== 5 || t.type === 'meeting')) {
      userState[from] = { step: 'waiting_edit_value', task: t, field: fields[num] };
      await sendWA(from, `✏️ أرسل ${labels[num]}:`);
    } else { await sendWA(from, `❓ أرسل رقم صحيح`); }
    return;
  }

  // --- انتظار قيمة التعديل ---
  if (state.step === 'waiting_edit_value') {
    const t = state.task;
    const field = state.field;
    let newValue = msg;
    if (field === 'time' || field === 'date') {
      const parsed = await parseTaskFromMessage(`مهمة ${field === 'time' ? msg : 'في ' + msg}`);
      if (field === 'time' && parsed?.time) newValue = parsed.time;
      else if (field === 'date' && parsed?.date) newValue = parsed.date;
      else { await sendWA(from, `❓ لم أفهم، أرسل مثلاً: "الساعة 3 العصر"`); return; }
    }
    await pool.query(`UPDATE tasks SET ${field}=$1 WHERE id=$2`, [newValue, t.id]);
    const fieldNames = { title:'العنوان', time:'الوقت', date:'التاريخ', note:'الملاحظة', location:'الموقع' };
    await sendWA(from, `✅ تم تعديل ${fieldNames[field]}!`);
    userState[from] = { step: 'idle' };
    return;
  }

  // --- منجز ---
  if (msg === 'منجز' || msg === 'تم') {
    const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date, time LIMIT 10');
    if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام معلقة ✅'); return; }
    if (result.rows.length === 1) {
      await pool.query('UPDATE tasks SET done=true WHERE id=$1', [result.rows[0].id]);
      await sendWA(from, `✅ *${result.rows[0].title}* تم إنجازها 🎉`); return;
    }
    let list = '✅ *أي مهمة أنجزت؟*\n\n';
    result.rows.forEach((t, i) => { list += `${i+1}. *${t.title}* — ${fmt12(t.time)} ${t.date}\n`; });
    list += `\nأرسل الرقم`;
    await sendWA(from, list);
    userState[from] = { step: 'waiting_done_selection', tasks: result.rows };
    return;
  }

  // --- تأجيل ---
  if (msg === 'تأجيل' || msg.startsWith('أجل ') || msg.startsWith('اجل ')) {
    const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date, time LIMIT 10');
    if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام ✅'); return; }
    const smartTime = (msg.startsWith('أجل ') || msg.startsWith('اجل ')) ? msg.replace(/^(أجل|اجل)\s+/, '') : null;
    if (result.rows.length === 1) {
      const t = result.rows[0];
      if (smartTime) {
        const parsed = await parseTaskFromMessage(`مهمة في ${smartTime}`);
        if (parsed?.time) {
          await pool.query('UPDATE tasks SET time=$1 WHERE id=$2', [parsed.time, t.id]);
          sentReminders.delete(`exact_${t.id}`);
          await sendWA(from, `⏰ تم تأجيل *${t.title}* لـ ${fmt12(parsed.time)}`);
        }
      } else {
        const [h, m] = t.time.split(':').map(Number);
        const d = new Date(); d.setHours(h + 1, m);
        const newTime = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        await pool.query('UPDATE tasks SET time=$1 WHERE id=$2', [newTime, t.id]);
        sentReminders.delete(`exact_${t.id}`);
        await sendWA(from, `⏰ تم تأجيل *${t.title}* لـ ${fmt12(newTime)}`);
      }
      return;
    }
    let list = '⏰ *أي مهمة تريد تأجيلها؟*\n\n';
    result.rows.forEach((t, i) => { list += `${i+1}. *${t.title}* — ${fmt12(t.time)}\n`; });
    list += `\nأرسل الرقم`;
    await sendWA(from, list);
    userState[from] = { step: 'waiting_postpone_selection', tasks: result.rows, smartTime };
    return;
  }

  // --- احذف ---
  if (msg === 'احذف' || msg === 'حذف') {
    const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date, time LIMIT 10');
    if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام ✅'); return; }
    if (result.rows.length === 1) {
      await pool.query('DELETE FROM tasks WHERE id=$1', [result.rows[0].id]);
      await sendWA(from, `🗑️ تم حذف *${result.rows[0].title}*`); return;
    }
    let list = '🗑️ *أي مهمة تريد حذفها؟*\n\n';
    result.rows.forEach((t, i) => { list += `${i+1}. *${t.title}* — ${t.date}\n`; });
    await sendWA(from, list);
    userState[from] = { step: 'waiting_delete_selection', tasks: result.rows };
    return;
  }

  // --- عدل ---
  if (msg === 'عدل' || msg === 'تعديل') {
    const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date, time LIMIT 10');
    if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام ✅'); return; }
    if (result.rows.length === 1) {
      const t = result.rows[0];
      userState[from] = { step: 'waiting_edit_field', task: t };
      let opts = `✏️ *تعديل: ${t.title}*\n\n1. العنوان\n2. الوقت\n3. التاريخ\n4. الملاحظة`;
      if (t.type === 'meeting') opts += `\n5. الموقع`;
      opts += `\n\nأرسل الرقم`;
      await sendWA(from, opts); return;
    }
    let list = '✏️ *أي مهمة تريد تعديلها؟*\n\n';
    result.rows.forEach((t, i) => { list += `${i+1}. *${t.title}*\n`; });
    await sendWA(from, list);
    userState[from] = { step: 'waiting_edit_selection', tasks: result.rows };
    return;
  }

  // --- مهامي ---
  if (msg === 'مهامي' || msg === 'قائمة') {
    const result = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date, time LIMIT 10');
    if (result.rows.length === 0) { await sendWA(from, '📋 لا توجد مهام معلقة ✅'); return; }
    let list = '📋 *مهامك المعلقة:*\n\n';
    result.rows.forEach((t, i) => {
      const icon = t.type === 'meeting' ? '📅' : t.type === 'reminder' ? '🔔' : '✅';
      list += `${i+1}. ${icon} *${t.title}*\n   ⏰ ${fmt12(t.time)} — ${t.date}`;
      if (t.requested_by_name) list += ` (من ${t.requested_by_name})`;
      list += `\n\n`;
    });
    await sendWA(from, list);
    return;
  }

  // --- اليوم ---
  if (msg === 'اليوم') {
    const today = todayStr();
    const result = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time', [today]);
    if (result.rows.length === 0) { await sendWA(from, '📋 ما عندك مهام اليوم ✅'); return; }
    let list = `📅 *مهام اليوم (${result.rows.length}):*\n\n`;
    result.rows.forEach((t, i) => {
      const icon = t.type === 'meeting' ? '📅' : t.type === 'reminder' ? '🔔' : '✅';
      list += `${i+1}. ${icon} *${t.title}*`;
      if (t.time) list += ` — ${fmt12(t.time)}`;
      list += `\n`;
    });
    await sendWA(from, list);
    return;
  }

  // --- غداً ---
  if (msg === 'غداً' || msg === 'غدا' || msg === 'الغد') {
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const tStr = tomorrow.toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
    const result = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time', [tStr]);
    if (result.rows.length === 0) { await sendWA(from, '📋 ما عندك مهام الغد ✅'); return; }
    let list = `📅 *مهام الغد (${result.rows.length}):*\n\n`;
    result.rows.forEach((t, i) => {
      list += `${i+1}. *${t.title}*`;
      if (t.time) list += ` — ${fmt12(t.time)}`;
      list += `\n`;
    });
    await sendWA(from, list);
    return;
  }

  // --- الأسبوع ---
  if (msg === 'الأسبوع' || msg === 'هذا الأسبوع' || msg === 'اسبوع') {
    const today = todayStr();
    const nextWeek = new Date(); nextWeek.setDate(nextWeek.getDate() + 7);
    const nextWeekStr = nextWeek.toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
    const result = await pool.query('SELECT * FROM tasks WHERE done=false AND date>=$1 AND date<=$2 ORDER BY date, time', [today, nextWeekStr]);
    if (result.rows.length === 0) { await sendWA(from, '📋 ما عندك مهام هذا الأسبوع ✅'); return; }
    let list = `📅 *مهام الأسبوع (${result.rows.length}):*\n\n`;
    result.rows.forEach((t, i) => {
      list += `${i+1}. *${t.title}* — ${t.date}`;
      if (t.time) list += ` ${fmt12(t.time)}`;
      list += `\n`;
    });
    await sendWA(from, list);
    return;
  }

  // --- بحث ---
  if (msg.startsWith('بحث ') || msg.startsWith('ابحث ')) {
    const keyword = msg.replace(/^(بحث|ابحث)\s+/, '').trim();
    const result = await pool.query('SELECT * FROM tasks WHERE done=false AND title ILIKE $1 ORDER BY date, time LIMIT 10', [`%${keyword}%`]);
    if (result.rows.length === 0) { await sendWA(from, `🔍 ما فيه نتائج لـ "${keyword}"`); return; }
    let list = `🔍 *نتائج "${keyword}":*\n\n`;
    result.rows.forEach((t, i) => { list += `${i+1}. *${t.title}* — ${t.date}\n`; });
    await sendWA(from, list);
    return;
  }

  // --- مساعدة ---
  if (msg === 'مساعدة' || msg === 'help') {
    await sendWA(from,
      `📖 *أوامر مهامي:*\n\n` +
      `📋 *عرض:* اليوم | غداً | الأسبوع | مهامي\n` +
      `✅ *إدارة:* منجز | تأجيل | أجل لـ 4 العصر | عدل | احذف\n` +
      `🔍 *بحث [كلمة]*\n` +
      `👤 *قبول [اسم]* أو *رفض [اسم]*\n` +
      `➕ أرسل أي مهمة بشكل طبيعي\n\n_مهامي_ ✨`
    );
    return;
  }

  // --- رسالة جديدة لعبدالعزيز ---
  const parsed = await parseTaskFromMessage(msg);
  if (parsed && parsed.title) {
    if (!parsed.date || !parsed.time) {
      userState[from] = { step: 'waiting_datetime', taskTitle: parsed.title, taskType: parsed.type||'task', taskNote: parsed.note||'' };
      let q = `${parsed.type === 'meeting' ? '📅' : '📌'} *${parsed.title}*\n\n`;
      if (!parsed.date && !parsed.time) q += `❓ متى وفي أي وقت؟`;
      else if (!parsed.date) q += `❓ في أي يوم؟`;
      else q += `❓ في أي وقت؟`;
      await sendWA(from, q);
      return;
    }
    if (parsed.type === 'meeting') {
      userState[from] = { step: 'waiting_location', taskTitle: parsed.title, taskType: 'meeting', taskNote: parsed.note||'', date: parsed.date, time: parsed.time };
      await sendWA(from, `📍 أين موقع الاجتماع؟\nأو أرسل *تخطي*`);
    } else {
      const id = Date.now();
      await pool.query('INSERT INTO tasks (id, title, type, date, time, note, location) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, parsed.title, parsed.type||'task', parsed.date, parsed.time, parsed.note||'', '']);
      await sendWA(from, `✅ تم التسجيل!\n📌 *${parsed.title}*\n⏰ ${fmt12(parsed.time)}\n📅 ${parsed.date}`);
    }
  } else {
    await sendWA(from, `❓ لم أفهم.\n\nأرسل *مساعدة* للأوامر`);
  }
}

// ─── AI: تحليل رسالة الزائر بذكاء ────────────────────────────────────────
async function analyzeVisitorMessage(msg, context) {
  try {
    const todayISO = todayStr();
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `أنت محلل رسائل ذكي. حلل هذه الرسالة وأعد JSON فقط بدون أي نص إضافي.

السياق: ${context}
اليوم: ${todayISO}
الرسالة: "${msg}"

أعد JSON بهذا الشكل:
{
  "intent": "name|greeting|task_request|meeting_request|reminder_for_owner|reminder_for_self|question|chat|rating|feedback|number_choice|unknown",
  "name": "الاسم إذا كان الـ intent هو name وإلا null",
  "choice": "رقم الاختيار 1-4 إذا كان intent هو number_choice وإلا null",
  "task_title": "عنوان الطلب كامل كما قاله الشخص بالضبط وإلا null",
  "date": "YYYY-MM-DD أو null",
  "time": "HH:MM أو null",
  "rating": "رقم 1-5 إذا كان تقييم وإلا null",
  "confidence": "high|medium|low"
}

قواعد مهمة جداً:
- intent=name: فقط إذا كانت الرسالة اسم شخص حقيقي (كلمة أو كلمتين، بدون أرقام، بدون جمل)
- intent=number_choice: فقط إذا كان الرقم وحده 1 أو 2 أو 3 أو 4
- intent=greeting: تحية مثل هلا، صباح الخير، مرحبا، كيف حالك، السلام عليكم
- intent=reminder_for_owner: إذا طلب تذكير عبدالعزيز بشيء — مثل "ذكّره بالاجتماع" أو "ذكر عبدالعزيز"
- intent=reminder_for_self: إذا طلب تذكير لنفسه — مثل "ذكرني" أو "أبغى تذكير لي"
- intent=meeting_request: إذا طلب اجتماع أو لقاء أو موعد مع عبدالعزيز
- intent=task_request: إذا طلب شيء من عبدالعزيز غير اجتماع وغير تذكير
- task_title: انسخ الطلب كامل كما قاله الشخص بدون تعديل
- الفرق بين reminder_for_owner و task_request: لو قال "ذكّره" أو "تذكير" → reminder، لو قال "أبغى" أو "طلب" → task`
      }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    });
    const text = response.data.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch(e) {
    console.error('Analyze Error:', e.message);
    return { intent: 'unknown', confidence: 'low' };
  }
}

// ─── معالجة رسائل الزوار ──────────────────────────────────────────────────
async function handleVisitorMessage(from, msg) {
  const state = userState[from] || { step: 'idle', history: [] };
  if (!state.history) state.history = [];

  // هل الزائر معروف؟
  let visitor = null;
  try {
    const r = await pool.query('SELECT * FROM visitors WHERE phone=$1', [from]);
    if (r.rows.length > 0) visitor = r.rows[0];
  } catch(e) { console.error(e.message); }

  const visitorName = visitor?.name || state.visitorName || null;

  // تحديث عدد الرسائل
  if (visitor) {
    try { await pool.query('UPDATE visitors SET msg_count=msg_count+1, last_seen=NOW() WHERE phone=$1', [from]); } catch(e) {}
  }

  // --- وضع الغياب ---
  const busy = await isBusy();
  if (busy) {
    if (visitorName && !sentReminders.has(`busy_${from}_${todayStr()}`)) {
      sentReminders.add(`busy_${from}_${todayStr()}`);
      await sendWA(from, `هلا ${visitorName}! 👋\nعبدالعزيز مشغول الحين بس أنا هنا لخدمتك`);
    }
  }

  // --- انتظار التقييم ---
  if (state.step === 'waiting_rating') {
    const analysis = await analyzeVisitorMessage(msg, 'المستخدم يقيّم الخدمة من 1-5');
    const rating = analysis.rating ? parseInt(analysis.rating) : parseInt(msg.replace(/[^0-9]/g, ''));
    if (rating >= 1 && rating <= 5) {
      const id = Date.now();
      await pool.query('INSERT INTO ratings (id, phone, name, task_id, rating) VALUES ($1,$2,$3,$4,$5)',
        [id, from, visitorName, state.taskId, rating]);
      userState[from] = { ...state, step: 'waiting_feedback', ratingId: id, lastRating: rating };
      await sendWA(from, `شكراً ${visitorName}! ${'⭐'.repeat(rating)}\nلو عندك ملاحظة أو اقتراح أرسله الحين، وإلا اكتب *تخطي* 😊`);
    } else {
      await sendWA(from, `أرسل رقم من 1 إلى 5 للتقييم 😊\n1️⃣ ضعيف | 3️⃣ متوسط | 5️⃣ ممتاز`);
    }
    return;
  }

  // --- انتظار الملاحظة ---
  if (state.step === 'waiting_feedback') {
    if (msg !== 'تخطي') {
      await pool.query('UPDATE ratings SET feedback=$1 WHERE id=$2', [msg, state.ratingId]);
      await sendWA(PHONE, `💬 *ملاحظة من ${visitorName}:*\n${msg}`);
      await sendWA(from, `شكراً على ملاحظتك! رأيك يهمنا 🙏`);
      // تعلم من المحادثة مع الملاحظة
      setImmediate(() => learnFromConversation(visitorName, state.history || [], state.lastRating, msg));
    } else {
      await sendWA(from, `شكراً ${visitorName}! نتشرف بخدمتك دايماً 😊`);
      // تعلم من المحادثة بدون ملاحظة
      setImmediate(() => learnFromConversation(visitorName, state.history || [], state.lastRating, ''));
    }
    userState[from] = { step: 'idle', history: state.history, visitorName };
    return;
  }

  // --- تحليل الرسالة بالـ AI ---
  const context = visitorName
    ? `الزائر اسمه ${visitorName}، في محادثة مع نواف مساعد عبدالعزيز`
    : `زائر جديد، سألناه عن اسمه`;
  const analysis = await analyzeVisitorMessage(msg, context);
  console.log(`🧠 تحليل رسالة ${from}: intent=${analysis.intent} confidence=${analysis.confidence}`);

  // --- زائر جديد أو غير معروف الاسم ---
  if (!visitorName) {
    // أول رسالة — رسالة ترحيب
    if (state.step !== 'waiting_name') {
      userState[from] = { step: 'waiting_name', history: [] };
      await sendWA(from, welcomeMsg());
      return;
    }

    // في انتظار الاسم — تحليل ذكي
    if (state.step === 'waiting_name') {
      if (analysis.intent === 'name' && analysis.name && analysis.confidence !== 'low') {
        // اسم واضح
        const name = analysis.name.trim();
        await pool.query('INSERT INTO visitors (phone, name, msg_count) VALUES ($1,$2,1) ON CONFLICT (phone) DO UPDATE SET name=$2', [from, name]);
        userState[from] = { step: 'idle', history: [], visitorName: name };
        await sendWA(from, menuMsg(name));
        return;
      }

      if (analysis.intent === 'task_request' || analysis.intent === 'meeting_request' || analysis.intent === 'reminder_for_owner') {
        // أرسل طلباً قبل الاسم — نسجل طلبه ونسأل عن الاسم
        userState[from] = { ...state, pendingRequest: { intent: analysis.intent, title: analysis.task_title || msg, date: analysis.date, time: analysis.time } };
        await sendWA(from, `تمام، وصلني طلبك! 😊\nبس قبل ما أوصله — ممكن تشرّفني باسمك؟`);
        return;
      }

      if (analysis.intent === 'greeting') {
        // رد على التحية ثم أعد السؤال
        await sendWA(from, `${greeting() === 'صباح الخير' ? 'صباح النور' : 'مساء النور'}! 😊\nممكن تشرّفني باسمك الكريم؟`);
        return;
      }

      // غير واضح — اسأل مرة ثانية بشكل لطيف
      await sendWA(from, `عذراً ما فهمت اسمك 😊\nممكن تكتب اسمك الكريم فقط؟`);
      return;
    }
  }

  // --- زائر معروف ---

  // ترحيب خاص للعائدين بعد غياب
  if (visitor && state.step === 'idle' && !state._welcomed) {
    const daysSince = Math.floor((new Date() - new Date(visitor.last_seen)) / (1000 * 60 * 60 * 24));
    if (daysSince > 3) {
      userState[from] = { ...state, _welcomed: true };
      const lastReq = visitor.last_request ? ` آخر مرة طلبت "${visitor.last_request}"` : '';
      // نكمل معالجة الرسالة بعد الترحيب
      await sendWA(from, `هلا ${visitorName}! 👋 زمان ما شفناك 😄${lastReq}\nوش تأمر اليوم؟`);
      // إذا كانت الرسالة مجرد تحية، نوقف هنا
      if (analysis.intent === 'greeting') return;
    }
  }

  // --- معالجة بناءً على النية ---

  // انتظار تفاصيل الطلب
  if (state.step === 'waiting_visitor_details') {
    const requestType = state.requestType;
    const title = analysis.task_title || msg;
    const date = analysis.date || null;
    const time = analysis.time || null;

    const id = Date.now();
    await pool.query(
      'INSERT INTO tasks (id, title, type, date, time, note, requested_by, requested_by_name, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, title, requestType, date, time, '', from, visitorName, 'pending']
    );
    await pool.query('UPDATE visitors SET last_request=$1 WHERE phone=$2', [title, from]);
    await sendWA(from, `تم استلام طلبك! 📨\nسأرفع الطلب لعبدالعزيز الحين وأبلغك بقراره أول ما يرد ✅`);
    await sendWA(PHONE, buildRequestNotification(visitorName, from, requestType, title, date, time));
    userState[from] = { step: 'idle', history: state.history, visitorName };
    return;
  }

  // انتظار موضوع التذكير للزائر
  if (state.step === 'waiting_visitor_reminder_topic') {
    userState[from] = { step: 'waiting_visitor_reminder_time', history: state.history, visitorName, reminderTitle: msg };
    await sendWA(from, `⏰ متى تبغى أذكّرك؟\nمثال: "بكرة الساعة 10 الصبح"`);
    return;
  }

  // انتظار وقت التذكير للزائر
  if (state.step === 'waiting_visitor_reminder_time') {
    const time = analysis.time;
    const date = analysis.date || todayStr();
    if (time) {
      const id = Date.now();
      await pool.query(
        'INSERT INTO tasks (id, title, type, date, time, note, requested_by, requested_by_name, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, state.reminderTitle, 'reminder', date, time, '', from, visitorName, 'approved']
      );
      await sendWA(from, `✅ تمام! سأذكّرك بـ "${state.reminderTitle}" في ${fmt12(time)} 🔔`);
      userState[from] = { step: 'idle', history: state.history, visitorName };
    } else {
      await sendWA(from, `❓ متى تبغى أذكّرك؟ مثال: "الساعة 3 العصر"`);
    }
    return;
  }

  // --- معالجة النية مباشرة ---

  if (analysis.intent === 'number_choice' && analysis.choice) {
    const choice = parseInt(analysis.choice);
    if (choice === 1) {
      userState[from] = { step: 'waiting_visitor_details', requestType: 'task', history: state.history, visitorName };
      await sendWA(from, `📌 تمام! أخبرني بتفاصيل المهمة أو الطلب اللي تبيني أوصله لعبدالعزيز 👇`);
    } else if (choice === 2) {
      userState[from] = { step: 'waiting_visitor_details', requestType: 'meeting', history: state.history, visitorName };
      await sendWA(from, `📅 تمام! أخبرني عن موضوع الاجتماع والوقت المناسب لك 👇`);
    } else if (choice === 3) {
      userState[from] = { step: 'waiting_visitor_details', requestType: 'reminder', history: state.history, visitorName };
      await sendWA(from, `🔔 تمام! وش تبيني أذكّر عبدالعزيز فيه؟ ومتى؟ 👇`);
    } else if (choice === 4) {
      userState[from] = { step: 'waiting_visitor_reminder_topic', history: state.history, visitorName };
      await sendWA(from, `🔔 تمام! وش تبيني أذكّرك فيه؟ 👇`);
    }
    return;
  }

  if (analysis.intent === 'task_request') {
    if (analysis.task_title && (analysis.date || analysis.time)) {
      // طلب كامل — سجّله مباشرة
      const id = Date.now();
      await pool.query(
        'INSERT INTO tasks (id, title, type, date, time, note, requested_by, requested_by_name, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, analysis.task_title, 'task', analysis.date, analysis.time, '', from, visitorName, 'pending']
      );
      await pool.query('UPDATE visitors SET last_request=$1 WHERE phone=$2', [analysis.task_title, from]);
      await sendWA(from, `تم استلام طلبك! 📨\nسأرفع الطلب لعبدالعزيز الحين وأبلغك بقراره أول ما يرد ✅`);
      await sendWA(PHONE, buildRequestNotification(visitorName, from, 'task', analysis.task_title, analysis.date, analysis.time));
    } else {
      userState[from] = { step: 'waiting_visitor_details', requestType: 'task', history: state.history, visitorName };
      await sendWA(from, `📌 تمام! أخبرني بتفاصيل الطلب 👇`);
    }
    return;
  }

  if (analysis.intent === 'meeting_request') {
    if (analysis.task_title && (analysis.date || analysis.time)) {
      const id = Date.now();
      await pool.query(
        'INSERT INTO tasks (id, title, type, date, time, note, requested_by, requested_by_name, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, analysis.task_title, 'meeting', analysis.date, analysis.time, '', from, visitorName, 'pending']
      );
      await pool.query('UPDATE visitors SET last_request=$1 WHERE phone=$2', [analysis.task_title, from]);
      await sendWA(from, `تم استلام طلبك! 📨\nسأرفع الطلب لعبدالعزيز الحين وأبلغك بقراره أول ما يرد ✅`);
      await sendWA(PHONE, buildRequestNotification(visitorName, from, 'meeting', analysis.task_title, analysis.date, analysis.time));
    } else {
      userState[from] = { step: 'waiting_visitor_details', requestType: 'meeting', history: state.history, visitorName };
      await sendWA(from, `📅 تمام! أخبرني عن موضوع الاجتماع والوقت المناسب لك 👇`);
    }
    return;
  }

  if (analysis.intent === 'reminder_for_owner') {
    if (analysis.task_title) {
      const id = Date.now();
      await pool.query(
        'INSERT INTO tasks (id, title, type, date, time, note, requested_by, requested_by_name, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, analysis.task_title, 'reminder', analysis.date, analysis.time, '', from, visitorName, 'pending']
      );
      await sendWA(from, `تم استلام طلبك! 📨\nسأرفع الطلب لعبدالعزيز الحين وأبلغك بقراره أول ما يرد ✅`);
      await sendWA(PHONE, buildRequestNotification(visitorName, from, 'reminder', analysis.task_title, analysis.date, analysis.time));
    } else {
      userState[from] = { step: 'waiting_visitor_details', requestType: 'reminder', history: state.history, visitorName };
      await sendWA(from, `🔔 تمام! وش تبيني أذكّر عبدالعزيز فيه؟ 👇`);
    }
    return;
  }

  if (analysis.intent === 'reminder_for_self') {
    userState[from] = { step: 'waiting_visitor_reminder_topic', history: state.history, visitorName };
    await sendWA(from, `🔔 تمام! وش تبيني أذكّرك فيه؟ 👇`);
    return;
  }

  // --- رد نواف الذكي للتحيات والدردشة ---
  state.history.push({ role: 'visitor', msg });
  const reply = await nawafReply(visitorName || 'الزائر', msg, state.history);

  if (reply) {
    state.history.push({ role: 'nawaf', msg: reply });
    userState[from] = { ...state };
    if (state.history.length > 6 && state.history.length % 6 === 0) {
      await sendWA(from, reply + `\n\n─────────────\nبالمناسبة، أقدر أساعدك في:\n1️⃣ مهمة / 2️⃣ اجتماع / 3️⃣ تذكير لعبدالعزيز / 4️⃣ تذكيرك أنت 😊`);
    } else {
      await sendWA(from, reply);
    }
  } else {
    await sendWA(from, notUnderstandMsg());
  }
}

// ─── Cron: تذكيرات الزوار ─────────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  const today = todayStr();
  const now = new Date();
  const cur = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  try {
    const res = await pool.query(
      "SELECT * FROM tasks WHERE status='approved' AND requested_by != '' AND date=$1 AND time=$2",
      [today, cur]
    );
    for (const t of res.rows) {
      if (!sentReminders.has(`visitor_${t.id}`)) {
        sentReminders.add(`visitor_${t.id}`);
        await sendWA(t.requested_by, `🔔 تذكيرك: *${t.title}*\n_من نواف_ ✨`);
      }
    }
  } catch(e) { console.error('Visitor reminder error:', e.message); }
}, { timezone: 'Asia/Riyadh' });

// ─── API Routes ───────────────────────────────────────────────────────────
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
  const { done, title, type, date, time, note, location, priority } = req.body;
  try {
    if (done !== undefined) {
      await pool.query('UPDATE tasks SET done=$1 WHERE id=$2', [done, req.params.id]);
    } else {
      const fields = [], vals = [];
      let idx = 1;
      if (title !== undefined)    { fields.push(`title=$${idx++}`);    vals.push(title); }
      if (type !== undefined)     { fields.push(`type=$${idx++}`);     vals.push(type); }
      if (date !== undefined)     { fields.push(`date=$${idx++}`);     vals.push(date); }
      if (time !== undefined)     { fields.push(`time=$${idx++}`);     vals.push(time); }
      if (note !== undefined)     { fields.push(`note=$${idx++}`);     vals.push(note); }
      if (location !== undefined) { fields.push(`location=$${idx++}`); vals.push(location); }
      if (priority !== undefined) { fields.push(`priority=$${idx++}`); vals.push(priority); }
      if (fields.length) { vals.push(req.params.id); await pool.query(`UPDATE tasks SET ${fields.join(',')} WHERE id=$${idx}`, vals); }
    }
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

app.get('/appointment-requests', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM tasks WHERE requested_by != '' ORDER BY created_at DESC LIMIT 20");
    res.json(result.rows.map(t => ({ ...t, name: t.requested_by_name, phone: t.requested_by, proposed_date: t.date, proposed_time: t.time })));
  } catch(e) { res.json([]); }
});

app.get('/visitor-reminders', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM tasks WHERE requested_by != '' AND type='reminder' ORDER BY created_at DESC LIMIT 20");
    res.json(result.rows.map(t => ({ ...t, phone: t.requested_by })));
  } catch(e) { res.json([]); }
});

app.get('/working-hours', async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM settings WHERE key='working_hours'");
    if (r.rows.length) return res.json(JSON.parse(r.rows[0].value));
    res.json({ start_time: '10:00', end_time: '18:00', gap_minutes: 60, working_days: '6,0,1,2,3,4' });
  } catch(e) { res.json({ start_time: '10:00', end_time: '18:00', gap_minutes: 60, working_days: '6,0,1,2,3,4' }); }
});

app.patch('/working-hours', async (req, res) => {
  try {
    await pool.query(`INSERT INTO settings (key, value) VALUES ('working_hours', $1) ON CONFLICT (key) DO UPDATE SET value=$1`, [JSON.stringify(req.body)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => {
  res.json({ status: '🟢 مهامي شغّال', time: new Date().toLocaleString('ar-SA') });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 مهامي سيرفر شغّال على port ${PORT}`));

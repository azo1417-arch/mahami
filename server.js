process.env.TZ = 'Asia/Riyadh';

const express = require('express');
const cron    = require('node-cron');
const axios   = require('axios');
const { Pool }= require('pg');
const path    = require('path');

const app = express();
app.use((req,res,next)=>{res.header('Access-Control-Allow-Origin','*');res.header('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');res.header('Access-Control-Allow-Headers','Content-Type');if(req.method==='OPTIONS')return res.sendStatus(200);next();});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// ─── Config ───────────────────────────────────────────────────────────────
const PHONE       = '966563466639';
const WIFE_PHONE  = '966559003046';
const GA_INSTANCE = '7107577151';
const GA_TOKEN    = 'bf8e5a28cfdc41fabb681fe798d38a303a7a681653c34caeb3';
const GA_URL      = `https://7107.api.greenapi.com/waInstance${GA_INSTANCE}`;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── DB Init ──────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS tasks (
    id BIGINT PRIMARY KEY, title TEXT NOT NULL, type TEXT DEFAULT 'task',
    date TEXT, time TEXT, note TEXT DEFAULT '', location TEXT DEFAULT '',
    done BOOLEAN DEFAULT FALSE, priority TEXT DEFAULT 'normal',
    requested_by TEXT DEFAULT '', requested_by_name TEXT DEFAULT '',
    status TEXT DEFAULT 'pending', reminded BOOLEAN DEFAULT FALSE,
    reminded_pre BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW()
  )`);
  const cols = ['location','priority','requested_by','requested_by_name','status','reminded','reminded_pre'];
  for (const c of cols) await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ${c} ${c==='reminded'||c==='reminded_pre'?'BOOLEAN DEFAULT FALSE':'TEXT DEFAULT \'\''}`).catch(()=>{});

  await pool.query(`CREATE TABLE IF NOT EXISTS visitors (
    phone TEXT PRIMARY KEY, name TEXT NOT NULL, msg_count INTEGER DEFAULT 0,
    last_seen TIMESTAMP DEFAULT NOW(), last_request TEXT DEFAULT '', created_at TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`ALTER TABLE visitors ADD COLUMN IF NOT EXISTS last_request TEXT DEFAULT ''`).catch(()=>{});

  await pool.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
  await pool.query(`INSERT INTO settings (key,value) VALUES ('busy_mode','false') ON CONFLICT (key) DO NOTHING`);

  await pool.query(`CREATE TABLE IF NOT EXISTS memory (
    id BIGSERIAL PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT NOT NULL, updated_at TIMESTAMP DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS relations (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, info TEXT DEFAULT '', created_at TIMESTAMP DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS available_slots (
    id BIGSERIAL PRIMARY KEY, slot_date TEXT, slot_time TEXT, is_booked BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS special_contacts (
    phone TEXT PRIMARY KEY, name TEXT NOT NULL, relation TEXT DEFAULT ''
  )`);
  await pool.query(`INSERT INTO special_contacts (phone,name,relation) VALUES ('${WIFE_PHONE}','الزوجة','wife') ON CONFLICT (phone) DO NOTHING`);

  console.log('✅ DB جاهزة');
}
initDB();

const sentReminders = new Set();
const userState = {};

// ─── Helpers ──────────────────────────────────────────────────────────────
async function sendWA(to, message) {
  try {
    const chatId = to.includes('@') ? to : to + '@c.us';
    await axios.post(GA_URL + '/sendMessage/' + GA_TOKEN, { chatId, message });
  } catch(e) { console.error('WA Error:', e.message); }
}

function fmt12(t) {
  if (!t) return '';
  const [h,m] = t.split(':').map(Number);
  return (h%12||12) + ':' + String(m).padStart(2,'0') + ' ' + (h<12?'ص':'م');
}

function todayStr() {
  const n = new Date();
  return n.getFullYear() + '-' + String(n.getMonth()+1).padStart(2,'0') + '-' + String(n.getDate()).padStart(2,'0');
}

function nowTime() {
  const n = new Date();
  return String(n.getHours()).padStart(2,'0') + ':' + String(n.getMinutes()).padStart(2,'0');
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'صباح الخير' : h < 17 ? 'مساء الخير' : 'مساء النور';
}

// ─── Memory ───────────────────────────────────────────────────────────────
async function rememberFact(key, value) {
  try { await pool.query(`INSERT INTO memory (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW()`, [key, value]); } catch(e) {}
}
async function recallFact(key) {
  try { const r = await pool.query('SELECT value,updated_at FROM memory WHERE key=$1',[key]); return r.rows[0]||null; } catch(e) { return null; }
}

// ─── Lessons ──────────────────────────────────────────────────────────────
async function getLessons() {
  try { const r = await pool.query("SELECT value FROM settings WHERE key='nawaf_lessons'"); return r.rows[0]?.value||''; } catch(e) { return ''; }
}
async function saveLessons(lessons) {
  try { await pool.query(`INSERT INTO settings (key,value) VALUES ('nawaf_lessons',$1) ON CONFLICT (key) DO UPDATE SET value=$1`,[lessons]); } catch(e) {}
}
async function learnFromConversation(visitorName, history, feedback) {
  if (history.length < 2) return;
  try {
    const current = await getLessons();
    const histText = history.map(h => (h.role==='visitor'?visitorName:'نواف') + ': ' + h.msg).join('\n');
    const res = await callAI('claude-sonnet-4-20250514', 600,
      'أنت مدرب لتطوير نواف المساعد الذكي.\n\nالدروس الحالية:\n' + (current||'لا يوجد') +
      '\n\nمحادثة جديدة مع ' + visitorName + ':\n' + histText +
      (feedback ? '\nملاحظة: ' + feedback : '') +
      '\n\nحلل واستخرج دروساً جديدة (حد أقصى 15 درس)، كل درس في سطر يبدأ بـ •'
    );
    if (res) await saveLessons(res);
  } catch(e) {}
}

// ─── AI Caller ────────────────────────────────────────────────────────────
async function callAI(model, max_tokens, prompt) {
  try {
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model, max_tokens,
      messages: [{ role:'user', content: prompt }]
    }, { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version':'2023-06-01', 'content-type':'application/json' } });
    return res.data.content[0].text.trim();
  } catch(e) { console.error('AI Error:', e.message); return null; }
}

async function callAIJson(model, max_tokens, prompt) {
  const text = await callAI(model, max_tokens, prompt);
  if (!text) return null;
  try { return JSON.parse(text.replace(/```json|```/g,'').trim()); } catch(e) { return null; }
}

// ─── Parse Task ───────────────────────────────────────────────────────────
async function parseTask(msg) {
  const today = todayStr();
  const now = new Date();
  const cur = nowTime();
  let processed = msg;
  const rel = msg.match(/بعد\s+(\d+)\s*(دقيقة|دقائق|ساعة|ساعات)/);
  if (rel) {
    const mins = (rel[2].includes('ساعة')||rel[2].includes('ساعات')) ? parseInt(rel[1])*60 : parseInt(rel[1]);
    const fut = new Date(now.getTime() + mins*60000);
    const ft = String(fut.getHours()).padStart(2,'0') + ':' + String(fut.getMinutes()).padStart(2,'0');
    const fd = fut.getFullYear() + '-' + String(fut.getMonth()+1).padStart(2,'0') + '-' + String(fut.getDate()).padStart(2,'0');
    processed = msg.replace(rel[0], 'الساعة ' + ft);
    if (fd !== today) processed += ' تاريخ ' + fd;
  }
  return callAIJson('claude-haiku-4-5-20251001', 300,
    'اليوم ' + today + ' الوقت ' + cur + ' بالرياض.\nأعد JSON فقط:\n{"title":"","type":"task أو meeting أو reminder","date":"YYYY-MM-DD أو null","time":"HH:MM أو null","note":""}\nقواعد: اجتماع/لقاء→meeting، تذكير/ذكرني→reminder، غيره→task، بكرة→غد، بدون تاريخ→null، بدون وقت→null\nالرسالة: "' + processed + '"'
  );
}

// ─── Analyze Owner Message ────────────────────────────────────────────────
async function analyzeOwner(msg, context) {
  const today = todayStr();
  const cur = nowTime();
  return callAIJson('claude-sonnet-4-20250514', 400,
    'أنت محلل ذكي لرسائل عبدالعزيز. أعد JSON فقط.\n' +
    'السياق:\n' + context + '\n' +
    'الوقت: ' + cur + ' التاريخ: ' + today + '\n' +
    'الرسالة: "' + msg + '"\n\n' +
    'أعد:\n{"action":"approve|reject|approve_name|reject_name|remind_visitor|send_message|add_task|add_meeting|add_reminder|show_today|show_tomorrow|show_week|show_tasks|done|postpone|delete|edit|search|busy|back|remember|recall|add_relation|recall_relation|add_slot|show_slots|help|chat|unknown","target_name":null,"message_to_send":null,"task_title":null,"date":null,"time":null,"memory_key":null,"memory_value":null,"relation_name":null,"relation_info":null,"note":null,"confidence":"high|medium|low"}\n\n' +
    'قواعد:\n' +
    '- اعتمد/موافق/تمام/أوكي → approve\n' +
    '- ارفض/لا/مرفوض → reject\n' +
    '- قبول [اسم] → approve_name\n' +
    '- رفض [اسم] → reject_name\n' +
    '- ذكّره/ذكره بعد X → remind_visitor\n' +
    '- أرسل لـ[شخص]/رد على [شخص] → send_message\n' +
    '- مشغول/في اجتماع → busy\n' +
    '- رجعت/خلصت → back\n' +
    '- تذكر/غيرت/اشتريت → remember\n' +
    '- متى آخر/كم صار → recall\n' +
    '- أضف [اسم] [معلومات] → add_relation\n' +
    '- وش عندي عن [اسم] → recall_relation\n' +
    '- أضف موعد متاح → add_slot\n' +
    '- وش مواعيدي المتاحة → show_slots\n' +
    '- بعد X دقيقة/ساعة → احسب الوقت من ' + cur + '\n' +
    '- مهمة/اجتماع/تذكير جديد → add_task/add_meeting/add_reminder\n' +
    '- كلام عادي/سؤال/مشكلة → chat'
  );
}

// ─── Nawaf Owner Reply ────────────────────────────────────────────────────
async function nawafOwnerReply(msg, context) {
  const lessons = await getLessons();
  const lessonsText = lessons ? 'دروس وملاحظات:\n' + lessons : '';
  return callAI('claude-sonnet-4-20250514', 600,
    'أنت "نواف" المساعد الشخصي لعبدالعزيز.\n' +
    'تتكلم بعامية سعودية، ودي وذكي ومفيد.\n' +
    'تساعد عبدالعزيز في أي شيء يسأل عنه بدون قيود — طب، سيارات، تقنية، نصائح، أي شيء.\n' +
    'أنت مثل صديق ذكي يعرف كل شيء ويرد بصدق.\n\n' +
    'السياق:\n' + context + '\n\n' +
    lessonsText + '\n\n' +
    'عبدالعزيز: ' + msg + '\n\n' +
    'رد بشكل طبيعي ومفيد بالعامية السعودية. كن صريح ومباشر.'
  );
}

// ─── Nawaf Visitor Reply ──────────────────────────────────────────────────
async function nawafVisitorReply(visitorName, msg, history) {
  const lessons = await getLessons();
  const histText = history.slice(-6).map(h => (h.role==='visitor'?visitorName:'نواف') + ': ' + h.msg).join('\n');
  const lessonsText = lessons ? 'دروس من محادثات سابقة:\n' + lessons : '';
  return callAI('claude-haiku-4-5-20251001', 300,
    'أنت "نواف" المساعد الشخصي لعبدالعزيز على واتساب.\n' +
    'شخصيتك: خليجي ودي، دافئ، عامية سعودية.\n' +
    'مهمتك: مساعدة الزوار في التواصل مع عبدالعزيز.\n' +
    lessonsText + '\n\n' +
    'سجل المحادثة:\n' + histText + '\n\n' +
    visitorName + ': ' + msg + '\n\n' +
    'رد قصير وطبيعي (جملة أو جملتين). إذا طلب محدد قل "تمام، أرسل التفاصيل".'
  );
}

// ─── Analyze Visitor Message ──────────────────────────────────────────────
async function analyzeVisitor(msg, context) {
  const today = todayStr();
  return callAIJson('claude-haiku-4-5-20251001', 300,
    'أنت محلل رسائل ذكي. أعد JSON فقط.\n' +
    'السياق: ' + context + '\nاليوم: ' + today + '\nالرسالة: "' + msg + '"\n\n' +
    'أعد:\n{"intent":"name|greeting|task_request|meeting_request|reminder_for_owner|reminder_for_self|update_request|cancel_request|chat|number_choice|unknown","name":null,"choice":null,"task_title":null,"date":null,"time":null,"confidence":"high|medium|low"}\n\n' +
    'قواعد:\n' +
    '- name: اسم شخص حقيقي فقط (كلمة أو كلمتين، بدون أرقام أو جمل)\n' +
    '- number_choice: رقم 1-4 فقط\n' +
    '- greeting: تحية\n' +
    '- update_request: "الغيت" أو "تغير الموعد" أو "ما بقدر"\n' +
    '- cancel_request: "الغي طلبي" أو "ما أبغى"\n' +
    '- reminder_for_owner: "ذكّره" أو "تذكير لعبدالعزيز"\n' +
    '- reminder_for_self: "ذكرني"\n' +
    '- meeting_request: طلب اجتماع أو لقاء\n' +
    '- task_request: طلب شيء من عبدالعزيز\n' +
    '- task_title: انسخ الطلب كما قاله بدون تعديل'
  );
}

// ─── Busy Mode ────────────────────────────────────────────────────────────
async function isBusy() {
  try { const r = await pool.query("SELECT value FROM settings WHERE key='busy_mode'"); return r.rows[0]?.value==='true'; } catch(e) { return false; }
}
async function setBusy(val) {
  await pool.query(`INSERT INTO settings (key,value) VALUES ('busy_mode',$1) ON CONFLICT (key) DO UPDATE SET value=$1`, [val?'true':'false']);
}

// ─── Build Messages ───────────────────────────────────────────────────────
function buildTaskMsg(t) {
  const icons = { meeting:'📅 اجتماع', task:'✅ مهمة', reminder:'🔔 تذكير' };
  let msg = greeting() + ' عبدالعزيز 🌟\n\n' + (icons[t.type]||'📌 مهمة') + '\n📌 *' + t.title + '*\n';
  if (t.time) msg += '⏰ ' + fmt12(t.time) + '\n';
  if (t.note) msg += '📝 ' + t.note + '\n';
  if (t.location) msg += '📍 ' + t.location + '\n';
  msg += '\n─────────────\nرد بـ *منجز* لتأكيد الإنجاز\nرد بـ *تأجيل* لتأجيلها ساعة\n\n_مهامي_ ✨';
  return msg;
}

function buildRequestNotif(name, from, type, title, date, time) {
  const tLabel = type==='meeting'?'اجتماع':type==='reminder'?'تذكير':'مهمة';
  let msg = '📬 *طلب جديد من ' + name + '*\n\n📌 النوع: ' + tLabel + '\n📝 التفاصيل: ' + title + '\n';
  if (date) msg += '📅 ' + date + '\n';
  if (time) msg += '⏰ ' + fmt12(time) + '\n';
  msg += '\n─────────────\nرد بـ *قبول ' + name + '* لاعتماده ✅\nرد بـ *رفض ' + name + '* لرفضه ❌';
  return msg;
}

function welcomeMsg() {
  return greeting() + ' 👋\nهلا وغلا! أنا المساعد الشخصي لعبدالعزيز ✨\n\nأقدر أساعدك في:\n📌 تسجيل مهمة أو طلب له\n📅 جدولة اجتماع معه\n🔔 تذكيره بشيء أو تذكيرك أنت\n\nممكن تشرّفني باسمك؟ 😊';
}

function menuMsg(name) {
  return 'هلا ' + name + '! 😊\nوش أقدر أساعدك فيه؟\n\n1️⃣ تسجيل مهمة أو طلب\n2️⃣ جدولة اجتماع\n3️⃣ تذكير عبدالعزيز\n4️⃣ تذكيرك أنت\n\nأرسل الرقم أو اكتب مباشرة 👇';
}

// ─── Cron: Reminders every 10 seconds ────────────────────────────────────
cron.schedule('*/10 * * * * *', async () => {
  const today = todayStr();
  const now = new Date();
  const cur = nowTime();

  // تذكير في الوقت المحدد
  try {
    const res = await pool.query('SELECT * FROM tasks WHERE done=false AND reminded=false AND date=$1 AND time=$2', [today, cur]);
    for (const t of res.rows) {
      await pool.query('UPDATE tasks SET reminded=true WHERE id=$1', [t.id]);
      await sendWA(PHONE, buildTaskMsg(t));
      console.log('📤 تذكير:', t.title, cur);
    }
  } catch(e) { console.error('Cron:', e.message); }

  // تذكير مسبق قبل 15 دقيقة
  try {
    const f15 = new Date(now.getTime() + 15*60000);
    const pre = String(f15.getHours()).padStart(2,'0') + ':' + String(f15.getMinutes()).padStart(2,'0');
    const res = await pool.query('SELECT * FROM tasks WHERE done=false AND reminded_pre=false AND date=$1 AND time=$2', [today, pre]);
    for (const t of res.rows) {
      await pool.query('UPDATE tasks SET reminded_pre=true WHERE id=$1', [t.id]);
      let msg = '⏰ *تذكير مسبق — بعد 15 دقيقة*\n\n📌 *' + t.title + '*\n🕐 ' + fmt12(t.time) + '\n';
      if (t.note) msg += '📝 ' + t.note + '\n';
      if (t.location) msg += '📍 ' + t.location + '\n';
      msg += '\n_مهامي_ ✨';
      await sendWA(PHONE, msg);
    }
  } catch(e) { console.error('Pre-reminder:', e.message); }

  // تأكيد اجتماع قبل ساعة
  try {
    const f60 = new Date(now.getTime() + 60*60000);
    const pre60 = String(f60.getHours()).padStart(2,'0') + ':' + String(f60.getMinutes()).padStart(2,'0');
    const res = await pool.query("SELECT * FROM tasks WHERE done=false AND type='meeting' AND date=$1 AND time=$2", [today, pre60]);
    for (const t of res.rows) {
      if (!sentReminders.has('mtg60_' + t.id)) {
        sentReminders.add('mtg60_' + t.id);
        let msg = '📅 *تأكيد اجتماع — بعد ساعة*\n\n📌 *' + t.title + '*\n⏰ ' + fmt12(t.time) + '\n';
        if (t.location) msg += '📍 ' + t.location + '\n';
        msg += '\nاستعد 💼\n_مهامي_ ✨';
        await sendWA(PHONE, msg);
      }
    }
  } catch(e) { console.error('Mtg60:', e.message); }

  // تذكيرات الزوار
  try {
    const res = await pool.query("SELECT * FROM tasks WHERE status='approved' AND requested_by!='' AND reminded=false AND date=$1 AND time=$2", [today, cur]);
    for (const t of res.rows) {
      await pool.query('UPDATE tasks SET reminded=true WHERE id=$1', [t.id]);
      await sendWA(t.requested_by, '🔔 تذكيرك: *' + t.title + '*\n_من نواف_ ✨');
      await sendWA(PHONE, '📬 تم تذكير *' + t.requested_by_name + '* بـ "' + t.title + '" ✅');
    }
  } catch(e) { console.error('Visitor reminder:', e.message); }

}, { timezone: 'Asia/Riyadh' });

// ─── Cron: Morning Summary 8am ────────────────────────────────────────────
cron.schedule('0 8 * * *', async () => {
  const today = todayStr();
  try {
    const res = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time', [today]);
    const over = await pool.query('SELECT * FROM tasks WHERE done=false AND date<$1 ORDER BY date,time', [today]);
    let msg = '🌅 *صباح الخير عبدالعزيز*\n📅 ' + new Date().toLocaleDateString('ar-SA',{weekday:'long',day:'numeric',month:'long',timeZone:'Asia/Riyadh'}) + '\n─────────────\n\n';
    if (!res.rows.length) { msg += '✨ ما عندك مهام اليوم — يوم خفيف!\n'; }
    else {
      msg += '📋 *مهام اليوم (' + res.rows.length + '):*\n\n';
      res.rows.forEach((t,i) => {
        const icon = t.type==='meeting'?'📅':t.type==='reminder'?'🔔':'✅';
        msg += (i+1) + '. ' + icon + ' *' + t.title + '*' + (t.time?' — '+fmt12(t.time):'') + (t.requested_by_name?' (من '+t.requested_by_name+')':'') + '\n';
        if (t.location) msg += '   📍 ' + t.location + '\n';
      });
    }
    if (over.rows.length) { msg += '\n⚠️ *متأخرة (' + over.rows.length + '):*\n'; over.rows.slice(0,3).forEach(t => { msg += '• ' + t.title + ' — ' + t.date + '\n'; }); }
    msg += '\n_مهامي_ ✨ — يوم موفق!';
    await sendWA(PHONE, msg);
  } catch(e) { console.error('Morning:', e.message); }
}, { timezone: 'Asia/Riyadh' });

// ─── Cron: Weekly Report Friday 5pm ──────────────────────────────────────
cron.schedule('0 17 * * 5', async () => {
  try {
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate()-7);
    const wa = weekAgo.getFullYear() + '-' + String(weekAgo.getMonth()+1).padStart(2,'0') + '-' + String(weekAgo.getDate()).padStart(2,'0');
    const today = todayStr();
    const [total, approved, rejected, pending, visitors] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM tasks WHERE created_at>=$1',[wa]),
      pool.query("SELECT COUNT(*) FROM tasks WHERE status='approved' AND created_at>=$1",[wa]),
      pool.query("SELECT COUNT(*) FROM tasks WHERE status='rejected' AND created_at>=$1",[wa]),
      pool.query("SELECT COUNT(*) FROM tasks WHERE status='pending' AND done=false"),
      pool.query('SELECT COUNT(*) FROM visitors WHERE created_at>=$1',[wa]),
    ]);
    let msg = '📊 *تقرير الأسبوع*\n📅 ' + wa + ' ← ' + today + '\n─────────────\n\n';
    msg += '📬 طلبات وصلت: *' + total.rows[0].count + '*\n';
    msg += '✅ اعتمدت: *' + approved.rows[0].count + '*\n';
    msg += '❌ رفضت: *' + rejected.rows[0].count + '*\n';
    msg += '⏳ معلقة: *' + pending.rows[0].count + '*\n';
    msg += '👤 زوار جدد: *' + visitors.rows[0].count + '*\n';
    msg += '\n_مهامي_ ✨';
    await sendWA(PHONE, msg);
    // تعلم أسبوعي
    const recentTasks = await pool.query("SELECT * FROM tasks WHERE requested_by!='' AND created_at>=$1 ORDER BY created_at DESC LIMIT 20",[wa]);
    if (recentTasks.rows.length > 0) {
      const summary = recentTasks.rows.map(t => t.requested_by_name + ': "' + t.title + '" (' + t.status + ')').join('\n');
      setImmediate(() => learnFromConversation('تحليل أسبوعي', [{role:'visitor',msg:'ملخص الطلبات:\n'+summary}], ''));
    }
  } catch(e) { console.error('Weekly:', e.message); }
}, { timezone: 'Asia/Riyadh' });

// ─── Webhook ───────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (body?.typeWebhook !== 'incomingMessageReceived') return;
  const msg = body?.messageData?.textMessageData?.textMessage?.trim();
  const from = body?.senderData?.chatId?.replace('@c.us','');
  if (!msg || !from) return;
  console.log('📩', from, '—', msg.substring(0,50));
  if (from === PHONE) { await handleOwner(from, msg); return; }
  if (from === WIFE_PHONE) { await handleWife(from, msg); return; }
  await handleVisitor(from, msg);
});

// ─── Handle Owner ─────────────────────────────────────────────────────────
async function handleOwner(from, msg) {
  const state = userState[from] || { step: 'idle' };
  if (state.step !== 'idle') { await handleOwnerState(from, msg, state); return; }

  // جلب السياق
  let context = '';
  try {
    const pr = await pool.query("SELECT * FROM tasks WHERE status='pending' AND requested_by!='' ORDER BY created_at DESC LIMIT 3");
    const td = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time LIMIT 5',[todayStr()]);
    if (pr.rows.length) { context += 'طلبات معلقة:\n'; pr.rows.forEach(t => { context += '- ' + t.requested_by_name + ': "' + t.title + '" (' + t.type + ')' + (t.time?' '+fmt12(t.time):'') + '\n'; }); }
    if (td.rows.length) { context += '\nمهام اليوم:\n'; td.rows.forEach(t => { context += '- ' + t.title + (t.time?' — '+fmt12(t.time):'') + '\n'; }); }
    if (!context) context = 'لا يوجد طلبات أو مهام';
  } catch(e) {}

  const analysis = await analyzeOwner(msg, context);
  if (!analysis) { await sendWA(from, '❓ ما فهمت، جرب مرة ثانية'); return; }
  console.log('🧠 owner action:', analysis.action);

  switch(analysis.action) {

    case 'approve': {
      const r = await pool.query("SELECT * FROM tasks WHERE status='pending' AND requested_by!='' ORDER BY created_at DESC LIMIT 1");
      if (r.rows.length) {
        const t = r.rows[0]; const vn = t.requested_by_name;
        await pool.query('UPDATE tasks SET status=$1 WHERE id=$2',['approved',t.id]);
        await sendWA(t.requested_by, 'هلا ' + vn + ' 👋\nعبدالعزيز اعتمد طلبك ✅\n📌 ' + t.title + (t.date?'\n📅 '+t.date:'') + (t.time?'\n⏰ '+fmt12(t.time):''));
        await sendWA(from, '✅ تم اعتماد طلب ' + vn + ' وإبلاغه');
      } else { await sendWA(from, '❓ ما في طلبات معلقة'); }
      break;
    }

    case 'reject': {
      const r = await pool.query("SELECT * FROM tasks WHERE status='pending' AND requested_by!='' ORDER BY created_at DESC LIMIT 1");
      if (r.rows.length) {
        const t = r.rows[0]; const vn = t.requested_by_name;
        await pool.query('UPDATE tasks SET status=$1 WHERE id=$2',['rejected',t.id]);
        await sendWA(t.requested_by, 'هلا ' + vn + ' 👋\nاعتذر، عبدالعزيز غير قادر ❌\nلو تبغى وقت ثاني أنا هنا 😊');
        await sendWA(from, '❌ تم رفض طلب ' + vn + ' وإبلاغه');
      } else { await sendWA(from, '❓ ما في طلبات معلقة'); }
      break;
    }

    case 'approve_name': {
      const vn = analysis.target_name;
      const r = await pool.query("SELECT * FROM tasks WHERE requested_by_name=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1",[vn]);
      if (r.rows.length) {
        const t = r.rows[0];
        await pool.query('UPDATE tasks SET status=$1 WHERE id=$2',['approved',t.id]);
        await sendWA(t.requested_by, 'هلا ' + vn + ' 👋\nعبدالعزيز اعتمد طلبك ✅\n📌 ' + t.title + (t.date?'\n📅 '+t.date:'') + (t.time?'\n⏰ '+fmt12(t.time):''));
        await sendWA(from, '✅ تم قبول طلب ' + vn);
      } else { await sendWA(from, '❓ ما لقيت طلب من ' + vn); }
      break;
    }

    case 'reject_name': {
      const vn = analysis.target_name;
      const r = await pool.query("SELECT * FROM tasks WHERE requested_by_name=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1",[vn]);
      if (r.rows.length) {
        const t = r.rows[0];
        await pool.query('UPDATE tasks SET status=$1 WHERE id=$2',['rejected',t.id]);
        await sendWA(t.requested_by, 'هلا ' + vn + ' 👋\nاعتذر، عبدالعزيز غير قادر ❌\nلو تبغى وقت ثاني أنا هنا 😊');
        await sendWA(from, '❌ تم رفض طلب ' + vn);
      } else { await sendWA(from, '❓ ما لقيت طلب من ' + vn); }
      break;
    }

    case 'remind_visitor': {
      const r = await pool.query("SELECT * FROM tasks WHERE requested_by!='' ORDER BY created_at DESC LIMIT 1");
      if (r.rows.length) {
        const t = r.rows[0];
        const time = analysis.time || t.time;
        const date = analysis.date || todayStr();
        if (time) {
          await pool.query('UPDATE tasks SET status=$1,time=$2,date=$3,reminded=false WHERE id=$4',['approved',time,date,t.id]);
          await sendWA(from, '✅ سأذكّر ' + t.requested_by_name + ' الساعة ' + fmt12(time));
        } else {
          userState[from] = { step: 'waiting_remind_visitor_time', taskId: t.id, visitorName: t.requested_by_name };
          await sendWA(from, '⏰ متى أذكّره؟ مثال: "بعد ساعة"');
        }
      } else { await sendWA(from, '❓ ما في زوار'); }
      break;
    }

    case 'send_message': {
      const msgToSend = analysis.message_to_send;
      if (!msgToSend) { await sendWA(from, '❓ وش الرسالة؟'); break; }
      let targetPhone = null, targetName = analysis.target_name || '';
      if (targetName.includes('زوج')) { targetPhone = WIFE_PHONE; targetName = 'الزوجة'; }
      else {
        const last = await pool.query("SELECT * FROM tasks WHERE requested_by!='' ORDER BY created_at DESC LIMIT 1");
        if (last.rows.length) { targetPhone = last.rows[0].requested_by; targetName = last.rows[0].requested_by_name; }
      }
      if (targetPhone) { await sendWA(targetPhone, msgToSend); await sendWA(from, '✅ تم الإرسال لـ ' + targetName); }
      else { await sendWA(from, '❓ ما عرفت لمن أرسل'); }
      break;
    }

    case 'busy': { await setBusy(true); await sendWA(from, '🔕 تم تفعيل وضع الغياب'); break; }

    case 'back': {
      await setBusy(false);
      const cur = nowTime();
      const r = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 AND time>$2 ORDER BY time',[todayStr(),cur]);
      if (!r.rows.length) { await sendWA(from, '✅ تم إيقاف وضع الغياب\n\nما في مهام باقية اليوم 🎉'); }
      else {
        let reply = '✅ تم إيقاف وضع الغياب\n\nباقي اليوم:\n\n';
        r.rows.forEach((t,i) => { reply += (i+1) + '. ' + (t.type==='meeting'?'📅':t.type==='reminder'?'🔔':'✅') + ' *' + t.title + '* — ' + fmt12(t.time) + '\n'; });
        await sendWA(from, reply);
      }
      break;
    }

    case 'remember': {
      const key = analysis.memory_key || analysis.task_title;
      const value = analysis.memory_value || new Date().toLocaleDateString('ar-SA',{timeZone:'Asia/Riyadh'});
      if (key) { await rememberFact(key, value); await sendWA(from, '✅ تذكّرت! "' + key + '" — ' + value); }
      else { await sendWA(from, '❓ وش تبيني أتذكر؟'); }
      break;
    }

    case 'recall': {
      const key = analysis.memory_key || analysis.task_title;
      if (key) {
        const fact = await recallFact(key);
        if (fact) {
          const days = Math.floor((new Date()-new Date(fact.updated_at))/(1000*60*60*24));
          await sendWA(from, '🧠 آخر تسجيل لـ "' + key + '":\n' + fact.value + '\n⏱ قبل ' + (days===0?'اليوم':days+' يوم'));
        } else { await sendWA(from, '❓ ما عندي معلومات عن "' + key + '"'); }
      }
      break;
    }

    case 'add_relation': {
      const name = analysis.relation_name || analysis.target_name;
      const info = analysis.relation_info || analysis.task_title || '';
      if (name) {
        await pool.query('INSERT INTO relations (name,info) VALUES ($1,$2)',[name,info]);
        await rememberFact('relation_' + name, info);
        await sendWA(from, '✅ حفظت معلومات ' + name + ':\n' + info);
      } else { await sendWA(from, '❓ وش اسم الشخص؟'); }
      break;
    }

    case 'recall_relation': {
      const name = analysis.relation_name || analysis.target_name;
      if (name) {
        const fact = await recallFact('relation_' + name);
        if (fact) { await sendWA(from, '👤 *' + name + ':*\n' + fact.value); }
        else { await sendWA(from, '❓ ما عندي معلومات عن ' + name); }
      }
      break;
    }

    case 'add_slot': {
      const date = analysis.date || todayStr();
      const time = analysis.time;
      if (time) {
        await pool.query('INSERT INTO available_slots (slot_date,slot_time) VALUES ($1,$2)',[date,time]);
        await sendWA(from, '✅ أضفت موعد متاح: ' + date + ' — ' + fmt12(time));
      } else {
        userState[from] = { step: 'waiting_add_slot', date };
        await sendWA(from, '⏰ وش الوقت المتاح؟ مثال: "3 العصر"');
      }
      break;
    }

    case 'show_slots': {
      const r = await pool.query('SELECT * FROM available_slots WHERE slot_date>=$1 AND is_booked=false ORDER BY slot_date,slot_time LIMIT 10',[todayStr()]);
      if (!r.rows.length) { await sendWA(from, '📅 ما في مواعيد متاحة\n\nأضف بقول: "أضف موعد متاح بكرة 3 العصر"'); }
      else {
        let list = '📅 *مواعيدك المتاحة:*\n\n';
        r.rows.forEach((s,i) => { list += (i+1) + '. ' + s.slot_date + ' — ' + fmt12(s.slot_time) + '\n'; });
        await sendWA(from, list);
      }
      break;
    }

    case 'show_today': {
      const r = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time',[todayStr()]);
      if (!r.rows.length) { await sendWA(from, '📋 ما عندك مهام اليوم ✅'); break; }
      let list = '📅 *مهام اليوم (' + r.rows.length + '):*\n\n';
      r.rows.forEach((t,i) => { list += (i+1) + '. ' + (t.type==='meeting'?'📅':t.type==='reminder'?'🔔':'✅') + ' *' + t.title + '*' + (t.time?' — '+fmt12(t.time):'') + '\n'; });
      await sendWA(from, list);
      break;
    }

    case 'show_tasks': {
      const r = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
      if (!r.rows.length) { await sendWA(from, '📋 لا توجد مهام ✅'); break; }
      let list = '📋 *مهامك المعلقة:*\n\n';
      r.rows.forEach((t,i) => { list += (i+1) + '. ' + (t.type==='meeting'?'📅':'✅') + ' *' + t.title + '*\n   ⏰ ' + fmt12(t.time) + ' — ' + t.date + (t.requested_by_name?' (من '+t.requested_by_name+')':'') + '\n\n'; });
      await sendWA(from, list);
      break;
    }

    case 'done': {
      const r = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
      if (!r.rows.length) { await sendWA(from, '📋 لا توجد مهام ✅'); break; }
      if (r.rows.length === 1) { await pool.query('UPDATE tasks SET done=true WHERE id=$1',[r.rows[0].id]); await sendWA(from, '✅ *' + r.rows[0].title + '* تم إنجازها 🎉'); break; }
      let list = '✅ *أي مهمة أنجزت؟*\n\n';
      r.rows.forEach((t,i) => { list += (i+1) + '. *' + t.title + '* — ' + fmt12(t.time) + '\n'; });
      await sendWA(from, list + '\nأرسل الرقم');
      userState[from] = { step: 'waiting_done_selection', tasks: r.rows };
      break;
    }

    case 'postpone': {
      const r = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
      if (!r.rows.length) { await sendWA(from, '📋 لا توجد مهام ✅'); break; }
      if (r.rows.length === 1) {
        const t = r.rows[0];
        if (!t.time) { await sendWA(from, '❓ هذه المهمة ما عندها وقت محدد'); break; }
        const [h,m] = t.time.split(':').map(Number);
        const d = new Date(); d.setHours(h+1,m);
        const nt = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
        await pool.query('UPDATE tasks SET time=$1,reminded=false,reminded_pre=false WHERE id=$2',[nt,t.id]);
        await sendWA(from, '⏰ تم تأجيل *' + t.title + '* لـ ' + fmt12(nt));
        break;
      }
      let list = '⏰ *أي مهمة تريد تأجيلها؟*\n\n';
      r.rows.forEach((t,i) => { list += (i+1) + '. *' + t.title + '* — ' + fmt12(t.time) + '\n'; });
      await sendWA(from, list + '\nأرسل الرقم');
      userState[from] = { step: 'waiting_postpone_selection', tasks: r.rows };
      break;
    }

    case 'delete': {
      const r = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
      if (!r.rows.length) { await sendWA(from, '📋 لا توجد مهام ✅'); break; }
      if (r.rows.length === 1) { await pool.query('DELETE FROM tasks WHERE id=$1',[r.rows[0].id]); await sendWA(from, '🗑️ تم حذف *' + r.rows[0].title + '*'); break; }
      let list = '🗑️ *أي مهمة تريد حذفها؟*\n\n';
      r.rows.forEach((t,i) => { list += (i+1) + '. *' + t.title + '* — ' + t.date + '\n'; });
      await sendWA(from, list + '\nأرسل الرقم');
      userState[from] = { step: 'waiting_delete_selection', tasks: r.rows };
      break;
    }

    case 'edit': {
      const r = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
      if (!r.rows.length) { await sendWA(from, '📋 لا توجد مهام ✅'); break; }
      if (r.rows.length === 1) {
        const t = r.rows[0];
        let opts = '✏️ *تعديل: ' + t.title + '*\n\n1. العنوان\n2. الوقت\n3. التاريخ\n4. الملاحظة' + (t.type==='meeting'?'\n5. الموقع':'') + '\n\nأرسل الرقم';
        userState[from] = { step: 'waiting_edit_field', task: t };
        await sendWA(from, opts); break;
      }
      let list = '✏️ *أي مهمة تريد تعديلها؟*\n\n';
      r.rows.forEach((t,i) => { list += (i+1) + '. *' + t.title + '*\n'; });
      await sendWA(from, list + '\nأرسل الرقم');
      userState[from] = { step: 'waiting_edit_selection', tasks: r.rows };
      break;
    }

    case 'add_task':
    case 'add_meeting':
    case 'add_reminder': {
      const type = analysis.action==='add_meeting'?'meeting':analysis.action==='add_reminder'?'reminder':'task';
      const title = analysis.task_title || msg;
      if (analysis.date && analysis.time) {
        if (type === 'meeting') {
          userState[from] = { step: 'waiting_location', taskTitle: title, taskType: 'meeting', taskNote: analysis.note||'', date: analysis.date, time: analysis.time };
          await sendWA(from, '📍 أين موقع الاجتماع؟\nأو أرسل *تخطي*');
        } else {
          const id = Date.now();
          await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location) VALUES ($1,$2,$3,$4,$5,$6,$7)',[id,title,type,analysis.date,analysis.time,analysis.note||'','']);
          await sendWA(from, '✅ تم التسجيل!\n📌 *' + title + '*\n⏰ ' + fmt12(analysis.time) + '\n📅 ' + analysis.date);
        }
      } else {
        userState[from] = { step: 'waiting_datetime', taskTitle: title, taskType: type, taskNote: analysis.note||'' };
        await sendWA(from, '📌 *' + title + '*\n\n❓ متى وفي أي وقت؟');
      }
      break;
    }

    case 'help': {
      await sendWA(from, '📖 *نواف يفهمك مباشرة!*\n\nأمثلة:\n• "اجتماع مع الفريق بكرة 3 العصر"\n• "اعتمد" / "ارفض"\n• "ذكّره بعد ساعة"\n• "مشغول" / "رجعت"\n• "تذكر إني غيرت زيت السيارة"\n• "أضف موعد متاح بكرة 3"\n• أي سؤال في أي موضوع 😊\n\n_مهامي_ ✨');
      break;
    }

    default: {
      const reply = await nawafOwnerReply(msg, context);
      if (reply) { await sendWA(from, reply); }
      else { await sendWA(from, '❓ ما فهمت، جرب مرة ثانية'); }
      break;
    }
  }
}

// ─── Handle Owner State ───────────────────────────────────────────────────
async function handleOwnerState(from, msg, state) {
  if (state.step === 'waiting_remind_visitor_time') {
    const p = await parseTask('تذكير في ' + msg);
    if (p?.time) {
      await pool.query('UPDATE tasks SET status=$1,time=$2,date=$3,reminded=false WHERE id=$4',['approved',p.time,p.date||todayStr(),state.taskId]);
      await sendWA(from, '✅ سأذكّر ' + state.visitorName + ' الساعة ' + fmt12(p.time));
    } else { await sendWA(from, '❓ متى؟ مثال: "بعد ساعة"'); return; }
    userState[from] = { step: 'idle' }; return;
  }
  if (state.step === 'waiting_add_slot') {
    const p = await parseTask('موعد ' + msg);
    if (p?.time) {
      await pool.query('INSERT INTO available_slots (slot_date,slot_time) VALUES ($1,$2)',[p.date||state.date||todayStr(),p.time]);
      await sendWA(from, '✅ أضفت موعد متاح: ' + fmt12(p.time));
    } else { await sendWA(from, '❓ لم أفهم الوقت'); return; }
    userState[from] = { step: 'idle' }; return;
  }
  if (state.step === 'waiting_datetime') {
    const p = await parseTask(state.taskTitle + ' ' + msg);
    if (p?.date && p?.time) {
      if (state.taskType === 'meeting') {
        userState[from] = { ...state, step: 'waiting_location', date: p.date, time: p.time }; await sendWA(from, '📍 أين موقع الاجتماع؟\nأو أرسل *تخطي*');
      } else {
        const id = Date.now(); await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location) VALUES ($1,$2,$3,$4,$5,$6,$7)',[id,state.taskTitle,state.taskType||'task',p.date,p.time,state.taskNote||'','']);
        await sendWA(from, '✅ تم التسجيل!\n📌 *' + state.taskTitle + '*\n⏰ ' + fmt12(p.time) + '\n📅 ' + p.date);
        userState[from] = { step: 'idle' };
      }
    } else { await sendWA(from, '❓ لم أفهم الوقت. مثال: "غداً الساعة 3 العصر"'); }
    return;
  }
  if (state.step === 'waiting_location') {
    const location = msg === 'تخطي' ? '' : msg;
    const id = Date.now(); await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location) VALUES ($1,$2,$3,$4,$5,$6,$7)',[id,state.taskTitle,'meeting',state.date,state.time,state.taskNote||'',location]);
    let reply = '✅ تم تسجيل الاجتماع!\n📌 *' + state.taskTitle + '*\n⏰ ' + fmt12(state.time) + '\n📅 ' + state.date;
    if (location) reply += '\n📍 ' + location;
    await sendWA(from, reply); userState[from] = { step: 'idle' }; return;
  }
  if (state.step === 'waiting_done_selection') {
    const n = parseInt(msg);
    if (n >= 1 && n <= state.tasks.length) { await pool.query('UPDATE tasks SET done=true WHERE id=$1',[state.tasks[n-1].id]); await sendWA(from, '✅ *' + state.tasks[n-1].title + '* تم إنجازها 🎉'); userState[from] = { step: 'idle' }; }
    else { await sendWA(from, '❓ أرسل رقم من القائمة'); }
    return;
  }
  if (state.step === 'waiting_postpone_selection') {
    const n = parseInt(msg);
    if (n >= 1 && n <= state.tasks.length) {
      const t = state.tasks[n-1];
      if (!t.time) { await sendWA(from, '❓ هذه المهمة ما عندها وقت'); userState[from] = { step: 'idle' }; return; }
      const [h,m2] = t.time.split(':').map(Number); const d = new Date(); d.setHours(h+1,m2);
      const nt = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
      await pool.query('UPDATE tasks SET time=$1,reminded=false WHERE id=$2',[nt,t.id]); await sendWA(from, '⏰ تم تأجيل *' + t.title + '* لـ ' + fmt12(nt));
      userState[from] = { step: 'idle' };
    } else { await sendWA(from, '❓ أرسل رقم من القائمة'); }
    return;
  }
  if (state.step === 'waiting_delete_selection') {
    const n = parseInt(msg);
    if (n >= 1 && n <= state.tasks.length) { await pool.query('DELETE FROM tasks WHERE id=$1',[state.tasks[n-1].id]); await sendWA(from, '🗑️ تم حذف *' + state.tasks[n-1].title + '*'); userState[from] = { step: 'idle' }; }
    else { await sendWA(from, '❓ أرسل رقم من القائمة'); }
    return;
  }
  if (state.step === 'waiting_edit_selection') {
    const n = parseInt(msg);
    if (n >= 1 && n <= state.tasks.length) {
      const t = state.tasks[n-1];
      let opts = '✏️ *تعديل: ' + t.title + '*\n\n1. العنوان\n2. الوقت\n3. التاريخ\n4. الملاحظة' + (t.type==='meeting'?'\n5. الموقع':'') + '\n\nأرسل الرقم';
      userState[from] = { step: 'waiting_edit_field', task: t }; await sendWA(from, opts);
    } else { await sendWA(from, '❓ أرسل رقم من القائمة'); }
    return;
  }
  if (state.step === 'waiting_edit_field') {
    const n = parseInt(msg);
    const fields = {1:'title',2:'time',3:'date',4:'note',5:'location'};
    const labels = {1:'العنوان الجديد',2:'الوقت الجديد',3:'التاريخ الجديد',4:'الملاحظة الجديدة',5:'الموقع الجديد'};
    if (fields[n]) { userState[from] = { step: 'waiting_edit_value', task: state.task, field: fields[n] }; await sendWA(from, '✏️ أرسل ' + labels[n] + ':'); }
    else { await sendWA(from, '❓ أرسل رقم صحيح'); }
    return;
  }
  if (state.step === 'waiting_edit_value') {
    const t = state.task; const field = state.field; let nv = msg;
    if (field === 'time' || field === 'date') {
      const p = await parseTask('مهمة ' + (field==='time'?msg:'في '+msg));
      if (field==='time' && p?.time) nv = p.time; else if (field==='date' && p?.date) nv = p.date;
      else { await sendWA(from, '❓ لم أفهم'); return; }
    }
    await pool.query('UPDATE tasks SET ' + field + '=$1 WHERE id=$2',[nv,t.id]);
    await sendWA(from, '✅ تم التعديل!'); userState[from] = { step: 'idle' }; return;
  }
  userState[from] = { step: 'idle' }; await handleOwner(from, msg);
}

// ─── Handle Wife ──────────────────────────────────────────────────────────
async function handleWife(from, msg) {
  try {
    const keywords = ['خبز','حليب','تسوق','سوبرماركت','بقالة','دجاج','لحم','بيض'];
    let memCtx = '';
    for (const kw of keywords) {
      if (msg.includes(kw)) {
        const fact = await recallFact(kw);
        if (fact) {
          const days = Math.floor((new Date()-new Date(fact.updated_at))/(1000*60*60*24));
          memCtx += 'آخر مرة اشترى عبدالعزيز ' + kw + ': ' + fact.value + ' (قبل ' + days + ' يوم)\n';
        }
      }
    }
    const reply = await callAI('claude-sonnet-4-20250514', 400,
      'أنت "نواف" مساعد عبدالعزيز. هذه زوجته، تعاملها باحترام وود خاص.\n' +
      (memCtx ? 'معلومات مفيدة:\n' + memCtx + '\n' : '') +
      'رسالة الزوجة: "' + msg + '"\n\n' +
      'رد بشكل طبيعي ومفيد. إذا كان في الرسالة معلومة مهمة لعبدالعزيز أخبره بها.'
    );
    if (reply) await sendWA(from, reply);
    const importantKw = ['طارئ','مهم','عاجل','مريض','مشكلة'];
    if (importantKw.some(k => msg.includes(k))) await sendWA(PHONE, '📱 *رسالة من الزوجة:*\n' + msg);
  } catch(e) { console.error('Wife:', e.message); }
}

// ─── Handle Visitor ───────────────────────────────────────────────────────
async function handleVisitor(from, msg) {
  const state = userState[from] || { step: 'idle', history: [] };
  if (!state.history) state.history = [];

  let visitor = null;
  try { const r = await pool.query('SELECT * FROM visitors WHERE phone=$1',[from]); if (r.rows.length) visitor = r.rows[0]; } catch(e) {}
  const visitorName = visitor?.name || state.visitorName || null;
  if (visitor) try { await pool.query('UPDATE visitors SET msg_count=msg_count+1,last_seen=NOW() WHERE phone=$1',[from]); } catch(e) {}

  // وضع الغياب
  const busy = await isBusy();
  if (busy && visitorName && !sentReminders.has('busy_' + from + '_' + todayStr())) {
    sentReminders.add('busy_' + from + '_' + todayStr());
    await sendWA(from, 'هلا ' + visitorName + '! 👋\nعبدالعزيز مشغول الحين بس أنا هنا لخدمتك');
  }

  // انتظار اختيار موعد
  if (state.step === 'waiting_slot_choice') {
    const n = parseInt(msg.replace(/[^0-9]/g,''));
    if (n >= 1 && n <= (state.slots||[]).length) {
      const slot = state.slots[n-1]; const topic = state.meetingTopic || 'اجتماع';
      await pool.query('UPDATE available_slots SET is_booked=true WHERE id=$1',[slot.id]);
      const id = Date.now();
      await pool.query('INSERT INTO tasks (id,title,type,date,time,note,requested_by,requested_by_name,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,topic,'meeting',slot.slot_date,slot.slot_time,'',from,visitorName,'pending']);
      await sendWA(from, '✅ تم تسجيل موعدك!\n📅 ' + slot.slot_date + '\n⏰ ' + fmt12(slot.slot_time) + '\n📌 ' + topic + '\n\nسأبلغك بتأكيد عبدالعزيز 😊');
      await sendWA(PHONE, buildRequestNotif(visitorName, from, 'meeting', topic, slot.slot_date, slot.slot_time));
      userState[from] = { step: 'idle', history: state.history, visitorName }; return;
    } else { await sendWA(from, '❓ اختر رقم من القائمة'); return; }
  }

  // انتظار اختيار تذكير
  if (state.step === 'waiting_reminder_choice') {
    const isYes = ['1','١','أيوه','ايوه','نعم','اي','yes'].some(w => msg.includes(w));
    if (isYes) {
      if (state.reminderTime) {
        const id = Date.now();
        await pool.query('INSERT INTO tasks (id,title,type,date,time,note,requested_by,requested_by_name,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,state.reminderTitle,'reminder',state.reminderDate||todayStr(),state.reminderTime,'',from,visitorName,'approved']);
        await sendWA(from, '✅ سأذكّرك بـ "' + state.reminderTitle + '" في ' + fmt12(state.reminderTime) + ' 🔔');
        await sendWA(PHONE, '📬 نواف سيذكّر ' + visitorName + ' بـ "' + state.reminderTitle + '" الساعة ' + fmt12(state.reminderTime));
      } else {
        userState[from] = { step: 'waiting_visitor_reminder_time', history: state.history, visitorName, reminderTitle: state.reminderTitle, directReminder: true };
        await sendWA(from, '⏰ متى تبغى أذكّرك؟ مثال: "بعد ساعة"'); return;
      }
    } else {
      const id = Date.now();
      await pool.query('INSERT INTO tasks (id,title,type,date,time,note,requested_by,requested_by_name,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,state.reminderTitle,'reminder',state.reminderDate,state.reminderTime,'',from,visitorName,'pending']);
      await sendWA(from, 'تم استلام طلبك! 📨\nسأرفع الطلب لعبدالعزيز الحين وأبلغك بقراره ✅');
      await sendWA(PHONE, buildRequestNotif(visitorName, from, 'reminder', state.reminderTitle, state.reminderDate, state.reminderTime));
    }
    userState[from] = { step: 'idle', history: state.history, visitorName }; return;
  }

  // انتظار وقت تذكير الزائر
  if (state.step === 'waiting_visitor_reminder_time') {
    const p = await parseTask(msg);
    if (p?.time) {
      const id = Date.now(); const date = p.date || todayStr();
      await pool.query('INSERT INTO tasks (id,title,type,date,time,note,requested_by,requested_by_name,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,state.reminderTitle,'reminder',date,p.time,'',from,visitorName,'approved']);
      await sendWA(from, '✅ سأذكّرك بـ "' + state.reminderTitle + '" في ' + fmt12(p.time) + ' 🔔');
      if (state.directReminder) await sendWA(PHONE, '📬 نواف سيذكّر ' + visitorName + ' بـ "' + state.reminderTitle + '" الساعة ' + fmt12(p.time));
      userState[from] = { step: 'idle', history: state.history, visitorName };
    } else { await sendWA(from, '❓ متى؟ مثال: "الساعة 3 العصر"'); }
    return;
  }

  // انتظار موضوع تذكير الزائر
  if (state.step === 'waiting_visitor_reminder_topic') {
    userState[from] = { step: 'waiting_visitor_reminder_time', history: state.history, visitorName, reminderTitle: msg, directReminder: true };
    await sendWA(from, '⏰ متى تبغى أذكّرك؟\nمثال: "بكرة الساعة 10"'); return;
  }

  // انتظار تفاصيل الطلب
  if (state.step === 'waiting_visitor_details') {
    const p = await parseTask(msg);
    const title = p?.title || msg; const date = p?.date || null; const time = p?.time || null;
    const id = Date.now();
    await pool.query('INSERT INTO tasks (id,title,type,date,time,note,requested_by,requested_by_name,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,title,state.requestType,date,time,'',from,visitorName,'pending']);
    await pool.query('UPDATE visitors SET last_request=$1 WHERE phone=$2',[title,from]);
    await sendWA(from, 'تم استلام طلبك! 📨\nسأرفع الطلب لعبدالعزيز الحين وأبلغك بقراره ✅');
    await sendWA(PHONE, buildRequestNotif(visitorName, from, state.requestType, title, date, time));
    userState[from] = { step: 'idle', history: state.history, visitorName }; return;
  }

  // تحليل الرسالة
  const context = visitorName ? 'الزائر اسمه ' + visitorName + '، في محادثة مع نواف مساعد عبدالعزيز' : 'زائر جديد، سألناه عن اسمه';
  const analysis = await analyzeVisitor(msg, context) || { intent: 'unknown', confidence: 'low' };
  console.log('🧠 visitor intent:', analysis.intent, 'confidence:', analysis.confidence);

  // زائر جديد
  if (!visitorName) {
    if (state.step !== 'waiting_name') {
      userState[from] = { step: 'waiting_name', history: [] };
      await sendWA(from, welcomeMsg()); return;
    }
    if (analysis.intent === 'name' && analysis.name) {
      const name = analysis.name.trim();
      await pool.query('INSERT INTO visitors (phone,name,msg_count) VALUES ($1,$2,1) ON CONFLICT (phone) DO UPDATE SET name=$2',[from,name]);
      userState[from] = { step: 'idle', history: [], visitorName: name };
      await sendWA(from, menuMsg(name)); return;
    }
    if (analysis.intent === 'task_request' || analysis.intent === 'meeting_request' || analysis.intent === 'reminder_for_owner') {
      userState[from] = { ...state, pendingRequest: { intent: analysis.intent, title: analysis.task_title||msg } };
      await sendWA(from, 'تمام، وصلني طلبك! 😊\nبس قبل ما أوصله — ممكن تشرّفني باسمك؟'); return;
    }
    if (analysis.intent === 'greeting') {
      await sendWA(from, (greeting()==='صباح الخير'?'صباح النور':'مساء النور') + '! 😊\nممكن تشرّفني باسمك؟'); return;
    }
    await sendWA(from, 'عذراً ما فهمت اسمك 😊\nممكن تكتب اسمك الكريم فقط؟'); return;
  }

  // ترحيب بالزوار العائدين
  if (visitor && state.step === 'idle' && !state._welcomed) {
    const days = Math.floor((new Date()-new Date(visitor.last_seen))/(1000*60*60*24));
    if (days > 3) {
      userState[from] = { ...state, _welcomed: true };
      const lastReq = visitor.last_request ? ' آخر مرة طلبت "' + visitor.last_request + '"' : '';
      await sendWA(from, 'هلا ' + visitorName + '! 👋 زمان ما شفناك 😄' + lastReq + '\nوش تأمر اليوم؟');
      if (analysis.intent === 'greeting') return;
    }
  }

  // تحديث أو إلغاء
  if (analysis.intent === 'update_request' || analysis.intent === 'cancel_request') {
    try {
      const last = await pool.query("SELECT * FROM tasks WHERE requested_by=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1",[from]);
      if (last.rows.length) {
        const t = last.rows[0];
        if (analysis.intent === 'cancel_request') {
          await pool.query('UPDATE tasks SET status=$1 WHERE id=$2',['cancelled',t.id]);
          await sendWA(from, 'تمام، تم إلغاء طلبك "' + t.title + '" ✅');
          await sendWA(PHONE, '📬 ' + visitorName + ' ألغى طلبه: "' + t.title + '"');
        } else {
          await pool.query('UPDATE tasks SET note=$1 WHERE id=$2',['تحديث: ' + msg, t.id]);
          await sendWA(from, 'تمام، وصلني تحديثك ✅');
          await sendWA(PHONE, '📬 تحديث من ' + visitorName + ' على "' + t.title + '":\n' + msg);
        }
      } else {
        await sendWA(PHONE, '📬 رسالة من ' + visitorName + ':\n' + msg);
        await sendWA(from, 'تمام، وصّلت رسالتك ✅');
      }
    } catch(e) {}
    userState[from] = { step: 'idle', history: state.history, visitorName }; return;
  }

  // اختيار رقم
  if (analysis.intent === 'number_choice' && analysis.choice) {
    const ch = parseInt(analysis.choice);
    if (ch === 1) { userState[from] = { step: 'waiting_visitor_details', requestType: 'task', history: state.history, visitorName }; await sendWA(from, '📌 أخبرني بتفاصيل الطلب 👇'); }
    else if (ch === 2) {
      const slots = await pool.query('SELECT * FROM available_slots WHERE slot_date>=$1 AND is_booked=false ORDER BY slot_date,slot_time LIMIT 5',[todayStr()]).catch(()=>({rows:[]}));
      if (slots.rows.length) {
        let sm = '📅 الأوقات المتاحة لعبدالعزيز:\n\n';
        slots.rows.forEach((s,i) => { sm += (i+1) + '️⃣ ' + s.slot_date + ' — ' + fmt12(s.slot_time) + '\n'; });
        sm += '\nاختر رقم الموعد المناسب 👇';
        userState[from] = { step: 'waiting_slot_choice', slots: slots.rows, history: state.history, visitorName, meetingTopic: null };
        await sendWA(from, sm);
      } else { userState[from] = { step: 'waiting_visitor_details', requestType: 'meeting', history: state.history, visitorName }; await sendWA(from, '📅 أخبرني عن موضوع الاجتماع والوقت المناسب 👇'); }
    }
    else if (ch === 3) { userState[from] = { step: 'waiting_visitor_details', requestType: 'reminder', history: state.history, visitorName }; await sendWA(from, '🔔 وش تبيني أذكّر عبدالعزيز فيه؟ 👇'); }
    else if (ch === 4) { userState[from] = { step: 'waiting_visitor_reminder_topic', history: state.history, visitorName }; await sendWA(from, '🔔 وش تبيني أذكّرك فيه؟ 👇'); }
    return;
  }

  // طلبات محددة
  if (analysis.intent === 'task_request') {
    if (analysis.task_title && (analysis.date || analysis.time)) {
      const id = Date.now();
      await pool.query('INSERT INTO tasks (id,title,type,date,time,note,requested_by,requested_by_name,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,analysis.task_title,'task',analysis.date,analysis.time,'',from,visitorName,'pending']);
      await pool.query('UPDATE visitors SET last_request=$1 WHERE phone=$2',[analysis.task_title,from]);
      await sendWA(from, 'تم استلام طلبك! 📨\nسأرفع الطلب لعبدالعزيز الحين وأبلغك بقراره ✅');
      await sendWA(PHONE, buildRequestNotif(visitorName, from, 'task', analysis.task_title, analysis.date, analysis.time));
    } else { userState[from] = { step: 'waiting_visitor_details', requestType: 'task', history: state.history, visitorName }; await sendWA(from, '📌 أخبرني بتفاصيل الطلب 👇'); }
    return;
  }

  if (analysis.intent === 'meeting_request') {
    const slots = await pool.query('SELECT * FROM available_slots WHERE slot_date>=$1 AND is_booked=false ORDER BY slot_date,slot_time LIMIT 5',[todayStr()]).catch(()=>({rows:[]}));
    if (slots.rows.length) {
      let sm = '📅 الأوقات المتاحة لعبدالعزيز:\n\n';
      slots.rows.forEach((s,i) => { sm += (i+1) + '️⃣ ' + s.slot_date + ' — ' + fmt12(s.slot_time) + '\n'; });
      sm += '\nاختر رقم الموعد المناسب 👇';
      userState[from] = { step: 'waiting_slot_choice', slots: slots.rows, history: state.history, visitorName, meetingTopic: analysis.task_title };
      await sendWA(from, sm);
    } else if (analysis.task_title && (analysis.date || analysis.time)) {
      const id = Date.now();
      await pool.query('INSERT INTO tasks (id,title,type,date,time,note,requested_by,requested_by_name,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,analysis.task_title,'meeting',analysis.date,analysis.time,'',from,visitorName,'pending']);
      await pool.query('UPDATE visitors SET last_request=$1 WHERE phone=$2',[analysis.task_title,from]);
      await sendWA(from, 'تم استلام طلبك! 📨\nسأرفع الطلب لعبدالعزيز الحين وأبلغك بقراره ✅');
      await sendWA(PHONE, buildRequestNotif(visitorName, from, 'meeting', analysis.task_title, analysis.date, analysis.time));
    } else { userState[from] = { step: 'waiting_visitor_details', requestType: 'meeting', history: state.history, visitorName }; await sendWA(from, '📅 أخبرني عن موضوع الاجتماع والوقت 👇'); }
    return;
  }

  if (analysis.intent === 'reminder_for_owner') {
    if (analysis.task_title) {
      userState[from] = { step: 'waiting_reminder_choice', reminderTitle: analysis.task_title, reminderDate: analysis.date, reminderTime: analysis.time, history: state.history, visitorName };
      await sendWA(from, '🔔 فاهم إنك تبغى تذكّر عبدالعزيز بـ "' + analysis.task_title + '"\n\nشرايك أذكّرك أنا مباشرة بدون ما تنتظر رد؟ 😊\n\n1️⃣ أيوه، ذكّرني أنت\n2️⃣ لا، أرسلها لعبدالعزيز');
    } else { userState[from] = { step: 'waiting_visitor_details', requestType: 'reminder', history: state.history, visitorName }; await sendWA(from, '🔔 وش تبيني أذكّر عبدالعزيز فيه؟ 👇'); }
    return;
  }

  if (analysis.intent === 'reminder_for_self') {
    userState[from] = { step: 'waiting_visitor_reminder_topic', history: state.history, visitorName };
    await sendWA(from, '🔔 وش تبيني أذكّرك فيه؟ 👇'); return;
  }

  // رد نواف الذكي
  state.history.push({ role: 'visitor', msg });
  const reply = await nawafVisitorReply(visitorName||'الزائر', msg, state.history);
  if (reply) {
    state.history.push({ role: 'nawaf', msg: reply });
    userState[from] = { ...state };
    if (state.history.length > 6 && state.history.length % 6 === 0) {
      await sendWA(from, reply + '\n\n─────────────\nأقدر أساعدك في:\n1️⃣ مهمة / 2️⃣ اجتماع / 3️⃣ تذكير لعبدالعزيز / 4️⃣ تذكيرك أنت 😊');
    } else { await sendWA(from, reply); }
    // تعلم من المحادثة الطويلة
    if (state.history.length >= 10) setImmediate(() => learnFromConversation(visitorName, state.history, ''));
  } else {
    await sendWA(from, 'ما فهمت وضح أكثر 😊\nأو اختر:\n\n1️⃣ مهمة / 2️⃣ اجتماع / 3️⃣ تذكير لعبدالعزيز / 4️⃣ تذكيرك أنت');
  }
}

// ─── API Routes ───────────────────────────────────────────────────────────
app.get('/tasks', async (req,res) => { try { res.json((await pool.query('SELECT * FROM tasks ORDER BY date,time')).rows); } catch(e) { res.status(500).json({error:e.message}); } });

app.post('/tasks', async (req,res) => {
  const { title,type,date,time,note,location } = req.body;
  if (!title||!date||!time) return res.status(400).json({error:'بيانات ناقصة'});
  const id = Date.now();
  try { await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location) VALUES ($1,$2,$3,$4,$5,$6,$7)',[id,title,type||'task',date,time,note||'',location||'']); res.json({id,title,type:type||'task',date,time,note:note||'',location:location||'',done:false}); } catch(e) { res.status(500).json({error:e.message}); }
});

app.patch('/tasks/:id', async (req,res) => {
  const { done,title,type,date,time,note,location,priority } = req.body;
  try {
    if (done !== undefined) {
      await pool.query('UPDATE tasks SET done=$1 WHERE id=$2',[done,req.params.id]);
    } else {
      const f=[],v=[]; let i=1;
      if(title!==undefined){f.push('title=$'+i++);v.push(title);}
      if(type!==undefined){f.push('type=$'+i++);v.push(type);}
      if(date!==undefined){f.push('date=$'+i++);v.push(date);}
      if(time!==undefined){f.push('time=$'+i++);v.push(time);}
      if(note!==undefined){f.push('note=$'+i++);v.push(note);}
      if(location!==undefined){f.push('location=$'+i++);v.push(location);}
      if(priority!==undefined){f.push('priority=$'+i++);v.push(priority);}
      if(f.length){v.push(req.params.id);await pool.query('UPDATE tasks SET '+f.join(',')+" WHERE id=$"+i,v);}
    }
    res.json((await pool.query('SELECT * FROM tasks WHERE id=$1',[req.params.id])).rows[0]);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.delete('/tasks/:id', async (req,res) => { try { await pool.query('DELETE FROM tasks WHERE id=$1',[req.params.id]); res.json({ok:true}); } catch(e) { res.status(500).json({error:e.message}); } });

app.post('/tasks/:id/send', async (req,res) => {
  try { const t=(await pool.query('SELECT * FROM tasks WHERE id=$1',[req.params.id])).rows[0]; if(!t) return res.status(404).json({error:'غير موجودة'}); await sendWA(PHONE,buildTaskMsg(t)); res.json({ok:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/visitors', async (req,res) => { try { res.json((await pool.query('SELECT * FROM visitors ORDER BY last_seen DESC')).rows); } catch(e) { res.json([]); } });
app.get('/relations', async (req,res) => { try { res.json((await pool.query('SELECT * FROM relations ORDER BY created_at DESC')).rows); } catch(e) { res.json([]); } });
app.get('/memory', async (req,res) => { try { res.json((await pool.query('SELECT * FROM memory ORDER BY updated_at DESC LIMIT 50')).rows); } catch(e) { res.json([]); } });

app.get('/slots', async (req,res) => { try { res.json((await pool.query('SELECT * FROM available_slots WHERE slot_date>=$1 ORDER BY slot_date,slot_time',[todayStr()])).rows); } catch(e) { res.json([]); } });
app.post('/slots', async (req,res) => { const {slot_date,slot_time}=req.body; try { res.json((await pool.query('INSERT INTO available_slots (slot_date,slot_time) VALUES ($1,$2) RETURNING *',[slot_date,slot_time])).rows[0]); } catch(e) { res.status(500).json({error:e.message}); } });
app.delete('/slots/:id', async (req,res) => { try { await pool.query('DELETE FROM available_slots WHERE id=$1',[req.params.id]); res.json({ok:true}); } catch(e) { res.status(500).json({error:e.message}); } });

app.get('/appointment-requests', async (req,res) => { try { res.json((await pool.query("SELECT *,requested_by_name AS name,requested_by AS phone,date AS proposed_date,time AS proposed_time FROM tasks WHERE requested_by!='' ORDER BY created_at DESC LIMIT 20")).rows); } catch(e) { res.json([]); } });
app.get('/visitor-reminders', async (req,res) => { try { res.json((await pool.query("SELECT *,requested_by AS phone FROM tasks WHERE requested_by!='' AND type='reminder' ORDER BY created_at DESC LIMIT 20")).rows); } catch(e) { res.json([]); } });

app.get('/working-hours', async (req,res) => {
  try { const r=await pool.query("SELECT * FROM settings WHERE key='working_hours'"); if(r.rows.length) return res.json(JSON.parse(r.rows[0].value)); res.json({start_time:'10:00',end_time:'18:00',gap_minutes:60,working_days:'6,0,1,2,3,4'}); } catch(e) { res.json({start_time:'10:00',end_time:'18:00',gap_minutes:60,working_days:'6,0,1,2,3,4'}); }
});
app.patch('/working-hours', async (req,res) => {
  try { await pool.query(`INSERT INTO settings (key,value) VALUES ('working_hours',$1) ON CONFLICT (key) DO UPDATE SET value=$1`,[JSON.stringify(req.body)]); res.json({ok:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/', (req,res) => res.json({ status:'🟢 مهامي شغّال', time: new Date().toLocaleString('ar-SA') }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 مهامي على port ' + PORT));

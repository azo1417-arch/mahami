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
app.get('/dashboard', (req,res) => res.sendFile(path.join(__dirname,'dashboard.html')));

// ─── Config ───────────────────────────────────────────────────────────────
const PHONE       = '966563466639';
const WIFE_PHONE  = '966559003046';
const GA_INSTANCE = '7107577151';
const GA_TOKEN    = 'bf8e5a28cfdc41fabb681fe798d38a303a7a681653c34caeb3';
const GA_URL      = 'https://7107.api.greenapi.com/waInstance' + GA_INSTANCE;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── DB Init ──────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS tasks (" +
    "id BIGINT PRIMARY KEY, title TEXT NOT NULL, type TEXT DEFAULT 'task'," +
    "date TEXT, time TEXT, note TEXT DEFAULT '', location TEXT DEFAULT ''," +
    "done BOOLEAN DEFAULT FALSE, priority TEXT DEFAULT 'normal'," +
    "requested_by TEXT DEFAULT '', requested_by_name TEXT DEFAULT ''," +
    "status TEXT DEFAULT 'pending', reminded BOOLEAN DEFAULT FALSE," +
    "reminded_pre BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW())"
  );
  const boolCols = ['reminded','reminded_pre'];
  const textCols = ['location','priority','requested_by','requested_by_name','status'];
  for (const c of boolCols) await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ' + c + ' BOOLEAN DEFAULT FALSE').catch(()=>{});
  for (const c of textCols) await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS " + c + " TEXT DEFAULT ''").catch(()=>{});

  await pool.query(
    "CREATE TABLE IF NOT EXISTS visitors (" +
    "phone TEXT PRIMARY KEY, name TEXT NOT NULL, msg_count INTEGER DEFAULT 0," +
    "last_seen TIMESTAMP DEFAULT NOW(), last_request TEXT DEFAULT '', created_at TIMESTAMP DEFAULT NOW())"
  );
  await pool.query("ALTER TABLE visitors ADD COLUMN IF NOT EXISTS last_request TEXT DEFAULT ''").catch(()=>{});

  await pool.query("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");
  await pool.query("INSERT INTO settings (key,value) VALUES ('busy_mode','false') ON CONFLICT (key) DO NOTHING");

  await pool.query(
    "CREATE TABLE IF NOT EXISTS memory (" +
    "id BIGSERIAL PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT NOT NULL, updated_at TIMESTAMP DEFAULT NOW())"
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS relations (" +
    "id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, info TEXT DEFAULT '', created_at TIMESTAMP DEFAULT NOW())"
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS available_slots (" +
    "id BIGSERIAL PRIMARY KEY, slot_date TEXT, slot_time TEXT, is_booked BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW())"
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS special_contacts (" +
    "phone TEXT PRIMARY KEY, name TEXT NOT NULL, relation TEXT DEFAULT '')"
  );
  await pool.query(
    "INSERT INTO special_contacts (phone,name,relation) VALUES ('" + WIFE_PHONE + "','الزوجة','wife') ON CONFLICT (phone) DO NOTHING"
  );
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
  try {
    await pool.query(
      'INSERT INTO memory (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW()',
      [key, value]
    );
  } catch(e) {}
}
async function recallFact(key) {
  try { const r = await pool.query('SELECT value,updated_at FROM memory WHERE key=$1',[key]); return r.rows[0]||null; } catch(e) { return null; }
}

// ─── Lessons & Learning ───────────────────────────────────────────────────
async function getLessons(key) {
  const k = key || 'nawaf_lessons';
  try { const r = await pool.query('SELECT value FROM settings WHERE key=$1',[k]); return r.rows[0]?.value||''; } catch(e) { return ''; }
}
async function saveLessons(key, lessons) {
  try { await pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',[key,lessons]); } catch(e) {}
}

async function learnFromVisitor(visitorName, history, outcome) {
  if (!history || history.length < 2) return;
  try {
    const current = await getLessons('visitor_lessons');
    const histText = history.slice(-10).map(function(h) {
      return (h.role==='visitor' ? visitorName : 'نواف') + ': ' + h.msg;
    }).join('\n');
    const prompt =
      'أنت مدرب يطور نواف المساعد.\n' +
      'الدروس الحالية:\n' + (current||'لا يوجد') + '\n\n' +
      'محادثة مع ' + visitorName + ':\n' + histText + '\n' +
      (outcome ? 'النتيجة: ' + outcome + '\n' : '') +
      '\nاستخرج دروساً عملية (حد أقصى 15)، كل درس سطر يبدأ بـ نقطة\n' +
      'ركز على: كيف يتكلم الزوار، عبارات شائعة، كيف يتحسن نواف';
    const res = await callAI('claude-sonnet-4-20250514', 400, prompt);
    if (res) await saveLessons('visitor_lessons', res);
  } catch(e) {}
}

async function learnFromOwner(action, detail, originalMsg) {
  // لا نتعلم من الأوامر البسيطة أو القصيرة
  const skipActions = ['فعّل وضع الغياب','أضاف reminder'];
  if (skipActions.includes(action)) return;
  if (originalMsg.length < 5) return;
  try {
    const current = await getLessons('owner_lessons');
    const prompt =
      'أنت مدرب يتعلم أسلوب عبدالعزيز.\n' +
      'الدروس الحالية:\n' + (current||'لا يوجد') + '\n\n' +
      'تصرف جديد: ' + action + '\n' +
      'التفاصيل: ' + detail + '\n' +
      'الرسالة: "' + originalMsg + '"\n\n' +
      'استخرج دروساً (حد أقصى 15)، كل درس سطر يبدأ بـ نقطة\n' +
      'ركز على: طريقة أوامره، قراراته، أولوياته، أسلوب كلامه';
    const res = await callAI('claude-sonnet-4-20250514', 300, prompt);
    if (res) await saveLessons('owner_lessons', res);
  } catch(e) {}
}

// ─── AI Caller ────────────────────────────────────────────────────────────
async function callAI(model, max_tokens, prompt) {
  try {
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model, max_tokens,
      messages: [{ role:'user', content: prompt }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version':'2023-06-01', 'content-type':'application/json' }
    });
    return res.data.content[0].text.trim();
  } catch(e) { console.error('AI Error:', e.message); return null; }
}

async function callAIJson(model, max_tokens, prompt) {
  const text = await callAI(model, max_tokens, prompt);
  if (!text) return null;
  try {
    // إزالة markdown code blocks إذا وُجدت
    const clean = text.replace(/^```[a-z]*\n?/,'').replace(/```\s*$/,'').trim();
    return JSON.parse(clean);
  } catch(e) { return null; }
}

// ─── Parse Task ───────────────────────────────────────────────────────────
async function parseTask(msg) {
  const now      = new Date();
  const today    = todayStr();
  const tom      = new Date(now); tom.setDate(now.getDate()+1);
  const tomorrow = tom.getFullYear() + '-' + String(tom.getMonth()+1).padStart(2,'0') + '-' + String(tom.getDate()).padStart(2,'0');
  const cur      = nowTime();
  const dayName  = now.toLocaleDateString('ar-SA', { weekday:'long', timeZone:'Asia/Riyadh' });

  let processed = msg;
  const rel = msg.match(/بعد\s+(\d+)\s*(دقيقة|دقائق|ساعة|ساعات)/);
  if (rel) {
    const mins = (rel[2].includes('ساعة')||rel[2].includes('ساعات')) ? parseInt(rel[1])*60 : parseInt(rel[1]);
    const fut  = new Date(now.getTime() + mins*60000);
    const ft   = String(fut.getHours()).padStart(2,'0') + ':' + String(fut.getMinutes()).padStart(2,'0');
    const fd   = fut.getFullYear() + '-' + String(fut.getMonth()+1).padStart(2,'0') + '-' + String(fut.getDate()).padStart(2,'0');
    processed  = msg.replace(rel[0], 'الساعة ' + ft);
    if (fd !== today) processed += ' تاريخ ' + fd;
  }

  const prompt =
    'معلومات الوقت الآن بتوقيت الرياض:\n' +
    '- اليوم: ' + dayName + '\n' +
    '- التاريخ اليوم: ' + today + '\n' +
    '- تاريخ الغد: ' + tomorrow + '\n' +
    '- الوقت الحالي: ' + cur + '\n\n' +
    'استخرج معلومات المهمة وأعد JSON فقط:\n' +
    '{"title":"","type":"task او meeting او reminder","date":"YYYY-MM-DD او null","time":"HH:MM او null","note":""}\n\n' +
    'قواعد:\n' +
    '- اجتماع/لقاء/مقابلة = meeting\n' +
    '- تذكير/ذكرني = reminder\n' +
    '- غير ذلك = task\n' +
    '- اليوم = ' + today + '\n' +
    '- بكرة/غداً/الغد = ' + tomorrow + '\n' +
    '- الساعة 3 العصر = 15:00\n' +
    '- الساعة 3 الصبح = 03:00\n' +
    '- بدون تاريخ = null, بدون وقت = null\n\n' +
    'الرسالة: "' + processed + '"';

  return callAIJson('claude-haiku-4-5-20251001', 300, prompt);
}

// ─── Analyze Owner ────────────────────────────────────────────────────────
async function analyzeOwner(msg, context) {
  const today = todayStr();
  const cur   = nowTime();
  const prompt =
    'أنت محلل ذكي لرسائل عبدالعزيز. أعد JSON فقط.\n' +
    'السياق:\n' + context + '\n' +
    'الوقت: ' + cur + ' التاريخ: ' + today + '\n' +
    'الرسالة: "' + msg + '"\n\n' +
    'أعد:\n' +
    '{"action":"approve|reject|approve_name|reject_name|remind_visitor|send_message|add_task|add_meeting|add_reminder|show_today|show_tomorrow|show_week|show_tasks|done|postpone|delete|edit|search|busy|back|remember|recall|add_relation|recall_relation|add_slot|show_slots|help|chat|unknown",' +
    '"target_name":null,"message_to_send":null,"task_title":null,"date":null,"time":null,' +
    '"memory_key":null,"memory_value":null,"relation_name":null,"relation_info":null,"note":null,' +
    '"confidence":"high|medium|low"}\n\n' +
    'قواعد:\n' +
    '- اعتمد/موافق/تمام/اوكي = approve\n' +
    '- ارفض/لا/مرفوض = reject\n' +
    '- قبول [اسم] = approve_name\n' +
    '- رفض [اسم] = reject_name\n' +
    '- ذكره/ذكر بعد X = remind_visitor\n' +
    '- ارسل لـ[شخص] = send_message\n' +
    '- مشغول/في اجتماع = busy\n' +
    '- رجعت/خلصت = back\n' +
    '- تذكر/غيرت/اشتريت = remember\n' +
    '- متى آخر/كم صار = recall\n' +
    '- اضف [اسم] [معلومات] = add_relation\n' +
    '- وش عندي عن [اسم] = recall_relation\n' +
    '- اضف موعد متاح = add_slot\n' +
    '- وش مواعيدي المتاحة = show_slots\n' +
    '- بعد X دقيقة/ساعة = احسب الوقت من ' + cur + '\n' +
    '- مهمة/اجتماع/تذكير جديد = add_task/add_meeting/add_reminder\n' +
    '- كلام عادي/سؤال/مشكلة/أي شيء ثاني = chat\n' +
    '- مهم: إذا ما تأكدت من الأمر اختر chat وليس unknown\n' +
    '- unknown فقط للرسائل الفارغة أو غير المفهومة كلياً';
  return callAIJson('claude-sonnet-4-20250514', 400, prompt);
}

// ─── Nawaf Owner Reply ────────────────────────────────────────────────────
async function nawafOwnerReply(msg, context) {
  const ownerL  = await getLessons('owner_lessons');
  const nawafL  = await getLessons('nawaf_lessons');
  const lessons = [ownerL, nawafL].filter(Boolean).join('\n');
  const prompt =
    'أنت "نواف" المساعد الشخصي لعبدالعزيز.\n' +
    'أنت ذكي جداً مثل Claude AI — تعرف الطب، التقنية، السيارات، التاريخ، العلوم، القانون، الدين، الاقتصاد، وأي موضوع.\n' +
    'تتكلم بعامية سعودية طبيعية، مباشر وواضح.\n\n' +
    'قواعد ذهبية:\n' +
    '1. لا تقول أبداً "وضح أكثر" أو "ما فهمت" — دائماً اجتهد وأجب بأفضل فهم للرسالة\n' +
    '2. لو الرسالة قصيرة أو غامضة، افترض السياق الأكثر منطقية وأجب\n' +
    '3. أجوبتك عملية ومفيدة — مو نظرية فارغة\n' +
    '4. لو سؤال طبي: أعط معلومات حقيقية مع نصيحة زيارة طبيب إذا لزم\n' +
    '5. لو مشكلة تقنية: اشرح السبب والحل خطوة بخطوة\n' +
    '6. لو سؤال عام: أجب مباشرة بمعلومات دقيقة\n' +
    '7. لا ترسل إشعارات أو تبلغ عن أي شيء حفظته\n\n' +
    'السياق الحالي:\n' + context + '\n\n' +
    (lessons ? 'دروس تعلمتها عن عبدالعزيز:\n' + lessons + '\n\n' : '') +
    'عبدالعزيز: ' + msg + '\n\n' +
    'رد مباشر ومفيد بدون مقدمات. إذا سؤال معقد قدم معلومات وافية.';
  return callAI('claude-sonnet-4-20250514', 800, prompt);
}

// ─── Nawaf Visitor Reply ──────────────────────────────────────────────────
async function nawafVisitorReply(visitorName, msg, history) {
  const visitorL = await getLessons('visitor_lessons');
  const nawafL   = await getLessons('nawaf_lessons');
  const lessons  = [visitorL, nawafL].filter(Boolean).join('\n');
  const histText = history.slice(-6).map(function(h) {
    return (h.role==='visitor' ? visitorName : 'نواف') + ': ' + h.msg;
  }).join('\n');
  const prompt =
    'أنت "نواف" المساعد الشخصي لعبدالعزيز على واتساب.\n' +
    'شخصيتك: خليجي ودي، دافئ، عامية سعودية.\n' +
    'مهمتك: مساعدة الزوار في التواصل مع عبدالعزيز.\n' +
    (lessons ? 'دروس من محادثات سابقة:\n' + lessons + '\n\n' : '') +
    'سجل المحادثة:\n' + histText + '\n\n' +
    visitorName + ': ' + msg + '\n\n' +
    'رد قصير وطبيعي (جملة أو جملتين). إذا طلب محدد قل "تمام، أرسل التفاصيل".';
  return callAI('claude-haiku-4-5-20251001', 300, prompt);
}

// ─── Analyze Visitor ──────────────────────────────────────────────────────
async function analyzeVisitor(msg, context) {
  const today = todayStr();
  const prompt =
    'أنت محلل رسائل ذكي. أعد JSON فقط.\n' +
    'السياق: ' + context + '\nاليوم: ' + today + '\nالرسالة: "' + msg + '"\n\n' +
    'أعد:\n' +
    '{"intent":"name|greeting|task_request|meeting_request|reminder_for_owner|reminder_for_self|update_request|cancel_request|chat|number_choice|unknown",' +
    '"name":null,"choice":null,"task_title":null,"date":null,"time":null,"confidence":"high|medium|low"}\n\n' +
    'قواعد:\n' +
    '- name: اسم شخص حقيقي فقط (كلمة أو كلمتين، بدون أرقام أو جمل)\n' +
    '- number_choice: رقم 1-4 فقط\n' +
    '- greeting: تحية\n' +
    '- update_request: الغيت أو تغير الموعد أو ما بقدر\n' +
    '- cancel_request: الغي طلبي أو ما أبغى\n' +
    '- reminder_for_owner: ذكره أو تذكير لعبدالعزيز\n' +
    '- reminder_for_self: ذكرني\n' +
    '- meeting_request: طلب اجتماع أو لقاء\n' +
    '- task_request: طلب شيء من عبدالعزيز\n' +
    '- task_title: انسخ الطلب كما قاله بدون تعديل';
  return callAIJson('claude-haiku-4-5-20251001', 300, prompt);
}

// ─── Busy Mode ────────────────────────────────────────────────────────────
async function isBusy() {
  try { const r = await pool.query("SELECT value FROM settings WHERE key='busy_mode'"); return r.rows[0]?.value==='true'; } catch(e) { return false; }
}
async function setBusy(val) {
  await pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',['busy_mode', val?'true':'false']);
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

function buildConfirmMsg(type, title, date, time) {
  const tLabel = type==='meeting'?'اجتماع':type==='reminder'?'تذكير':'مهمة/طلب';
  const tIcon  = type==='meeting'?'📅':type==='reminder'?'🔔':'📌';
  let msg = tIcon + ' *تأكيد طلبك:*\n\n';
  msg += '📋 النوع: ' + tLabel + '\n';
  msg += '📝 الموضوع: ' + title + '\n';
  if (date) msg += '📅 التاريخ: ' + date + '\n';
  if (time) msg += '⏰ الوقت: ' + fmt12(time) + '\n';
  msg += '\nهل تؤكد هذا الطلب؟\n\n✅ أرسل *نعم* للتأكيد\n❌ أرسل *لا* للإلغاء';
  return msg;
}

function welcomeMsg() {
  return greeting() + ' 👋\nهلا وغلا! أنا المساعد الشخصي لعبدالعزيز ✨\n\nأقدر أساعدك في:\n📌 تسجيل مهمة أو طلب له\n📅 جدولة اجتماع معه\n🔔 تذكيره بشيء أو تذكيرك أنت\n\nممكن تشرّفني باسمك؟ 😊';
}

function menuMsg(name) {
  return 'هلا ' + name + '! 😊\nوش أقدر أساعدك فيه؟\n\n1️⃣ تسجيل مهمة أو طلب\n2️⃣ جدولة اجتماع\n3️⃣ تذكير عبدالعزيز\n4️⃣ تذكيرك أنت\n\nأرسل الرقم أو اكتب مباشرة 👇';
}

// ─── Cron: طلبات لم تُؤكد بعد ساعة ──────────────────────────────────────
cron.schedule('*/5 * * * *', async function() {
  try {
    const hourAgo = new Date(Date.now() - 60*60000).toISOString();
    const res = await pool.query("SELECT * FROM tasks WHERE status='awaiting_visitor_confirm' AND created_at<=$1",[hourAgo]);
    for (const t of res.rows) {
      if (!sentReminders.has('pconf_' + t.id)) {
        sentReminders.add('pconf_' + t.id);
        await pool.query("UPDATE tasks SET status='pending' WHERE id=$1",[t.id]);
        await sendWA(PHONE,
          '⏳ *طلب لم يُؤكد بعد ساعة*\n\n' +
          '👤 ' + t.requested_by_name + '\n' +
          '📌 ' + t.title +
          (t.date?'\n📅 '+t.date:'') +
          (t.time?'\n⏰ '+fmt12(t.time):'') +
          '\n\nرد بـ *قبول ' + t.requested_by_name + '* أو *رفض ' + t.requested_by_name + '*'
        );
      }
    }
  } catch(e) { console.error('Confirm cron:', e.message); }
}, { timezone: 'Asia/Riyadh' });

// ─── Cron: تذكيرات كل 10 ثواني ───────────────────────────────────────────
cron.schedule('*/10 * * * * *', async function() {
  const today = todayStr();
  const now   = new Date();
  const cur   = nowTime();

  try {
    const res = await pool.query('SELECT * FROM tasks WHERE done=false AND reminded=false AND date=$1 AND time=$2',[today,cur]);
    for (const t of res.rows) {
      await pool.query('UPDATE tasks SET reminded=true WHERE id=$1',[t.id]);
      await sendWA(PHONE, buildTaskMsg(t));
      console.log('📤 تذكير:', t.title, cur);
    }
  } catch(e) { console.error('Cron:', e.message); }

  try {
    const f15  = new Date(now.getTime() + 15*60000);
    const pre  = String(f15.getHours()).padStart(2,'0') + ':' + String(f15.getMinutes()).padStart(2,'0');
    const res  = await pool.query('SELECT * FROM tasks WHERE done=false AND reminded_pre=false AND date=$1 AND time=$2',[today,pre]);
    for (const t of res.rows) {
      await pool.query('UPDATE tasks SET reminded_pre=true WHERE id=$1',[t.id]);
      let msg = '⏰ *تذكير مسبق — بعد 15 دقيقة*\n\n📌 *' + t.title + '*\n🕐 ' + fmt12(t.time) + '\n';
      if (t.note) msg += '📝 ' + t.note + '\n';
      if (t.location) msg += '📍 ' + t.location + '\n';
      msg += '\n_مهامي_ ✨';
      await sendWA(PHONE, msg);
    }
  } catch(e) { console.error('Pre15:', e.message); }

  try {
    const f60  = new Date(now.getTime() + 60*60000);
    const p60  = String(f60.getHours()).padStart(2,'0') + ':' + String(f60.getMinutes()).padStart(2,'0');
    const res  = await pool.query("SELECT * FROM tasks WHERE done=false AND type='meeting' AND date=$1 AND time=$2",[today,p60]);
    for (const t of res.rows) {
      if (!sentReminders.has('mtg60_'+t.id)) {
        sentReminders.add('mtg60_'+t.id);
        let msg = '📅 *تأكيد اجتماع — بعد ساعة*\n\n📌 *' + t.title + '*\n⏰ ' + fmt12(t.time) + '\n';
        if (t.location) msg += '📍 ' + t.location + '\n';
        msg += '\nاستعد 💼\n_مهامي_ ✨';
        await sendWA(PHONE, msg);
      }
    }
  } catch(e) { console.error('Mtg60:', e.message); }

  try {
    const res = await pool.query("SELECT * FROM tasks WHERE status='approved' AND requested_by!='' AND reminded=false AND date=$1 AND time=$2",[today,cur]);
    for (const t of res.rows) {
      await pool.query('UPDATE tasks SET reminded=true WHERE id=$1',[t.id]);
      await sendWA(t.requested_by, '🔔 تذكيرك: *' + t.title + '*\n_من نواف_ ✨');
      await sendWA(PHONE, '📬 تم تذكير *' + t.requested_by_name + '* بـ "' + t.title + '" ✅');
    }
  } catch(e) { console.error('VReminder:', e.message); }

}, { timezone: 'Asia/Riyadh' });

// ─── Cron: ملخص صباحي 8 ص ────────────────────────────────────────────────
cron.schedule('0 8 * * *', async function() {
  const today = todayStr();
  try {
    const res  = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time',[today]);
    const over = await pool.query('SELECT * FROM tasks WHERE done=false AND date<$1 ORDER BY date,time',[today]);
    let msg = '🌅 *صباح الخير عبدالعزيز*\n📅 ' +
      new Date().toLocaleDateString('ar-SA',{weekday:'long',day:'numeric',month:'long',timeZone:'Asia/Riyadh'}) +
      '\n─────────────\n\n';
    if (!res.rows.length) {
      msg += '✨ ما عندك مهام اليوم — يوم خفيف!\n';
    } else {
      msg += '📋 *مهام اليوم (' + res.rows.length + '):*\n\n';
      res.rows.forEach(function(t,i) {
        const icon = t.type==='meeting'?'📅':t.type==='reminder'?'🔔':'✅';
        msg += (i+1) + '. ' + icon + ' *' + t.title + '*' +
          (t.time?' — '+fmt12(t.time):'') +
          (t.requested_by_name?' (من '+t.requested_by_name+')':'') + '\n';
        if (t.location) msg += '   📍 ' + t.location + '\n';
      });
    }
    if (over.rows.length) {
      msg += '\n⚠️ *متأخرة (' + over.rows.length + '):*\n';
      over.rows.slice(0,3).forEach(function(t) { msg += '• ' + t.title + ' — ' + t.date + '\n'; });
    }
    msg += '\n_مهامي_ ✨ — يوم موفق!';
    await sendWA(PHONE, msg);
  } catch(e) { console.error('Morning:', e.message); }
}, { timezone: 'Asia/Riyadh' });

// ─── Cron: تقرير أسبوعي جمعة 5 م ────────────────────────────────────────
cron.schedule('0 17 * * 5', async function() {
  try {
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate()-7);
    const wa    = weekAgo.getFullYear() + '-' + String(weekAgo.getMonth()+1).padStart(2,'0') + '-' + String(weekAgo.getDate()).padStart(2,'0');
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
    // تعلم أسبوعي شامل في الخلفية
    const recent = await pool.query("SELECT * FROM tasks WHERE requested_by!='' AND created_at>=$1 ORDER BY created_at DESC LIMIT 30",[wa]);
    if (recent.rows.length > 0) {
      const summary = recent.rows.map(function(t) {
        return t.requested_by_name + ': "' + t.title + '" (' + t.status + ')';
      }).join('\n');
      setImmediate(function() { learnFromVisitor('تحليل أسبوعي', [{role:'visitor',msg:summary}], 'تحليل أسبوعي'); });
      setImmediate(async function() {
        try {
          const cur = await getLessons('nawaf_lessons');
          const p = 'أنت مدرب يطور نواف.\nالدروس الحالية:\n' + (cur||'لا يوجد') + '\n\nملخص الأسبوع:\n' + summary + '\n\nاستخرج دروساً عامة (حد أقصى 15)، كل درس سطر يبدأ بـ نقطة';
          const r = await callAI('claude-sonnet-4-20250514', 300, p);
          if (r) await saveLessons('nawaf_lessons', r);
        } catch(e) {}
      });
    }
  } catch(e) { console.error('Weekly:', e.message); }
}, { timezone: 'Asia/Riyadh' });

// ─── Webhook ───────────────────────────────────────────────────────────────
app.post('/webhook', async function(req, res) {
  res.sendStatus(200);
  const body = req.body;
  if (body && body.typeWebhook !== 'incomingMessageReceived') return;
  // قراءة النص من كل أنواع الرسائل
  let msg = null;
  const md = body && body.messageData;
  if (md) {
    // رسالة نصية عادية
    if (md.textMessageData && md.textMessageData.textMessage) {
      msg = md.textMessageData.textMessage.trim();
    }
    // رسالة منشن أو رسالة بها رابط أو forward
    else if (md.extendedTextMessageData && md.extendedTextMessageData.text) {
      msg = md.extendedTextMessageData.text.trim();
    }
    // رسالة رد على رسالة (quoted)
    else if (md.quotedMessage && md.quotedMessage.textMessage) {
      msg = md.quotedMessage.textMessage.trim();
    }
  }
  const from = body && body.senderData && body.senderData.chatId && body.senderData.chatId.replace('@c.us','');
  if (!msg || !from) return;
  console.log('📩', from, '—', msg.substring(0,50));
  if (from === PHONE)      { await handleOwner(from, msg);   return; }
  if (from === WIFE_PHONE) { await handleWife(from, msg);    return; }
  await handleVisitor(from, msg);
});

// ─── Handle Owner ─────────────────────────────────────────────────────────
async function handleOwner(from, msg) {
  const state = userState[from] || { step: 'idle' };
  if (state.step !== 'idle') { await handleOwnerState(from, msg, state); return; }

  let context = '';
  try {
    const pr = await pool.query("SELECT * FROM tasks WHERE status IN ('pending','awaiting_visitor_confirm') AND requested_by!='' ORDER BY created_at DESC LIMIT 3");
    const td = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time LIMIT 5',[todayStr()]);
    if (pr.rows.length) {
      context += 'طلبات معلقة:\n';
      pr.rows.forEach(function(t) { context += '- ' + t.requested_by_name + ': "' + t.title + '" (' + t.type + ')' + (t.time?' '+fmt12(t.time):'') + '\n'; });
    }
    if (td.rows.length) {
      context += '\nمهام اليوم:\n';
      td.rows.forEach(function(t) { context += '- ' + t.title + (t.time?' — '+fmt12(t.time):'') + '\n'; });
    }
    if (!context) context = 'لا يوجد طلبات أو مهام';
  } catch(e) {}

  const analysis = await analyzeOwner(msg, context);
  if (!analysis) { await sendWA(from, '❓ ما فهمت، جرب مرة ثانية'); return; }
  console.log('🧠 owner action:', analysis.action);

  switch(analysis.action) {

    case 'approve': {
      const r = await pool.query("SELECT * FROM tasks WHERE status IN ('pending','awaiting_visitor_confirm') AND requested_by!='' ORDER BY created_at DESC LIMIT 1");
      if (r.rows.length) {
        const t = r.rows[0]; const vn = t.requested_by_name;
        await pool.query("UPDATE tasks SET status='approved' WHERE id=$1",[t.id]);
        await sendWA(t.requested_by, 'هلا ' + vn + ' 👋\nعبدالعزيز اعتمد طلبك ✅\n📌 ' + t.title + (t.date?'\n📅 '+t.date:'') + (t.time?'\n⏰ '+fmt12(t.time):''));
        await sendWA(from, '✅ تم اعتماد طلب ' + vn + ' وإبلاغه');
        setImmediate(function() { learnFromOwner('اعتمد طلب', 'نوع: ' + t.type + ' عنوان: ' + t.title, msg); });
      } else { await sendWA(from, '❓ ما في طلبات معلقة'); }
      break;
    }

    case 'reject': {
      const r = await pool.query("SELECT * FROM tasks WHERE status IN ('pending','awaiting_visitor_confirm') AND requested_by!='' ORDER BY created_at DESC LIMIT 1");
      if (r.rows.length) {
        const t = r.rows[0]; const vn = t.requested_by_name;
        await pool.query("UPDATE tasks SET status='rejected' WHERE id=$1",[t.id]);
        await sendWA(t.requested_by, 'هلا ' + vn + ' 👋\nاعتذر، عبدالعزيز غير قادر ❌\nلو تبغى وقت ثاني أنا هنا 😊');
        await sendWA(from, '❌ تم رفض طلب ' + vn + ' وإبلاغه');
        setImmediate(function() { learnFromOwner('رفض طلب', 'نوع: ' + t.type + ' عنوان: ' + t.title, msg); });
      } else { await sendWA(from, '❓ ما في طلبات معلقة'); }
      break;
    }

    case 'approve_name': {
      const vn = analysis.target_name;
      const r  = await pool.query("SELECT * FROM tasks WHERE requested_by_name=$1 AND status IN ('pending','awaiting_visitor_confirm') ORDER BY created_at DESC LIMIT 1",[vn]);
      if (r.rows.length) {
        const t = r.rows[0];
        await pool.query("UPDATE tasks SET status='approved' WHERE id=$1",[t.id]);
        await sendWA(t.requested_by, 'هلا ' + vn + ' 👋\nعبدالعزيز اعتمد طلبك ✅\n📌 ' + t.title + (t.date?'\n📅 '+t.date:'') + (t.time?'\n⏰ '+fmt12(t.time):''));
        await sendWA(from, '✅ تم قبول طلب ' + vn);
      } else { await sendWA(from, '❓ ما لقيت طلب من ' + vn); }
      break;
    }

    case 'reject_name': {
      const vn = analysis.target_name;
      const r  = await pool.query("SELECT * FROM tasks WHERE requested_by_name=$1 AND status IN ('pending','awaiting_visitor_confirm') ORDER BY created_at DESC LIMIT 1",[vn]);
      if (r.rows.length) {
        const t = r.rows[0];
        await pool.query("UPDATE tasks SET status='rejected' WHERE id=$1",[t.id]);
        await sendWA(t.requested_by, 'هلا ' + vn + ' 👋\nاعتذر، عبدالعزيز غير قادر ❌\nلو تبغى وقت ثاني أنا هنا 😊');
        await sendWA(from, '❌ تم رفض طلب ' + vn);
      } else { await sendWA(from, '❓ ما لقيت طلب من ' + vn); }
      break;
    }

    case 'remind_visitor': {
      const r = await pool.query("SELECT * FROM tasks WHERE requested_by!='' AND status IN ('pending','awaiting_visitor_confirm') ORDER BY created_at DESC LIMIT 1");
      if (r.rows.length) {
        const t    = r.rows[0];
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
      let targetPhone = null;
      let targetName  = analysis.target_name || '';
      if (targetName.includes('زوج')) {
        targetPhone = WIFE_PHONE; targetName = 'الزوجة';
      } else {
        const last = await pool.query("SELECT * FROM tasks WHERE requested_by!='' AND status IN ('pending','awaiting_visitor_confirm') ORDER BY created_at DESC LIMIT 1");
        if (last.rows.length) { targetPhone = last.rows[0].requested_by; targetName = last.rows[0].requested_by_name; }
      }
      if (targetPhone) { await sendWA(targetPhone, msgToSend); await sendWA(from, '✅ تم الإرسال لـ ' + targetName); }
      else { await sendWA(from, '❓ ما عرفت لمن أرسل'); }
      break;
    }

    case 'busy': {
      await setBusy(true);
      await sendWA(from, '🔕 تم تفعيل وضع الغياب');
      setImmediate(function() { learnFromOwner('فعّل وضع الغياب', 'الوقت: ' + nowTime(), msg); });
      break;
    }

    case 'back': {
      await setBusy(false);
      const cur = nowTime();
      const r   = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 AND time>$2 ORDER BY time',[todayStr(),cur]);
      if (!r.rows.length) {
        await sendWA(from, '✅ تم إيقاف وضع الغياب\n\nما في مهام باقية اليوم 🎉');
      } else {
        let reply = '✅ تم إيقاف وضع الغياب\n\nباقي اليوم:\n\n';
        r.rows.forEach(function(t,i) {
          reply += (i+1) + '. ' + (t.type==='meeting'?'📅':t.type==='reminder'?'🔔':'✅') + ' *' + t.title + '*' + (t.time?' — '+fmt12(t.time):'') + '\n';
        });
        await sendWA(from, reply);
      }
      break;
    }

    case 'remember': {
      const key   = analysis.memory_key || analysis.task_title;
      const value = analysis.memory_value || new Date().toLocaleDateString('ar-SA',{timeZone:'Asia/Riyadh'});
      if (key && key.length > 1 && !['?','؟','.','!'].includes(key)) {
        await rememberFact(key, value);
        // صامت - بدون إشعار
      } else { await sendWA(from, '❓ وش تبيني أتذكر؟'); }
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
      if (name && info) {
        await pool.query('INSERT INTO relations (name,info) VALUES ($1,$2)',[name,info]);
        await rememberFact('relation_' + name, info);
        // صامت - بدون إشعار
      } else if (name) {
        await rememberFact('relation_' + name, name);
      }
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
        r.rows.forEach(function(s,i) { list += (i+1) + '. ' + s.slot_date + ' — ' + fmt12(s.slot_time) + '\n'; });
        await sendWA(from, list);
      }
      break;
    }

    case 'show_today': {
      const r = await pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time',[todayStr()]);
      if (!r.rows.length) { await sendWA(from, '📋 ما عندك مهام اليوم ✅'); break; }
      let list = '📅 *مهام اليوم (' + r.rows.length + '):*\n\n';
      r.rows.forEach(function(t,i) { list += (i+1) + '. ' + (t.type==='meeting'?'📅':t.type==='reminder'?'🔔':'✅') + ' *' + t.title + '*' + (t.time?' — '+fmt12(t.time):'') + '\n'; });
      await sendWA(from, list);
      break;
    }

    case 'show_tasks': {
      const r = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
      if (!r.rows.length) { await sendWA(from, '📋 لا توجد مهام ✅'); break; }
      let list = '📋 *مهامك المعلقة:*\n\n';
      r.rows.forEach(function(t,i) {
        list += (i+1) + '. ' + (t.type==='meeting'?'📅':t.type==='reminder'?'🔔':'✅') + ' *' + t.title + '*' +
          (t.time?'\n   ⏰ '+fmt12(t.time):'') + ' — ' + (t.date||'بدون تاريخ') +
          (t.requested_by_name?' (من '+t.requested_by_name+')':'') + '\n\n';
      });
      await sendWA(from, list);
      break;
    }

    case 'done': {
      const r = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
      if (!r.rows.length) { await sendWA(from, '📋 لا توجد مهام ✅'); break; }
      if (r.rows.length === 1) {
        await pool.query('UPDATE tasks SET done=true WHERE id=$1',[r.rows[0].id]);
        await sendWA(from, '✅ *' + r.rows[0].title + '* تم إنجازها 🎉'); break;
      }
      let list = '✅ *أي مهمة أنجزت؟*\n\n';
      r.rows.forEach(function(t,i) { list += (i+1) + '. *' + t.title + '*' + (t.time?' — '+fmt12(t.time):'') + '\n'; });
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
        await sendWA(from, '⏰ تم تأجيل *' + t.title + '* لـ ' + fmt12(nt)); break;
      }
      let list = '⏰ *أي مهمة تريد تأجيلها؟*\n\n';
      r.rows.forEach(function(t,i) { list += (i+1) + '. *' + t.title + '*' + (t.time?' — '+fmt12(t.time):'') + '\n'; });
      await sendWA(from, list + '\nأرسل الرقم');
      userState[from] = { step: 'waiting_postpone_selection', tasks: r.rows };
      break;
    }

    case 'delete': {
      const r = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
      if (!r.rows.length) { await sendWA(from, '📋 لا توجد مهام ✅'); break; }
      if (r.rows.length === 1) {
        await pool.query('DELETE FROM tasks WHERE id=$1',[r.rows[0].id]);
        await sendWA(from, '🗑️ تم حذف *' + r.rows[0].title + '*'); break;
      }
      let list = '🗑️ *أي مهمة تريد حذفها؟*\n\n';
      r.rows.forEach(function(t,i) { list += (i+1) + '. *' + t.title + '*' + (t.date?' — '+t.date:'') + '\n'; });
      await sendWA(from, list + '\nأرسل الرقم');
      userState[from] = { step: 'waiting_delete_selection', tasks: r.rows };
      break;
    }

    case 'edit': {
      const r = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date,time LIMIT 10');
      if (!r.rows.length) { await sendWA(from, '📋 لا توجد مهام ✅'); break; }
      if (r.rows.length === 1) {
        const t = r.rows[0];
        userState[from] = { step: 'waiting_edit_field', task: t };
        await sendWA(from, '✏️ *تعديل: ' + t.title + '*\n\n1. العنوان\n2. الوقت\n3. التاريخ\n4. الملاحظة' + (t.type==='meeting'?'\n5. الموقع':'') + '\n\nأرسل الرقم'); break;
      }
      let list = '✏️ *أي مهمة تريد تعديلها؟*\n\n';
      r.rows.forEach(function(t,i) { list += (i+1) + '. *' + t.title + '*\n'; });
      await sendWA(from, list + '\nأرسل الرقم');
      userState[from] = { step: 'waiting_edit_selection', tasks: r.rows };
      break;
    }

    case 'add_task':
    case 'add_meeting':
    case 'add_reminder': {
      const type  = analysis.action==='add_meeting'?'meeting':analysis.action==='add_reminder'?'reminder':'task';
      const title = analysis.task_title || msg;
      if (analysis.date && analysis.time) {
        if (type === 'meeting') {
          userState[from] = { step: 'waiting_location', taskTitle: title, taskType: 'meeting', taskNote: analysis.note||'', date: analysis.date, time: analysis.time };
          await sendWA(from, '📍 أين موقع الاجتماع؟\nأو أرسل *تخطي*');
        } else {
          const id = Date.now();
          await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location) VALUES ($1,$2,$3,$4,$5,$6,$7)',[id,title,type,analysis.date,analysis.time,analysis.note||'','']);
          await sendWA(from, '✅ تم التسجيل!\n📌 *' + title + '*\n⏰ ' + fmt12(analysis.time) + '\n📅 ' + analysis.date);
          setImmediate(function() { learnFromOwner('أضاف ' + type, title, msg); });
        }
      } else {
        userState[from] = { step: 'waiting_datetime', taskTitle: title, taskType: type, taskNote: analysis.note||'' };
        await sendWA(from, '📌 *' + title + '*\n\n❓ متى وفي أي وقت؟');
      }
      break;
    }

    case 'help': {
      await sendWA(from,
        '📖 *نواف يفهمك مباشرة!*\n\n' +
        'أمثلة:\n' +
        '• "اجتماع مع الفريق بكرة 3 العصر"\n' +
        '• "اعتمد" / "ارفض"\n' +
        '• "ذكّره بعد ساعة"\n' +
        '• "مشغول" / "رجعت"\n' +
        '• "تذكر إني غيرت زيت السيارة"\n' +
        '• "أضف موعد متاح بكرة 3"\n' +
        '• أي سؤال في أي موضوع 😊\n\n' +
        '_مهامي_ ✨'
      );
      break;
    }

    case 'unknown':
    default: {
      const reply = await nawafOwnerReply(msg, context);
      if (reply) { await sendWA(from, reply); }
      else { await sendWA(from, '❓ ما قدرت أعالج طلبك، جرب مرة ثانية'); }
      break;
    }
  }
}

// ─── Handle Owner State ───────────────────────────────────────────────────
async function handleOwnerState(from, msg, state) {
  if (state.step === 'waiting_remind_visitor_time') {
    const p = await parseTask('تذكير في ' + msg);
    if (p && p.time) {
      await pool.query('UPDATE tasks SET status=$1,time=$2,date=$3,reminded=false WHERE id=$4',['approved',p.time,p.date||todayStr(),state.taskId]);
      await sendWA(from, '✅ سأذكّر ' + state.visitorName + ' الساعة ' + fmt12(p.time));
    } else { await sendWA(from, '❓ متى؟ مثال: "بعد ساعة"'); return; }
    userState[from] = { step: 'idle' }; return;
  }

  if (state.step === 'waiting_add_slot') {
    const p = await parseTask('موعد ' + msg);
    if (p && p.time) {
      await pool.query('INSERT INTO available_slots (slot_date,slot_time) VALUES ($1,$2)',[p.date||state.date||todayStr(),p.time]);
      await sendWA(from, '✅ أضفت موعد متاح: ' + fmt12(p.time));
    } else { await sendWA(from, '❓ لم أفهم الوقت'); return; }
    userState[from] = { step: 'idle' }; return;
  }

  if (state.step === 'waiting_datetime') {
    const cancelWords = ['لا','الغ','الغي','احذف','حذف','ما أبغى','وقف','إلغاء'];
    if (cancelWords.some(function(w) { return msg.includes(w); })) {
      await sendWA(from, '✅ تم إلغاء الإضافة');
      userState[from] = { step: 'idle' }; return;
    }
    const p = await parseTask(state.taskTitle + ' ' + msg);
    if (p && p.date && p.time) {
      if (state.taskType === 'meeting') {
        userState[from] = Object.assign({}, state, { step: 'waiting_location', date: p.date, time: p.time });
        await sendWA(from, '📍 أين موقع الاجتماع؟\nأو أرسل *تخطي*');
      } else {
        const id = Date.now();
        await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location) VALUES ($1,$2,$3,$4,$5,$6,$7)',[id,state.taskTitle,state.taskType||'task',p.date,p.time,state.taskNote||'','']);
        await sendWA(from, '✅ تم التسجيل!\n📌 *' + state.taskTitle + '*\n⏰ ' + fmt12(p.time) + '\n📅 ' + p.date);
        userState[from] = { step: 'idle' };
      }
    } else {
      await sendWA(from, '❓ لم أفهم الوقت.\n\nمثال: "غداً الساعة 3 العصر"\n\nأو أرسل *الغي* لإلغاء الإضافة');
    }
    return;
  }

  if (state.step === 'waiting_location') {
    const location = msg === 'تخطي' ? '' : msg;
    const id = Date.now();
    await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location) VALUES ($1,$2,$3,$4,$5,$6,$7)',[id,state.taskTitle,'meeting',state.date,state.time,state.taskNote||'',location]);
    let reply = '✅ تم تسجيل الاجتماع!\n📌 *' + state.taskTitle + '*\n⏰ ' + fmt12(state.time) + '\n📅 ' + state.date;
    if (location) reply += '\n📍 ' + location;
    await sendWA(from, reply);
    userState[from] = { step: 'idle' }; return;
  }

  if (state.step === 'waiting_done_selection') {
    const n = parseInt(msg);
    if (n >= 1 && n <= state.tasks.length) {
      await pool.query('UPDATE tasks SET done=true WHERE id=$1',[state.tasks[n-1].id]);
      await sendWA(from, '✅ *' + state.tasks[n-1].title + '* تم إنجازها 🎉');
      userState[from] = { step: 'idle' };
    } else { await sendWA(from, '❓ أرسل رقم من القائمة'); }
    return;
  }

  if (state.step === 'waiting_postpone_selection') {
    const n = parseInt(msg);
    if (n >= 1 && n <= state.tasks.length) {
      const t = state.tasks[n-1];
      if (!t.time) { await sendWA(from, '❓ هذه المهمة ما عندها وقت'); userState[from] = { step: 'idle' }; return; }
      const [h,m2] = t.time.split(':').map(Number);
      const d = new Date(); d.setHours(h+1,m2);
      const nt = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
      await pool.query('UPDATE tasks SET time=$1,reminded=false WHERE id=$2',[nt,t.id]);
      await sendWA(from, '⏰ تم تأجيل *' + t.title + '* لـ ' + fmt12(nt));
      userState[from] = { step: 'idle' };
    } else { await sendWA(from, '❓ أرسل رقم من القائمة'); }
    return;
  }

  if (state.step === 'waiting_delete_selection') {
    const n = parseInt(msg);
    if (n >= 1 && n <= state.tasks.length) {
      await pool.query('DELETE FROM tasks WHERE id=$1',[state.tasks[n-1].id]);
      await sendWA(from, '🗑️ تم حذف *' + state.tasks[n-1].title + '*');
      userState[from] = { step: 'idle' };
    } else { await sendWA(from, '❓ أرسل رقم من القائمة'); }
    return;
  }

  if (state.step === 'waiting_edit_selection') {
    const n = parseInt(msg);
    if (n >= 1 && n <= state.tasks.length) {
      const t = state.tasks[n-1];
      userState[from] = { step: 'waiting_edit_field', task: t };
      await sendWA(from, '✏️ *تعديل: ' + t.title + '*\n\n1. العنوان\n2. الوقت\n3. التاريخ\n4. الملاحظة' + (t.type==='meeting'?'\n5. الموقع':'') + '\n\nأرسل الرقم');
    } else { await sendWA(from, '❓ أرسل رقم من القائمة'); }
    return;
  }

  if (state.step === 'waiting_edit_field') {
    const n      = parseInt(msg);
    const fields = {1:'title',2:'time',3:'date',4:'note',5:'location'};
    const labels = {1:'العنوان الجديد',2:'الوقت الجديد',3:'التاريخ الجديد',4:'الملاحظة الجديدة',5:'الموقع الجديد'};
    if (fields[n]) {
      userState[from] = { step: 'waiting_edit_value', task: state.task, field: fields[n] };
      await sendWA(from, '✏️ أرسل ' + labels[n] + ':');
    } else { await sendWA(from, '❓ أرسل رقم صحيح'); }
    return;
  }

  if (state.step === 'waiting_edit_value') {
    const t     = state.task;
    const field = state.field;
    let nv      = msg;
    if (field === 'time' || field === 'date') {
      const p = await parseTask('مهمة ' + (field==='time'?msg:'في '+msg));
      if (field==='time' && p && p.time) nv = p.time;
      else if (field==='date' && p && p.date) nv = p.date;
      else { await sendWA(from, '❓ لم أفهم'); return; }
    }
    await pool.query('UPDATE tasks SET ' + field + '=$1 WHERE id=$2',[nv,t.id]);
    await sendWA(from, '✅ تم التعديل!');
    userState[from] = { step: 'idle' }; return;
  }

  userState[from] = { step: 'idle' };
  await handleOwner(from, msg);
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
    const prompt =
      'أنت "نواف" مساعد عبدالعزيز. هذه زوجته، تعاملها باحترام وود خاص.\n' +
      (memCtx ? 'معلومات مفيدة:\n' + memCtx + '\n' : '') +
      'رسالة الزوجة: "' + msg + '"\n\n' +
      'رد بشكل طبيعي ومفيد. إذا كان في الرسالة معلومة مهمة لعبدالعزيز أخبره بها.';
    const reply = await callAI('claude-sonnet-4-20250514', 400, prompt);
    if (reply) await sendWA(from, reply);
    const importantKw = ['طارئ','مهم','عاجل','مريض','مشكلة'];
    if (importantKw.some(function(k) { return msg.includes(k); })) {
      await sendWA(PHONE, '📱 *رسالة من الزوجة:*\n' + msg);
    }
  } catch(e) { console.error('Wife:', e.message); }
}

// ─── Handle Visitor ───────────────────────────────────────────────────────
async function handleVisitor(from, msg) {
  const state = userState[from] || { step: 'idle', history: [] };
  if (!state.history) state.history = [];

  let visitor = null;
  try { const r = await pool.query('SELECT * FROM visitors WHERE phone=$1',[from]); if (r.rows.length) visitor = r.rows[0]; } catch(e) {}
  const visitorName = (visitor && visitor.name) || state.visitorName || null;
  if (visitor) try { await pool.query('UPDATE visitors SET msg_count=msg_count+1,last_seen=NOW() WHERE phone=$1',[from]); } catch(e) {}

  // وضع الغياب
  const busy = await isBusy();
  if (busy && !sentReminders.has('busy_' + from + '_' + todayStr())) {
    sentReminders.add('busy_' + from + '_' + todayStr());
    const gr = visitorName ? 'هلا ' + visitorName + '! 👋\n' : 'هلا! 👋\n';
    await sendWA(from, gr + 'عبدالعزيز مشغول الحين بس أنا هنا لخدمتك');
  }

  // ─── states ───────────────────────────────────────────────────────────

  if (state.step === 'waiting_visitor_confirm') {
    const lower = msg.trim();
    const isYes = ['نعم','اي','أيوه','ايوه','yes','يس','اكيد','أكيد','تمام','موافق','صح','ايه'].some(function(w) { return lower.includes(w); });
    const isNo  = ['لا','لأ','no','كنسل','الغ','الغي','إلغاء','ما أبغى','ما ابغى'].some(function(w) { return lower.includes(w); });
    if (isYes) {
      const pt = state.pendingTask;
      const id = Date.now();
      if (pt.slotId) await pool.query('UPDATE available_slots SET is_booked=true WHERE id=$1',[pt.slotId]);
      await pool.query('INSERT INTO tasks (id,title,type,date,time,note,requested_by,requested_by_name,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,pt.title,pt.type,pt.date,pt.time,'',from,visitorName,'awaiting_visitor_confirm']);
      await pool.query('UPDATE visitors SET last_request=$1 WHERE phone=$2',[pt.title,from]);
      await sendWA(from, '✅ تم تسجيل طلبك!\nسأرفعه لعبدالعزيز الحين وأبلغك بقراره قريباً 😊');
      await sendWA(PHONE, buildRequestNotif(visitorName, from, pt.type, pt.title, pt.date, pt.time));
      setImmediate(function() { learnFromVisitor(visitorName, state.history, 'أكد: ' + pt.title); });
      userState[from] = { step: 'idle', history: state.history, visitorName };
    } else if (isNo) {
      await sendWA(from, '✅ تمام، تم إلغاء الطلب 😊\nلو تبغى تغير أي شيء أنا هنا!');
      setImmediate(function() { learnFromVisitor(visitorName, state.history, 'ألغى الطلب'); });
      userState[from] = { step: 'idle', history: state.history, visitorName };
    } else {
      await sendWA(from, 'أرسل *نعم* للتأكيد أو *لا* للإلغاء 😊');
    }
    return;
  }

  if (state.step === 'waiting_slot_choice') {
    const n = parseInt(msg.replace(/[^0-9]/g,''));
    if (n >= 1 && n <= (state.slots||[]).length) {
      const slot = state.slots[n-1];
      const topic = state.meetingTopic || 'اجتماع';
      userState[from] = { step: 'waiting_visitor_confirm', pendingTask: { title: topic, type: 'meeting', date: slot.slot_date, time: slot.slot_time, slotId: slot.id }, history: state.history, visitorName };
      await sendWA(from, buildConfirmMsg('meeting', topic, slot.slot_date, slot.slot_time));
    } else { await sendWA(from, '❓ اختر رقم من القائمة'); }
    return;
  }

  if (state.step === 'waiting_reminder_choice') {
    const isYes = ['1','١','أيوه','ايوه','نعم','اي','yes'].some(function(w) { return msg.includes(w); });
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

  if (state.step === 'waiting_visitor_reminder_time') {
    const p = await parseTask(msg);
    if (p && p.time) {
      const id   = Date.now();
      const date = p.date || todayStr();
      await pool.query('INSERT INTO tasks (id,title,type,date,time,note,requested_by,requested_by_name,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,state.reminderTitle,'reminder',date,p.time,'',from,visitorName,'approved']);
      await sendWA(from, '✅ سأذكّرك بـ "' + state.reminderTitle + '" في ' + fmt12(p.time) + ' 🔔');
      if (state.directReminder) await sendWA(PHONE, '📬 نواف سيذكّر ' + visitorName + ' بـ "' + state.reminderTitle + '" الساعة ' + fmt12(p.time));
      userState[from] = { step: 'idle', history: state.history, visitorName };
    } else { await sendWA(from, '❓ متى؟ مثال: "الساعة 3 العصر"'); }
    return;
  }

  if (state.step === 'waiting_visitor_reminder_topic') {
    userState[from] = { step: 'waiting_visitor_reminder_time', history: state.history, visitorName, reminderTitle: msg, directReminder: true };
    await sendWA(from, '⏰ متى تبغى أذكّرك؟\nمثال: "بكرة الساعة 10"'); return;
  }

  if (state.step === 'waiting_visitor_details') {
    const p     = await parseTask(msg);
    const title = (p && p.title) || msg;
    const date  = (p && p.date)  || null;
    const time  = (p && p.time)  || null;
    if (title && (date || time || state.requestType === 'task')) {
      userState[from] = { step: 'waiting_visitor_confirm', pendingTask: { title, type: state.requestType, date, time }, history: state.history, visitorName };
      await sendWA(from, buildConfirmMsg(state.requestType, title, date, time));
    } else {
      userState[from] = { step: 'waiting_visitor_time', requestType: state.requestType, requestTitle: title, history: state.history, visitorName };
      await sendWA(from, '📅 متى يناسبك؟ وش التاريخ والوقت؟\nمثال: "الأحد الساعة 10 الصبح"');
    }
    return;
  }

  if (state.step === 'waiting_visitor_time') {
    const p    = await parseTask(state.requestTitle + ' ' + msg);
    const date = (p && p.date) || null;
    const time = (p && p.time) || null;
    userState[from] = { step: 'waiting_visitor_confirm', pendingTask: { title: state.requestTitle, type: state.requestType, date, time }, history: state.history, visitorName };
    await sendWA(from, buildConfirmMsg(state.requestType, state.requestTitle, date, time));
    return;
  }

  // ─── تحليل الرسالة ────────────────────────────────────────────────────
  const context  = visitorName ? 'الزائر اسمه ' + visitorName + '، في محادثة مع نواف مساعد عبدالعزيز' : 'زائر جديد، سألناه عن اسمه';
  const analysis = await analyzeVisitor(msg, context) || { intent: 'unknown', confidence: 'low' };
  console.log('🧠 visitor intent:', analysis.intent, analysis.confidence);

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
      await sendWA(from, 'تمام، وصلني طلبك! 😊\nبس قبل ما أوصله — ممكن تشرّفني باسمك؟'); return;
    }
    if (analysis.intent === 'greeting') {
      await sendWA(from, (greeting()==='صباح الخير'?'صباح النور':'مساء النور') + '! 😊\nممكن تشرّفني باسمك؟'); return;
    }
    await sendWA(from, 'عذراً ما فهمت اسمك 😊\nممكن تكتب اسمك الكريم فقط؟'); return;
  }

  // ترحيب عائدين
  if (visitor && state.step === 'idle' && !state._welcomed) {
    const days = Math.floor((new Date()-new Date(visitor.last_seen))/(1000*60*60*24));
    if (days > 3) {
      userState[from] = Object.assign({}, state, { _welcomed: true });
      const lastReq = visitor.last_request ? ' آخر مرة طلبت "' + visitor.last_request + '"' : '';
      await sendWA(from, 'هلا ' + visitorName + '! 👋 زمان ما شفناك 😄' + lastReq + '\nوش تأمر اليوم؟');
      if (analysis.intent === 'greeting') return;
    }
  }

  // تحديث أو إلغاء
  if (analysis.intent === 'update_request' || analysis.intent === 'cancel_request') {
    try {
      const last = await pool.query("SELECT * FROM tasks WHERE requested_by=$1 AND status IN ('pending','awaiting_visitor_confirm') ORDER BY created_at DESC LIMIT 1",[from]);
      if (last.rows.length) {
        const t = last.rows[0];
        if (analysis.intent === 'cancel_request') {
          await pool.query("UPDATE tasks SET status='cancelled' WHERE id=$1",[t.id]);
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
    if (ch === 1) {
      userState[from] = { step: 'waiting_visitor_details', requestType: 'task', history: state.history, visitorName };
      await sendWA(from, '📌 أخبرني بتفاصيل الطلب والوقت المناسب 👇');
    } else if (ch === 2) {
      const slots = await pool.query('SELECT * FROM available_slots WHERE slot_date>=$1 AND is_booked=false ORDER BY slot_date,slot_time LIMIT 5',[todayStr()]).catch(function() { return {rows:[]}; });
      if (slots.rows.length) {
        let sm = '📅 الأوقات المتاحة لعبدالعزيز:\n\n';
        slots.rows.forEach(function(s,i) { sm += (i+1) + ' - ' + s.slot_date + ' — ' + fmt12(s.slot_time) + '\n'; });
        sm += '\nاختر رقم الموعد المناسب 👇';
        userState[from] = { step: 'waiting_slot_choice', slots: slots.rows, history: state.history, visitorName, meetingTopic: null };
        await sendWA(from, sm);
      } else {
        userState[from] = { step: 'waiting_visitor_details', requestType: 'meeting', history: state.history, visitorName };
        await sendWA(from, '📅 أخبرني عن موضوع الاجتماع والتاريخ والوقت المناسب لك 👇');
      }
    } else if (ch === 3) {
      userState[from] = { step: 'waiting_visitor_details', requestType: 'reminder', history: state.history, visitorName };
      await sendWA(from, '🔔 وش تبيني أذكّر عبدالعزيز فيه؟ 👇');
    } else if (ch === 4) {
      userState[from] = { step: 'waiting_visitor_reminder_topic', history: state.history, visitorName };
      await sendWA(from, '🔔 وش تبيني أذكّرك فيه؟ 👇');
    }
    return;
  }

  // task_request
  if (analysis.intent === 'task_request') {
    if (analysis.task_title) {
      userState[from] = { step: 'waiting_visitor_time', requestType: 'task', requestTitle: analysis.task_title, history: state.history, visitorName };
      await sendWA(from, '📌 فاهم الطلب: "' + analysis.task_title + '"\n\n📅 متى تبغى يكون؟ وش التاريخ والوقت المناسب؟');
    } else {
      userState[from] = { step: 'waiting_visitor_details', requestType: 'task', history: state.history, visitorName };
      await sendWA(from, '📌 أخبرني بتفاصيل الطلب 👇');
    }
    return;
  }

  // meeting_request
  if (analysis.intent === 'meeting_request') {
    const slots = await pool.query('SELECT * FROM available_slots WHERE slot_date>=$1 AND is_booked=false ORDER BY slot_date,slot_time LIMIT 5',[todayStr()]).catch(function() { return {rows:[]}; });
    if (slots.rows.length) {
      let sm = '📅 الأوقات المتاحة لعبدالعزيز:\n\n';
      slots.rows.forEach(function(s,i) { sm += (i+1) + ' - ' + s.slot_date + ' — ' + fmt12(s.slot_time) + '\n'; });
      sm += '\nاختر رقم الموعد المناسب 👇';
      userState[from] = { step: 'waiting_slot_choice', slots: slots.rows, history: state.history, visitorName, meetingTopic: analysis.task_title };
      await sendWA(from, sm);
    } else if (analysis.task_title) {
      userState[from] = { step: 'waiting_visitor_time', requestType: 'meeting', requestTitle: analysis.task_title, history: state.history, visitorName };
      await sendWA(from, '📅 تمام، موضوع الاجتماع: "' + analysis.task_title + '"\n\n⏰ وش التاريخ والوقت المناسب لك؟\nمثال: "الأحد الساعة 10 الصبح"');
    } else {
      userState[from] = { step: 'waiting_visitor_details', requestType: 'meeting', history: state.history, visitorName };
      await sendWA(from, '📅 وش موضوع الاجتماع؟ ومتى يناسبك؟ 👇');
    }
    return;
  }

  // reminder_for_owner
  if (analysis.intent === 'reminder_for_owner') {
    if (analysis.task_title) {
      userState[from] = { step: 'waiting_reminder_choice', reminderTitle: analysis.task_title, reminderDate: analysis.date, reminderTime: analysis.time, history: state.history, visitorName };
      await sendWA(from, '🔔 فاهم إنك تبغى تذكّر عبدالعزيز بـ "' + analysis.task_title + '"\n\nشرايك أذكّرك أنا مباشرة بدون ما تنتظر رد؟ 😊\n\n1️⃣ أيوه، ذكّرني أنت\n2️⃣ لا، أرسلها لعبدالعزيز');
    } else {
      userState[from] = { step: 'waiting_visitor_details', requestType: 'reminder', history: state.history, visitorName };
      await sendWA(from, '🔔 وش تبيني أذكّر عبدالعزيز فيه؟ 👇');
    }
    return;
  }

  // reminder_for_self
  if (analysis.intent === 'reminder_for_self') {
    userState[from] = { step: 'waiting_visitor_reminder_topic', history: state.history, visitorName };
    await sendWA(from, '🔔 وش تبيني أذكّرك فيه؟ 👇'); return;
  }

  // رد نواف الذكي
  state.history.push({ role: 'visitor', msg: msg });
  const reply = await nawafVisitorReply(visitorName||'الزائر', msg, state.history);
  if (reply) {
    state.history.push({ role: 'nawaf', msg: reply });
    userState[from] = Object.assign({}, state);
    if (state.history.length > 4 && state.history.length % 5 === 0) {
      setImmediate(function() { learnFromVisitor(visitorName, state.history, ''); });
    }
    if (state.history.length > 6 && state.history.length % 6 === 0) {
      await sendWA(from, reply + '\n\n─────────────\nأقدر أساعدك في:\n1️⃣ مهمة / 2️⃣ اجتماع / 3️⃣ تذكير لعبدالعزيز / 4️⃣ تذكيرك أنت 😊');
    } else {
      await sendWA(from, reply);
    }
  } else {
    await sendWA(from, 'ما فهمت وضح أكثر 😊\nأو اختر:\n\n1️⃣ مهمة / 2️⃣ اجتماع / 3️⃣ تذكير لعبدالعزيز / 4️⃣ تذكيرك أنت');
  }
}

// ─── API Routes ───────────────────────────────────────────────────────────
app.get('/tasks', async function(req,res) {
  try { res.json((await pool.query('SELECT * FROM tasks ORDER BY date,time')).rows); } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/tasks', async function(req,res) {
  const b = req.body;
  if (!b.title||!b.date||!b.time) return res.status(400).json({error:'بيانات ناقصة'});
  const id = Date.now();
  try {
    await pool.query('INSERT INTO tasks (id,title,type,date,time,note,location) VALUES ($1,$2,$3,$4,$5,$6,$7)',[id,b.title,b.type||'task',b.date,b.time,b.note||'',b.location||'']);
    res.json({id,title:b.title,type:b.type||'task',date:b.date,time:b.time,note:b.note||'',location:b.location||'',done:false});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.patch('/tasks/:id', async function(req,res) {
  const b = req.body;
  try {
    if (b.done !== undefined) {
      await pool.query('UPDATE tasks SET done=$1 WHERE id=$2',[b.done,req.params.id]);
    } else {
      const f=[],v=[]; let i=1;
      if(b.title!==undefined){f.push('title=$'+i++);v.push(b.title);}
      if(b.type!==undefined){f.push('type=$'+i++);v.push(b.type);}
      if(b.date!==undefined){f.push('date=$'+i++);v.push(b.date);}
      if(b.time!==undefined){f.push('time=$'+i++);v.push(b.time);}
      if(b.note!==undefined){f.push('note=$'+i++);v.push(b.note);}
      if(b.location!==undefined){f.push('location=$'+i++);v.push(b.location);}
      if(b.priority!==undefined){f.push('priority=$'+i++);v.push(b.priority);}
      if(f.length){v.push(req.params.id);await pool.query('UPDATE tasks SET '+f.join(',')+" WHERE id=$"+i,v);}
    }
    res.json((await pool.query('SELECT * FROM tasks WHERE id=$1',[req.params.id])).rows[0]);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.delete('/tasks/:id', async function(req,res) {
  try { await pool.query('DELETE FROM tasks WHERE id=$1',[req.params.id]); res.json({ok:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/tasks/:id/send', async function(req,res) {
  try {
    const t = (await pool.query('SELECT * FROM tasks WHERE id=$1',[req.params.id])).rows[0];
    if (!t) return res.status(404).json({error:'غير موجودة'});
    await sendWA(PHONE, buildTaskMsg(t));
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/visitors', async function(req,res) {
  try { res.json((await pool.query('SELECT * FROM visitors ORDER BY last_seen DESC')).rows); } catch(e) { res.json([]); }
});
app.get('/relations', async function(req,res) {
  try { res.json((await pool.query('SELECT * FROM relations ORDER BY created_at DESC')).rows); } catch(e) { res.json([]); }
});
app.get('/memory', async function(req,res) {
  try { res.json((await pool.query('SELECT * FROM memory ORDER BY updated_at DESC LIMIT 50')).rows); } catch(e) { res.json([]); }
});
app.get('/slots', async function(req,res) {
  try { res.json((await pool.query('SELECT * FROM available_slots WHERE slot_date>=$1 ORDER BY slot_date,slot_time',[todayStr()])).rows); } catch(e) { res.json([]); }
});
app.post('/slots', async function(req,res) {
  const b = req.body;
  try { res.json((await pool.query('INSERT INTO available_slots (slot_date,slot_time) VALUES ($1,$2) RETURNING *',[b.slot_date,b.slot_time])).rows[0]); } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/slots/:id', async function(req,res) {
  try { await pool.query('DELETE FROM available_slots WHERE id=$1',[req.params.id]); res.json({ok:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/appointment-requests', async function(req,res) {
  try {
    const rows = (await pool.query("SELECT *,requested_by_name AS name,requested_by AS phone,date AS proposed_date,time AS proposed_time FROM tasks WHERE requested_by!='' ORDER BY created_at DESC LIMIT 20")).rows;
    res.json(rows);
  } catch(e) { res.json([]); }
});
app.get('/visitor-reminders', async function(req,res) {
  try {
    const rows = (await pool.query("SELECT *,requested_by AS phone FROM tasks WHERE requested_by!='' AND type='reminder' ORDER BY created_at DESC LIMIT 20")).rows;
    res.json(rows);
  } catch(e) { res.json([]); }
});

app.get('/working-hours', async function(req,res) {
  try {
    const r = await pool.query("SELECT * FROM settings WHERE key='working_hours'");
    if (r.rows.length) return res.json(JSON.parse(r.rows[0].value));
    res.json({start_time:'10:00',end_time:'18:00',gap_minutes:60,working_days:'6,0,1,2,3,4'});
  } catch(e) { res.json({start_time:'10:00',end_time:'18:00',gap_minutes:60,working_days:'6,0,1,2,3,4'}); }
});
app.patch('/working-hours', async function(req,res) {
  try {
    await pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',['working_hours',JSON.stringify(req.body)]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/', function(req,res) {
  res.json({ status:'مهامي شغّال', time: new Date().toLocaleString('ar-SA') });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('مهامي على port ' + PORT); });

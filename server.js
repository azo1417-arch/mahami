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
app.use("/files", require("express").static(require("path").join(__dirname, "generated")));

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
  await pool.query(
    "CREATE TABLE IF NOT EXISTS documents (" +
    "id BIGSERIAL PRIMARY KEY, " +
    "owner TEXT NOT NULL, " +
    "title TEXT DEFAULT '', " +
    "expiry_date TEXT, " +
    "remind_date TEXT, " +
    "file_url TEXT, " +
    "reminded BOOLEAN DEFAULT FALSE, " +
    "created_at TIMESTAMP DEFAULT NOW())"
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS conversation_history (" +
    "id BIGSERIAL PRIMARY KEY, " +
    "phone TEXT NOT NULL, " +
    "role TEXT NOT NULL, " +
    "message TEXT NOT NULL, " +
    "created_at TIMESTAMP DEFAULT NOW())"
  );
  await pool.query("CREATE INDEX IF NOT EXISTS conv_phone_idx ON conversation_history(phone, created_at DESC)");

  await pool.query(
    "CREATE TABLE IF NOT EXISTS recurring_tasks (" +
    "id BIGSERIAL PRIMARY KEY, " +
    "title TEXT NOT NULL, " +
    "type TEXT DEFAULT 'task', " +
    "time TEXT, " +
    "days TEXT, " +
    "note TEXT DEFAULT '', " +
    "active BOOLEAN DEFAULT TRUE, " +
    "created_at TIMESTAMP DEFAULT NOW())"
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS generated_files (" +
    "id BIGSERIAL PRIMARY KEY, " +
    "owner TEXT NOT NULL, " +
    "filename TEXT NOT NULL, " +
    "filetype TEXT NOT NULL, " +
    "filepath TEXT NOT NULL, " +
    "created_at TIMESTAMP DEFAULT NOW())"
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS html_files (" +
    "id TEXT PRIMARY KEY, " +
    "owner TEXT NOT NULL, " +
    "title TEXT, " +
    "content TEXT NOT NULL, " +
    "created_at TIMESTAMP DEFAULT NOW())"
  );
  await pool.query("ALTER TABLE html_files ADD COLUMN IF NOT EXISTS drive_link TEXT").catch(()=>{});

  await pool.query(
    "CREATE TABLE IF NOT EXISTS permissions (" +
    "id BIGSERIAL PRIMARY KEY, " +
    "permission TEXT NOT NULL, " +
    "target TEXT NOT NULL DEFAULT 'all', " +
    "enabled BOOLEAN DEFAULT TRUE, " +
    "UNIQUE(permission, target))"
  );

  await pool.query(
    "CREATE TABLE IF NOT EXISTS scheduled_messages (" +
    "id BIGSERIAL PRIMARY KEY, " +
    "owner TEXT NOT NULL, " +
    "target_phone TEXT NOT NULL, " +
    "target_name TEXT DEFAULT '', " +
    "message TEXT NOT NULL, " +
    "send_at TIMESTAMP NOT NULL, " +
    "sent BOOLEAN DEFAULT FALSE, " +
    "created_at TIMESTAMP DEFAULT NOW())"
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS daily_reminders (" +
    "id BIGSERIAL PRIMARY KEY, " +
    "owner TEXT NOT NULL, " +
    "title TEXT NOT NULL, " +
    "time TEXT DEFAULT '09:00', " +
    "until_date TEXT, " +
    "active BOOLEAN DEFAULT TRUE, " +
    "created_at TIMESTAMP DEFAULT NOW())"
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS owner_profile (" +
    "id BIGSERIAL PRIMARY KEY, " +
    "key TEXT UNIQUE NOT NULL, " +
    "value TEXT NOT NULL, " +
    "updated_at TIMESTAMP DEFAULT NOW())"
  );
  console.log('✅ DB جاهزة');
}
initDB();

const sentReminders = new Set();
const userState = {};

// ─── Helpers ──────────────────────────────────────────────────────────────
// ─── نظام الصلاحيات ──────────────────────────────────────────────────────
const ALL_PERMISSIONS = [
  { key: 'tasks',     label: '📋 قبول طلبات الزوار' },
  { key: 'meetings',  label: '📅 حجز الاجتماعات' },
  { key: 'reminders', label: '🔔 تذكيرات الزوار' },
  { key: 'chat',      label: '💬 المحادثة مع الزوار' },
  { key: 'voice',     label: '🎤 الرسائل الصوتية للزوار' },
  { key: 'images',    label: '🖼️ قراءة صور وملفات الزوار' },
  { key: 'wife',      label: '💌 التواصل مع الزوجة' },
];

async function isPermEnabled(permKey, targetPhone) {
  try {
    if (targetPhone) {
      const r = await pool.query('SELECT enabled FROM permissions WHERE permission=$1 AND target=$2',[permKey,targetPhone]);
      if (r.rows.length) return r.rows[0].enabled;
    }
    const r = await pool.query('SELECT enabled FROM permissions WHERE permission=$1 AND target=$2',[permKey,'all']);
    if (r.rows.length) return r.rows[0].enabled;
    return true;
  } catch(e) { return true; }
}

async function setPerm(permKey, enabled, target) {
  const t = target || 'all';
  await pool.query('INSERT INTO permissions (permission,target,enabled) VALUES ($1,$2,$3) ON CONFLICT (permission,target) DO UPDATE SET enabled=$3',[permKey,t,enabled]);
}

async function getPermsStatus(targetPhone) {
  const result = [];
  for (const p of ALL_PERMISSIONS) {
    const enabled = await isPermEnabled(p.key, targetPhone);
    result.push(Object.assign({}, p, { enabled }));
  }
  return result;
}

function buildPermsMsg(perms, targetLabel) {
  let msg = '⚙️ *صلاحيات نواف*' + (targetLabel ? ' مع ' + targetLabel : '') + ':\n\n';
  perms.forEach(function(p, i) {
    msg += (i+1) + '. ' + p.label + ' — ' + (p.enabled ? '✅' : '❌') + '\n';
  });
  msg += '\nأرسل رقم الصلاحية لتبديلها\nأو "وقف الكل" / "شغّل الكل"';
  return msg;
}

async function sendWA(to, message) {
  try {
    const chatId = to.includes('@') ? to : to + '@c.us';
    await axios.post(GA_URL + '/sendMessage/' + GA_TOKEN, { chatId, message });
  } catch(e) { console.error('WA Error:', e.message); }
}

async function sendWAFile(to, fileBase64, filename, caption) {
  try {
    const chatId = to.includes('@') ? to : to + '@c.us';
    const ext = filename.split('.').pop().toLowerCase();
    const mimeMap = { csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', html: 'text/html', txt: 'text/plain' };
    const mimeType = mimeMap[ext] || 'application/octet-stream';
    await axios.post(GA_URL + '/sendFileByUpload/' + GA_TOKEN, {
      chatId, caption: caption || '', fileName: filename,
      file: 'data:' + mimeType + ';base64,' + fileBase64
    });
  } catch(e) { console.error('WA File Error:', e.message); }
}

async function sendWAPdfFromBuffer(to, pdfBuffer, filename, caption) {
  try {
    const chatId = to.includes('@') ? to : to + '@c.us';
    const FormData = require('form-data');
    const form = new FormData();
    form.append('chatId', chatId);
    form.append('caption', caption || '');
    form.append('fileName', filename);
    form.append('file', Buffer.from(pdfBuffer), {
      filename: filename,
      contentType: 'application/pdf'
    });
    const res = await axios.post(GA_URL + '/sendFileByUpload/' + GA_TOKEN, form, {
      headers: form.getHeaders(),
      timeout: 60000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    console.log('✅ PDF sent:', res.data);
    return true;
  } catch(e) {
    console.error('sendWAPdf error:', e.response?.status, e.message);
    return false;
  }
}

async function transcribeAudio(audioUrl) {
  try {
    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) return null;

    // حمّل ملف الصوت
    let audioBuffer;
    try {
      const r = await axios.get(audioUrl, {
        responseType: 'arraybuffer', timeout: 30000,
        headers: { 'Authorization': 'Bearer ' + GA_TOKEN }
      });
      audioBuffer = r.data;
    } catch(e) {
      const r = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 30000 });
      audioBuffer = r.data;
    }

    // أرسل لـ Whisper API
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', Buffer.from(audioBuffer), { filename: 'audio.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-1');
    form.append('language', 'ar');

    const res = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { ...form.getHeaders(), 'Authorization': 'Bearer ' + OPENAI_KEY },
      timeout: 30000
    });
    return res.data.text || null;
  } catch(e) {
    console.error('Whisper error:', e.message);
    return null;
  }
}

async function exportDriveFilePdf(driveLink) {
  try {
    const match = driveLink.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) return null;
    const fileId = match[1];
    const token = await getOAuthToken();
    if (!token) return null;
    const { google } = require('googleapis');
    const client = await getOAuthClient();
    client.setCredentials(token);
    client.on('tokens', async function(t) { await saveOAuthToken(Object.assign({}, token, t)); });
    const drive = google.drive({ version: 'v3', auth: client });
    const res = await drive.files.export(
      { fileId, mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' }
    );
    return Buffer.from(res.data);
  } catch(e) {
    console.error('exportDriveFilePdf:', e.message);
    return null;
  }
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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.post('https://api.anthropic.com/v1/messages', {
        model, max_tokens,
        messages: [{ role:'user', content: prompt }]
      }, {
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version':'2023-06-01', 'content-type':'application/json' }
      });
      return res.data.content[0].text.trim();
    } catch(e) {
      console.error('AI Error (attempt ' + (attempt+1) + '):', e.message);
      if (attempt < 2 && (e.response?.status === 529 || e.response?.status === 503 || e.response?.status === 500)) {
        await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      return null;
    }
  }
  return null;
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
    (msg.includes('الرسالة المقصودة:') ? 'مهم: المستخدم يسأل عن "الرسالة المقصودة" المذكورة، لا عن مهام السياق\n\n' : '') +
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
    '- ذكرني بعد X دقيقة/ساعة = add_reminder (date=اليوم, time=الوقت المحسوب)\n' +
    '- ذكرني كل يوم بـ X حتى تاريخ Y = daily_reminder (task_title=المهمة, date=تاريخ النهاية)\n' +
    '- ارسل/أرسل لـ[شخص] بعد X أو في تاريخ/وقت معين = scheduled_message (task_title=الرسالة, target_name=المستقبل, date=التاريخ, time=الوقت)\n' +
    '- مشغول/في اجتماع = busy\n' +
    '- رجعت/خلصت = back\n' +
    '- تذكر/غيرت/اشتريت = remember\n' +
    '- متى آخر/كم صار = recall\n' +
    '- اضف [اسم] [معلومات] = add_relation\n' +
    '- وش عندي عن [اسم] = recall_relation\n' +
    '- اضف موعد متاح = add_slot\n' +
    '- وش مواعيدي المتاحة = show_slots\n' +
    '- كل [يوم/أسبوع/أحد/اثنين] الساعة X = add_recurring (task_title=العنوان, note=الأيام والوقت)\n' +
    '- وش تذكيراتي المتكررة/المتكررة = show_recurring\n' +
    '- وين/موقع/خريطة/المسافة/كم المسافة/اتجاهات = maps (task_title=الاستفسار)\n' +
    '- سوّ/اعمل/ابن جدول أو ملف أو تقرير أو خطة = create_file (task_title=وصف الطلب)\n' +
    '- عدّل/غيّر في الملف = edit_file (task_title=التعديل المطلوب)\n' +
    '- أرسلني الملف PDF/بي دي اف/صدّره PDF = export_pdf\n' +
    '- وش صلاحياتك/صلاحيات نواف = show_permissions\n' +
    '- وقف/شغّل صلاحية [رقم أو اسم] = set_permission (task_title=الرقم أو الاسم, note=وقف أو شغّل)\n' +
    '- الجو/الطقس/حرارة/بارد/حار = weather (task_title = اسم المدينة لو ذكرت)\n' +
    '- سعر الدولار/العملات/الريال/صرف = currency\n' +
    '- سعر الذهب = gold\n' +
    '- اخبار/خبر عن/وش صار = news (task_title = الموضوع)\n' +
    '- ابحث/وش هو/عرفني عن/وش تعرف عن = search (task_title = موضوع البحث)\n' +
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
    'تتكلم بعامية نجدية سعودية أصيلة — بالضبط زي أهل الرياض.\n' +
    'كلمات ممنوعة: "ينطيك" (الصح: يعطيك)، "بخبر" (الصح: بقولك)، "كيفك"، "شلونك"، "هلا والله"\n\n' +
    'قدراتك الفعلية — لا تنكرها أبداً:\n' +
    '✅ تسوي جداول وملفات وتحفظها في Google Drive مباشرة\n' +
    '✅ تحوّل الملفات PDF وترسلها على واتساب\n' +
    '✅ تسجل مهام واجتماعات وتذكيرات\n' +
    '✅ ترسل رسائل للزوجة وللزوار\n' +
    '✅ تجيب الطقس والأخبار والعملات\n' +
    '✅ تقرأ الصور والـ PDF\n' +
    '✅ تبحث في الإنترنت\n\n' +
    'قواعد ذهبية:\n' +
    '1. لا تقول أبداً "ما عندي صلاحية" أو "ما أقدر أدخل على قوقل" — هذا كذب، أنت مربوط بـ Google Drive\n' +
    '2. لا تقول أبداً "وضح أكثر" أو "ما فهمت" — دائماً اجتهد وأجب\n' +
    '3. أجوبتك عملية ومفيدة\n' +
    '4. لو سؤال طبي: أعط معلومات حقيقية مع نصيحة زيارة طبيب إذا لزم\n' +
    '5. لا ترسل إشعارات أو تبلغ عن أي شيء حفظته\n\n' +
    'السياق الحالي:\n' + context + '\n\n' +
    (lessons ? 'دروس:\n' + lessons + '\n\n' : '') +
    'عبدالعزيز: ' + msg + '\n\n' +
    'رد مباشر ومفيد بدون مقدمات.';
  return callAI('claude-sonnet-4-20250514', 800, prompt);
}

// ─── Nawaf Visitor Reply ──────────────────────────────────────────────────
async function nawafVisitorReply(visitorName, msg, history, isWife) {
  const visitorL = await getLessons('visitor_lessons');
  const nawafL   = await getLessons('nawaf_lessons');
  const lessons  = [visitorL, nawafL].filter(Boolean).join('\n');
  const histText = history.slice(-6).map(function(h) {
    return (h.role==='visitor' ? visitorName : 'نواف') + ': ' + h.msg;
  }).join('\n');
  const prompt =
    'أنت "نواف" المساعد الشخصي لعبدالعزيز على واتساب.\n' +
    'شخصيتك: ودي ومرتب، تتكلم عامية نجدية سعودية أصيلة.\n' +
    'ممنوع: "ينطيك"، "بخبر"، "كيفك"، "شلونك"، "أبو عبدالعزيز" (لا تستخدم هذه الكنية أبداً)\n' +
    'ممنوع: "تحت أمرش" (الصح: "تحت أمرك")\n' +
    'أمثلة صح: "ابشر"، "لا والله"، "أي تفضل"، "تمام"، "الله يعطيك العافية"\n' +
    (isWife ? 'هذه زوجة عبدالعزيز — تعاملها بود عائلي طبيعي\n' : '') +
    'مهمتك: مساعدة الزوار في التواصل مع عبدالعزيز.\n' +
    (lessons ? 'دروس من محادثات سابقة:\n' + lessons + '\n\n' : '') +
    'سجل المحادثة:\n' + histText + '\n\n' +
    visitorName + ': ' + msg + '\n\n' +
    'رد قصير وطبيعي (جملة أو جملتين). لو طلب محدد قل "تمام، أرسل التفاصيل".';
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

// ─── قراءة PDF أو صورة واستخراج تاريخ الانتهاء ──────────────────────────
async function extractExpiryFromFile(fileUrl, fileType) {
  try {
    // تحميل الملف
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const base64   = Buffer.from(response.data).toString('base64');

    let content;
    if (fileType === 'pdf') {
      content = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: 'استخرج تاريخ الانتهاء أو تاريخ الصلاحية من هذا الملف. أعد JSON فقط:\n{"title":"اسم الوثيقة أو الملف","expiry_date":"YYYY-MM-DD أو null","notes":"أي ملاحظة مهمة"}\nإذا ما وجدت تاريخ انتهاء اجعل expiry_date: null' }
      ];
    } else {
      // صورة
      const mediaType = fileType === 'png' ? 'image/png' : 'image/jpeg';
      content = [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: 'استخرج تاريخ الانتهاء أو تاريخ الصلاحية من هذه الصورة. أعد JSON فقط:\n{"title":"اسم الوثيقة أو الملف","expiry_date":"YYYY-MM-DD أو null","notes":"أي ملاحظة مهمة"}\nإذا ما وجدت تاريخ انتهاء اجعل expiry_date: null' }
      ];
    }

    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    });

    const text  = res.data.content[0].text.trim();
    const clean = text.replace(/^```[a-z]*\n?/, '').replace(/```\s*$/, '').trim();
    return JSON.parse(clean);
  } catch(e) {
    console.error('extractExpiry error:', e.message);
    return null;
  }
}


// ─── الذاكرة الشخصية لعبدالعزيز ─────────────────────────────────────────
async function saveProfile(key, value) {
  try {
    await pool.query('INSERT INTO owner_profile (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW()',[key,value]);
  } catch(e) {}
}

async function getProfile() {
  try {
    const r = await pool.query('SELECT key,value FROM owner_profile ORDER BY updated_at DESC');
    if (!r.rows.length) return '';
    return r.rows.map(function(row){ return row.key + ': ' + row.value; }).join('\n');
  } catch(e) { return ''; }
}

async function updateProfileFromConversation(msg, response) {
  // في الخلفية — نواف يستخرج معلومات عن عبدالعزيز من المحادثة
  try {
    const prompt =
      'بناءً على هذه المحادثة، هل يمكن استخراج معلومات مفيدة عن عبدالعزيز؟\n' +
      'عبدالعزيز: "' + msg + '"\n' +
      'نواف: "' + response.substring(0,200) + '"\n\n' +
      'أعد JSON فقط أو {} إذا ما في معلومات:\n' +
      '{"key":"اسم المعلومة","value":"القيمة"}\n\n' +
      'أمثلة مفيدة:\n' +
      '- لو قال "اجتماعاتي دايماً الصبح" → {"key":"وقت_الاجتماعات","value":"الصبح"}\n' +
      '- لو ذكر مشروع → {"key":"مشروع_حالي","value":"اسم المشروع"}\n' +
      '- لو ذكر شخص مهم → {"key":"شخص_مهم","value":"الاسم والعلاقة"}\n' +
      'إذا ما في معلومة مفيدة أعد {}';
    const res = await callAIJson('claude-sonnet-4-20250514', 200, prompt);
    if (res && res.key && res.value) await saveProfile(res.key, res.value);
  } catch(e) {}
}

// ─── توليد الملفات ────────────────────────────────────────────────────────
const fs   = require('fs');
const pathM = require('path');

async function generateFile(type, content, filename) {
  try {
    const dir = pathM.join(__dirname, 'generated');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filepath = pathM.join(dir, filename);

    if (type === 'csv' || type === 'excel') {
      fs.writeFileSync(filepath, content, 'utf8');
    } else if (type === 'html') {
      fs.writeFileSync(filepath, content, 'utf8');
    } else {
      fs.writeFileSync(filepath, content, 'utf8');
    }
    return filepath;
  } catch(e) { console.error('generateFile:', e.message); return null; }
}

async function buildFileFromRequest(request, profile) {
  const prompt =
    'عبدالعزيز يطلب: "' + request + '"\n\n' +
    'معلومات عنه:\n' + (profile||'لا يوجد') + '\n\n' +
    'أعد JSON فقط:\n' +
    '{"type":"csv|html|txt","filename":"اسم_الملف.csv","title":"عنوان","content":"محتوى الملف كامل"}\n\n' +
    'قواعد:\n' +
    '- جداول Excel → type: csv (محتوى CSV صحيح)\n' +
    '- تقارير/وثائق → type: html (HTML منسق جميل)\n' +
    '- قوائم/نصوص → type: txt\n' +
    '- الـ content يكون المحتوى الكامل جاهز للحفظ\n' +
    '- للـ CSV: أول سطر headers، ثم البيانات\n' +
    '- للـ HTML: صفحة كاملة مع CSS مدمج، RTL، خط عربي';
  return callAIJson('claude-sonnet-4-20250514', 2000, prompt);
}

// ─── Google Drive / Sheets / Docs / Forms ────────────────────────────────
let googleAuth = null;

async function getGoogleAuth() {
  try {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
    if (!creds.client_email) { console.error('Google Auth: GOOGLE_CREDENTIALS missing or invalid'); return null; }
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/forms'
      ]
    });
    const client = await auth.getClient();
    console.log('✅ Google Auth OK:', creds.client_email);
    return client;
  } catch(e) { console.error('Google Auth Error:', e.message); return null; }
}

const DRIVE_FOLDER_ID = '1SYDUzTn36qm_vxs4FjiXKkqTpvJkR-B0';

async function createGoogleSheet(title, data) {
  try {
    const { google } = require('googleapis');
    const auth   = await getGoogleAuth(); if (!auth) return null;
    const sheets = google.sheets({ version: 'v4', auth });
    const drive  = google.drive({ version: 'v3', auth });

    const driveFile = await drive.files.create({
      requestBody: { name: title, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [DRIVE_FOLDER_ID] },
      supportsAllDrives: true,
      fields: 'id'
    });
    const sid = driveFile.data.id;

    if (data && data.length > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sid, range: 'Sheet1!A1',
        valueInputOption: 'RAW', requestBody: { values: data }
      });
    }
    await drive.permissions.create({ fileId: sid, supportsAllDrives: true, requestBody: { role: 'reader', type: 'anyone' } });
    return 'https://docs.google.com/spreadsheets/d/' + sid;
  } catch(e) { console.error('createSheet:', e.message); return null; }
}

async function createGoogleDoc(title, content) {
  try {
    const { google } = require('googleapis');
    const auth  = await getGoogleAuth(); if (!auth) return null;
    const docs  = google.docs({ version: 'v1', auth });
    const drive = google.drive({ version: 'v3', auth });

    const driveFile = await drive.files.create({
      requestBody: { name: title, mimeType: 'application/vnd.google-apps.document', parents: [DRIVE_FOLDER_ID] },
      supportsAllDrives: true,
      fields: 'id'
    });
    const did = driveFile.data.id;

    if (content) {
      await docs.documents.batchUpdate({
        documentId: did,
        requestBody: { requests: [{ insertText: { location: { index: 1 }, text: content } }] }
      });
    }
    await drive.permissions.create({ fileId: did, supportsAllDrives: true, requestBody: { role: 'reader', type: 'anyone' } });
    return 'https://docs.google.com/document/d/' + did;
  } catch(e) { console.error('createDoc:', e.message); return null; }
}

async function createGoogleForm(title, questions) {
  try {
    const { google } = require('googleapis');
    const auth  = await getGoogleAuth(); if (!auth) return null;
    const forms = google.forms({ version: 'v1', auth });
    const drive = google.drive({ version: 'v3', auth });
    const res   = await forms.forms.create({ requestBody: { info: { title, documentTitle: title } } });
    const fid   = res.data.formId;
    if (questions && questions.length > 0) {
      await forms.forms.batchUpdate({
        formId: fid,
        requestBody: {
          requests: questions.map(function(q, i) {
            return { createItem: { item: { title: q.title||q, questionItem: { question: { required: false, textQuestion: { paragraph: false } } } }, location: { index: i } } };
          })
        }
      });
    }
    await drive.files.update({ fileId: fid, addParents: DRIVE_FOLDER_ID, supportsAllDrives: true, fields: 'id' });
    await drive.permissions.create({ fileId: fid, supportsAllDrives: true, requestBody: { role: 'reader', type: 'anyone' } });
    return 'https://docs.google.com/forms/d/' + fid;
  } catch(e) { console.error('createForm:', e.message); return null; }
}

async function getLastFile(owner) {
  try {
    const r = await pool.query(
      'SELECT * FROM html_files WHERE owner=$1 ORDER BY created_at DESC LIMIT 1', [owner]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'https://mahami-production.up.railway.app';
    return {
      title: row.title,
      link: row.drive_link || (baseUrl + '/f/' + row.id),
      request: row.title,
      type: 'html',
      fileId: row.id
    };
  } catch(e) { return null; }
}

async function buildHtmlFile(request, profile) {
  const isTable  = request.match(/جدول|اكسل|sheet|بيانات|متابعة|أعمدة|عمود/i);
  const isSurvey = request.match(/استبيان|نموذج|فورم|form/i);

  let html;
  if (isTable) html = await buildCsvHtml(request, profile);
  else if (isSurvey) html = await buildSurveyHtml(request, profile);
  else html = await buildDocHtml(request, profile);

  if (!html) return null;
  // تنظيف أي markdown code blocks
  html = html.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  // تأكد يبدأ بـ <!DOCTYPE أو <html
  if (!html.startsWith('<!') && !html.startsWith('<html')) {
    const idx = html.indexOf('<html');
    if (idx > 0) html = html.substring(idx);
  }
  return html;
}

async function buildCsvHtml(request, profile) {
  const prompt =
    'عبدالعزيز يطلب جدول: "' + request + '"\n\n' +
    (profile ? 'معلومات عنه:\n' + profile + '\n\n' : '') +
    'ابن صفحة HTML كاملة مع جدول بيانات.\n\n' +
    'قواعد صارمة:\n' +
    '- HTML كامل مع CSS مدمج، RTL، خط Cairo من Google Fonts\n' +
    '- العنوان الرئيسي: فقط اسم الجدول المطلوب بالضبط — لا تضيف أي وصف أو عنوان فرعي\n' +
    '- جدول <table id="mainTable"> منسق احترافي\n' +
    '- ألوان: header أزرق داكن #1a3c5e نص أبيض، صفوف متناوبة\n' +
    '- زران في الأعلى فقط:\n' +
    '  1. "📊 افتح في Google Sheets" أخضر onclick="openSheets()"\n' +
    '  2. "🖨️ طباعة" رمادي onclick="window.print()"\n' +
    '- JavaScript للزر الأخضر:\n' +
    'function openSheets(){const t=document.getElementById("mainTable");if(!t){window.open("https://sheets.new");return;}let c="\\uFEFF";for(const r of t.rows){c+=Array.from(r.cells).map(x=>\'"\'+x.innerText.replace(/"/g,"")+\'"\').join(",")+\"\\n\";}const b=new Blob([c],{type:"text/csv;charset=utf-8"});const u=URL.createObjectURL(b);const a=document.createElement("a");a.href=u;a.download="data.csv";document.body.appendChild(a);a.click();setTimeout(()=>{window.open("https://sheets.new","_blank");},800);}\n' +
    '- تاريخ اليوم في الأسفل فقط\n' +
    '- لا تضيف أي نص إضافي أو وصف خارج الجدول\n' +
    '- أعد HTML فقط بدون أي نص خارجه وبدون ```';
  return callAI('claude-sonnet-4-20250514', 4000, prompt);
}

async function buildDocHtml(request, profile) {
  const prompt =
    'عبدالعزيز يطلب: "' + request + '"\n\n' +
    (profile ? 'معلومات عنه:\n' + profile + '\n\n' : '') +
    'ابن صفحة HTML تشبه مستند Word احترافي.\n\n' +
    'قواعد صارمة:\n' +
    '- HTML كامل مع CSS مدمج، RTL، خط Cairo\n' +
    '- العنوان الرئيسي: فقط ما طلبه عبدالعزيز بالضبط — لا تضيف عنواناً من عندك\n' +
    '- تصميم ورقة A4 بيضاء مع هوامش (max-width: 800px، padding: 40px)\n' +
    '- عناوين وأقسام واضحة ومنظمة\n' +
    '- زران في الأعلى فقط:\n' +
    '  1. "📝 افتح في Google Docs" أزرق onclick="exportDoc()"\n' +
    '  2. "🖨️ طباعة / PDF" رمادي onclick="window.print()"\n' +
    '- function exportDoc(){const b=new Blob([document.documentElement.outerHTML],{type:"text/html"});const u=URL.createObjectURL(b);const a=document.createElement("a");a.href=u;a.download="doc.html";a.click();setTimeout(()=>window.open("https://docs.new"),1500);}\n' +
    '- تاريخ اليوم في الأسفل فقط\n' +
    '- لا تضيف أي نص زائد أو مقدمة\n' +
    '- أعد HTML فقط بدون أي نص خارجه وبدون ```';
  return callAI('claude-sonnet-4-20250514', 4000, prompt);
}

async function buildSurveyHtml(request, profile) {
  const prompt =
    'عبدالعزيز يطلب استبيان: "' + request + '"\n\n' +
    (profile ? 'معلومات عنه:\n' + profile + '\n\n' : '') +
    'ابن صفحة HTML استبيان/نموذج احترافي.\n\n' +
    'قواعد:\n' +
    '- HTML كامل مع CSS مدمج، RTL، خط Cairo\n' +
    '- نموذج <form> جميل مع حقول واضحة\n' +
    '- زر "📋 افتح في Google Forms" بنفسجي في الأعلى — يفتح forms.new\n' +
    '- زر "🖨️ طباعة" رمادي\n' +
    '- تاريخ اليوم في الأسفل\n' +
    '- HTML فقط بدون أي نص خارجه';
  return callAI('claude-sonnet-4-20250514', 4000, prompt);
}




async function buildGoogleFile(request, profile) {
  const prompt =
    '{"type":"sheet|doc|form","title":"عنوان","data":[["عمود1"],["قيمة1"]],"content":"نص","questions":["سؤال1"]}\n\n' +
    '- جداول/Excel/بيانات = sheet\n' +
    '- وثائق/تقارير/خطط = doc\n' +
    '- استبيانات/نماذج = form\n' +
    '- data: مصفوفة ثنائية الأبعاد، أول صف headers\n' +
    '- content: نص مفصل للمستند\n' +
    '- questions: قائمة أسئلة النموذج';
  return callAIJson('claude-sonnet-4-20250514', 2000, prompt);
}

async function saveConvMsg(phone, role, message) {
  try {
    await pool.query('INSERT INTO conversation_history (phone,role,message) VALUES ($1,$2,$3)',[phone,role,message]);
    await pool.query('DELETE FROM conversation_history WHERE phone=$1 AND id NOT IN (SELECT id FROM conversation_history WHERE phone=$1 ORDER BY created_at DESC LIMIT 20)',[phone,phone]);
  } catch(e) {}
}

async function getConvHistory(phone, limit) {
  try {
    const r = await pool.query('SELECT role,message FROM conversation_history WHERE phone=$1 ORDER BY created_at DESC LIMIT $2',[phone, limit||10]);
    return r.rows.reverse();
  } catch(e) { return []; }
}


async function getWeather(city) {
  try {
    const q   = encodeURIComponent(city || 'Riyadh');
    const res = await axios.get('https://wttr.in/' + q + '?format=j1', { timeout: 8000 });
    const cur = res.data.current_condition[0];
    const area= res.data.nearest_area[0];
    const cityName = area.areaName[0].value + '، ' + area.country[0].value;
    const desc = cur.lang_ar?.[0]?.value || cur.weatherDesc[0].value;
    return {
      city: cityName, temp: cur.temp_C + 'C', feels: cur.FeelsLikeC + 'C',
      desc: desc, humidity: cur.humidity + '%', wind: cur.windspeedKmph + ' كم/ساعة', uv: cur.uvIndex
    };
  } catch(e) { return null; }
}

// ─── أسعار العملات ────────────────────────────────────────────────────────
async function getCurrencyRates() {
  try {
    const res = await axios.get('https://api.exchangerate-api.com/v4/latest/SAR', { timeout: 8000 });
    const r   = res.data.rates;
    return {
      USD: (1/r.USD).toFixed(4), EUR: (1/r.EUR).toFixed(4),
      GBP: (1/r.GBP).toFixed(4), AED: (1/r.AED).toFixed(4),
      KWD: (1/r.KWD).toFixed(4), updated: res.data.date
    };
  } catch(e) { return null; }
}

// ─── سعر الذهب ────────────────────────────────────────────────────────────
async function getGoldPrice() {
  try {
    const [goldRes, rateRes] = await Promise.all([
      axios.get('https://api.metals.live/v1/spot/gold', { timeout: 8000 }),
      axios.get('https://api.exchangerate-api.com/v4/latest/USD', { timeout: 8000 })
    ]);
    const usdOz   = goldRes.data[0]?.price || goldRes.data?.price;
    const sar     = rateRes.data.rates.SAR;
    const gramSar = (usdOz * sar / 31.1035).toFixed(2);
    return { gram_sar: gramSar, oz_usd: usdOz.toFixed(2) };
  } catch(e) { return null; }
}

// ─── بحث ويب ─────────────────────────────────────────────────────────────
async function webSearch(query) {
  try {
    const url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1';
    const res = await axios.get(url, { timeout: 10000 });
    const d   = res.data;
    let result = '';
    if (d.AbstractText) result += d.AbstractText + '\n';
    if (d.Answer)       result += d.Answer + '\n';
    if (d.RelatedTopics) {
      d.RelatedTopics.slice(0,3).forEach(function(t) { if (t.Text) result += '• ' + t.Text + '\n'; });
    }
    return result.trim() || null;
  } catch(e) { return null; }
}

// ─── أخبار ───────────────────────────────────────────────────────────────
async function getNews(topic) {
  try {
    const q   = encodeURIComponent((topic||'السعودية') + ' اخبار اليوم');
    const res = await axios.get('https://api.duckduckgo.com/?q=' + q + '&format=json&no_html=1', { timeout: 10000 });
    const d   = res.data;
    const news = [];
    if (d.RelatedTopics) {
      d.RelatedTopics.slice(0,5).forEach(function(t) {
        if (t.Text) news.push(t.Text.split(' - ')[0]);
      });
    }
    return news.length > 0 ? news : null;
  } catch(e) { return null; }
}

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

async function buildRequestNotifSmart(name, from, type, title, date, time) {
  // جيب تاريخ الزائر
  let history = '';
  try {
    const prev = await pool.query("SELECT * FROM tasks WHERE requested_by=$1 AND status!='awaiting_visitor_confirm' ORDER BY created_at DESC LIMIT 3",[from]);
    if (prev.rows.length > 0) {
      history = '\n\n👤 *تاريخ ' + name + ':*\n';
      prev.rows.forEach(function(t) { history += '- ' + t.title + ' (' + t.status + ')\n'; });
    }
  } catch(e) {}
  return buildRequestNotif(name, from, type, title, date, time) + history;
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

// ─── Cron: تذكيرات متكررة ────────────────────────────────────────────────
cron.schedule('0 0 * * *', async function() {
  try {
    const today    = todayStr();
    const dayOfWeek = new Date().getDay(); // 0=أحد, 1=اثنين...
    const dayNames  = { 0:'أحد', 1:'اثنين', 2:'ثلاثاء', 3:'أربعاء', 4:'خميس', 5:'جمعة', 6:'سبت' };
    const todayName = dayNames[dayOfWeek];
    const res = await pool.query("SELECT * FROM recurring_tasks WHERE active=true");
    for (const rt of res.rows) {
      const days = rt.days ? rt.days.split(',') : [];
      const isToday = days.length === 0 || days.includes(String(dayOfWeek)) || days.includes(todayName);
      if (isToday) {
        const id = Date.now() + Math.floor(Math.random()*1000);
        await pool.query('INSERT INTO tasks (id,title,type,date,time,note) VALUES ($1,$2,$3,$4,$5,$6)',
          [id, rt.title, rt.type||'task', today, rt.time||null, rt.note||'']);
        console.log('🔄 تذكير متكرر:', rt.title);
      }
    }
  } catch(e) { console.error('Recurring:', e.message); }
}, { timezone: 'Asia/Riyadh' });

// ─── Cron: تذكير وثائق منتهية ────────────────────────────────────────────
cron.schedule('0 9 * * *', async function() {
  try {
    const today = todayStr();
    const res   = await pool.query('SELECT * FROM documents WHERE remind_date=$1 AND reminded=false',[today]);
    for (const doc of res.rows) {
      await pool.query('UPDATE documents SET reminded=true WHERE id=$1',[doc.id]);
      await sendWA(PHONE,
        '📄 *تذكير وثيقة*\n\n' +
        '📌 ' + (doc.title||'وثيقة') + '\n' +
        '📅 تاريخ الانتهاء: ' + doc.expiry_date + '\n' +
        '⚠️ باقي شهر على الانتهاء!\n\n' +
        '_مهامي_ ✨'
      );
    }
  } catch(e) { console.error('DocReminder:', e.message); }
}, { timezone: 'Asia/Riyadh' });

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

// ─── Cron: رسائل مجدولة كل دقيقة ────────────────────────────────────────
cron.schedule('* * * * *', async function() {
  try {
    const now = new Date();
    const msgs = await pool.query('SELECT * FROM scheduled_messages WHERE sent=false AND send_at<=$1', [now]);
    for (const m of msgs.rows) {
      await sendWA(m.target_phone, m.message);
      await pool.query('UPDATE scheduled_messages SET sent=true WHERE id=$1', [m.id]);
      await sendWA(m.owner, '✅ تم إرسال رسالتك لـ' + m.target_name);
    }
  } catch(e) { console.error('scheduled_messages cron:', e.message); }
}, { timezone: 'Asia/Riyadh' });

// ─── Cron: تذكيرات يومية ─────────────────────────────────────────────────
cron.schedule('* * * * *', async function() {
  try {
    const now = new Date();
    const hm = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
    const today = todayStr();
    const reminders = await pool.query(
      "SELECT * FROM daily_reminders WHERE active=true AND time=$1 AND (until_date IS NULL OR until_date>=$2)",
      [hm, today]
    );
    for (const r of reminders.rows) {
      await sendWA(r.owner, '🔔 تذكير يومي:\n📌 *' + r.title + '*' + (r.until_date ? '\n📅 حتى ' + r.until_date : ''));
      if (r.until_date && r.until_date <= today) {
        await pool.query('UPDATE daily_reminders SET active=false WHERE id=$1', [r.id]);
      }
    }
  } catch(e) { console.error('daily_reminders cron:', e.message); }
}, { timezone: 'Asia/Riyadh' });

// ─── Cron: ملخص صباحي ذكي 8 ص ───────────────────────────────────────────
cron.schedule('0 8 * * *', async function() {
  const today = todayStr();
  try {
    const [todayTasks, pendingReq, overdue] = await Promise.all([
      pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time',[today]),
      pool.query("SELECT * FROM tasks WHERE status IN ('pending','awaiting_visitor_confirm') AND requested_by!='' ORDER BY created_at DESC LIMIT 5"),
      pool.query('SELECT * FROM tasks WHERE done=false AND date<$1 ORDER BY date,time LIMIT 5',[today])
    ]);

    // اسأل نواف يبني الملخص الذكي
    const tasksList  = todayTasks.rows.map(function(t){ return t.title + (t.time?' — '+fmt12(t.time):'') + (t.type==='meeting'?' (اجتماع)':''); }).join('\n');
    const reqList    = pendingReq.rows.map(function(t){ return t.requested_by_name + ': ' + t.title; }).join('\n');
    const overdueList= overdue.rows.map(function(t){ return t.title + ' — ' + t.date; }).join('\n');

    const prompt =
      'أنت نواف، ابن ملخص صباحي ذكي لعبدالعزيز.\n' +
      'تكلم بعامية نجدية: "ابشر"، "يوم مبارك"، "عندك كذا"\n\n' +
      'مهام اليوم:\n' + (tasksList||'ما في مهام') + '\n\n' +
      'طلبات معلقة:\n' + (reqList||'ما في طلبات') + '\n\n' +
      'متأخرة:\n' + (overdueList||'ما في') + '\n\n' +
      'اكتب ملخص مختصر وذكي — أهم شيء أولاً، لا تعداد ممل.\n' +
      'إذا عنده اجتماعات نبهه خاص. إذا في طلبات معلقة ذكره.\n' +
      'لا تزيد عن 10 أسطر.';

    const summary = await callAI('claude-sonnet-4-20250514', 500, prompt);
    await sendWA(PHONE, '🌅 ' + (summary || 'صباح الخير عبدالعزيز!'));
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

  // لوق مفصل للـ messageData فقط
  if (body && body.messageData) {
    const md2 = body.messageData;
    console.log('📦 MSG TYPE:', md2.typeMessage, '| KEYS:', Object.keys(md2).join(','));
    if (md2.typeMessage === 'imageMessage' || md2.typeMessage === 'audioMessage' || md2.typeMessage === 'voiceMessage') {
      console.log('📦 MEDIA DATA:', JSON.stringify(md2).substring(0, 1000));
    }
  }

  let msg      = null;
  let fileUrl  = null;
  let fileType = null;
  let quotedText = null;
  const md = body && body.messageData;

  if (md) {
    const typeMsg = md.typeMessage || '';

    if (typeMsg === 'textMessage' || (md.textMessageData && md.textMessageData.textMessage)) {
      msg = (md.textMessageData && md.textMessageData.textMessage) ? md.textMessageData.textMessage.trim() : '';
    } else if (typeMsg === 'extendedTextMessage' || md.extendedTextMessageData) {
      msg = (md.extendedTextMessageData && md.extendedTextMessageData.text || '').trim();
      const ctx = md.extendedTextMessageData && md.extendedTextMessageData.contextInfo || null;
      if (ctx && ctx.quotedMessage) {
        const qm = ctx.quotedMessage;
        quotedText = qm.conversation || (qm.extendedTextMessage && qm.extendedTextMessage.text) || null;
      }
    } else if (typeMsg === 'imageMessage' || md.imageMessageData) {
      const imgData = md.imageMessageData || {};
      msg = imgData.caption || '';
      // جرب downloadUrl أولاً
      if (imgData.downloadUrl) {
        fileUrl = imgData.downloadUrl;
        fileType = 'jpeg';
      } else if (imgData.jpegThumbnail) {
        // استخدم thumbnail مباشرة كـ base64
        fileUrl = 'data:image/jpeg;base64,' + imgData.jpegThumbnail;
        fileType = 'jpeg';
        console.log('🖼️ Using jpegThumbnail, length:', imgData.jpegThumbnail.length);
      }
      console.log('🖼️ IMAGE URL:', fileUrl ? fileUrl.substring(0,60) : 'NULL', '| caption:', msg);
    } else if (typeMsg === 'audioMessage' || typeMsg === 'voiceMessage' || md.audioMessageData || md.voiceMessageData) {
      const audioData = md.audioMessageData || md.voiceMessageData || {};
      console.log('🎤 AUDIO URL:', audioData.downloadUrl);
      msg = '__audio__';
      fileType = 'audio';
      fileUrl = audioData.downloadUrl || null;
    } else if (typeMsg === 'documentMessage' || md.documentMessageData) {
      const docData = md.documentMessageData || {};
      fileUrl  = docData.downloadUrl;
      const fn = docData.fileName || '';
      fileType = fn.toLowerCase().endsWith('.pdf') ? 'pdf' : 'doc';
      msg      = docData.caption || '';
    } else if (md.quotedMessage) {
      msg = md.quotedMessage.textMessage || '';
    } else if (md.conversation) {
      msg = md.conversation.trim();
    }
  }

  if (!msg && !fileUrl && body && body.body) msg = body.body.trim();

  const from = body && body.senderData && body.senderData.chatId && body.senderData.chatId.replace('@c.us','');
  if (!from) return;
  if (!msg && !fileUrl) return;

  // لو في منشن — ابنِ رسالة واضحة تحتوي نص المنشن ورسالتك
  let isQuoted = false;
  if (quotedText) {
    isQuoted = true;
    if (msg && msg.trim()) {
      // عندك رسالة + منشن — مثل "المهمة هذي سجلتها ولا ز" مع منشن على "رواتب شهر أبريل"
      msg = msg.trim() + ' — الرسالة المقصودة: "' + quotedText + '"';
    } else {
      // منشن بدون رسالة
      msg = quotedText;
    }
  }

  console.log('📩', from, isQuoted?'[منشن]':'', '--', (msg||'').substring(0,120), fileUrl?'[ملف '+fileType+']':'');

  // معالجة الرسائل الصوتية
  if (fileType === 'audio') {
    if (from === PHONE) {
      await sendWA(from, '🎤 أسمع...');
      if (fileUrl) {
        const text = await transcribeAudio(fileUrl);
        if (text && text.trim()) {
          console.log('🎤 Transcribed:', text);
          await handleOwner(from, text);
        } else {
          await sendWA(from, '❌ ما قدرت أفهم الصوت، كتبلي اللي تبيه 😊');
        }
      } else {
        await sendWA(from, '❌ ما وصلني الصوت، كتبلي اللي تبيه 😊');
      }
    } else {
      const visitor = await pool.query('SELECT * FROM visitors WHERE phone=$1',[from]).then(r=>r.rows[0]).catch(()=>null);
      const vName = (visitor && visitor.name) || 'الزائر';
      if (fileUrl) {
        const text = await transcribeAudio(fileUrl);
        if (text && text.trim()) {
          await handleVisitor(from, text);
        } else {
          await sendWA(from, 'هلا ' + vName + '! 😊 ما قدرت أفهم الصوت، ممكن تكتب طلبك؟');
        }
      } else {
        await sendWA(from, 'هلا ' + vName + '! 😊 ما وصلني الصوت، ممكن تكتب طلبك؟');
      }
    }
    return;
  }

  // معالجة الملفات
  if (fileUrl && from === PHONE) {
    if (msg && msg.trim() && msg !== '__audio__') {
      userState[from] = Object.assign(userState[from]||{}, { lastFile: { url: fileUrl, type: fileType } });
      await handleOwnerFile(from, fileUrl, fileType, msg);
    } else if (fileType === 'pdf') {
      userState[from] = Object.assign(userState[from]||{}, { lastFile: { url: fileUrl, type: fileType } });
      await sendWA(from, '📎 وصلني الـ PDF — وش تبي أعرف منه؟');
    } else {
      // صورة بدون caption — صفها مباشرة
      userState[from] = Object.assign(userState[from]||{}, { lastFile: { url: fileUrl, type: fileType } });
      await handleOwnerFile(from, fileUrl, fileType, '');
    }
    return;
  }
  if (from === PHONE)      { await handleOwner(from, msg);   return; }
  if (from === WIFE_PHONE) { await handleWife(from, msg);    return; }
  // معالجة ملفات الزوار
  if (fileUrl && from !== PHONE && from !== WIFE_PHONE) {
    await handleVisitorFile(from, fileUrl, fileType, msg);
    return;
  }
  await handleVisitor(from, msg);
});

// ─── معالجة ملفات عبدالعزيز ──────────────────────────────────────────────
async function handleOwnerFile(from, fileUrl, fileType, caption) {
  const state = userState[from] || { step: 'idle' };

  // لو في انتظار تأكيد تذكير
  if (state.step === 'waiting_doc_remind_confirm') {
    const lower = (caption||'').toLowerCase();
    const isYes = ['نعم','اي','أيوه','ايوه','yes','تمام','موافق'].some(function(w) { return lower.includes(w); });
    if (isYes && state.pendingDoc) {
      const doc = state.pendingDoc;
      const expiry = new Date(doc.expiry_date);
      const remind = new Date(expiry); remind.setMonth(remind.getMonth()-1);
      const remindStr = remind.getFullYear() + '-' + String(remind.getMonth()+1).padStart(2,'0') + '-' + String(remind.getDate()).padStart(2,'0');
      await pool.query('INSERT INTO documents (owner,title,expiry_date,remind_date,file_url) VALUES ($1,$2,$3,$4,$5)',[from,doc.title,doc.expiry_date,remindStr,fileUrl||'']);
      await sendWA(from, 'تمام، بذكرك في ' + remindStr + ' ✅');
      userState[from] = { step: 'idle' };
    } else {
      await sendWA(from, 'تمام، ما بضيف تذكير');
      userState[from] = { step: 'idle' };
    }
    return;
  }

  if (!fileUrl || fileType === 'doc') {
    await sendWA(from, 'ما أقدر أقرأ هذا النوع، أرسل PDF أو صورة');
    return;
  }

  if (caption && caption.trim()) await sendWA(from, '⏳ أقرأ...');
  else if (fileType !== 'pdf') await sendWA(from, '⏳ أشوف...');
  else await sendWA(from, '⏳ أقرأ الـ PDF...');

  try {
    let base64;

    // لو data URL (thumbnail مباشر)
    if (fileUrl && fileUrl.startsWith('data:')) {
      base64 = fileUrl.split(',')[1];
    } else {
      // تحميل من Green API — جرب طرق متعددة
      let responseData;
      const downloadAttempts = [
        // محاولة 1: Green API download endpoint
        async () => {
          const GA_URL_BASE = 'https://api.green-api.com/waInstance' + process.env.GA_INSTANCE;
          const r = await axios.post(GA_URL_BASE + '/downloadFile/' + GA_TOKEN,
            { chatId: from.includes('@') ? from : from + '@c.us', idMessage: '' },
            { timeout: 20000 }
          );
          return r.data;
        },
        // محاولة 2: مباشر مع Authorization
        async () => {
          const r = await axios.get(fileUrl, {
            responseType: 'arraybuffer', timeout: 20000,
            headers: { 'Authorization': 'Bearer ' + GA_TOKEN }
          });
          return r.data;
        },
        // محاولة 3: مباشر بدون Authorization
        async () => {
          const r = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 20000 });
          return r.data;
        }
      ];

      for (const attempt of downloadAttempts) {
        try {
          responseData = await attempt();
          if (responseData) break;
        } catch(e) { console.log('Download attempt failed:', e.message); }
      }

      if (!responseData) {
        console.error('All download attempts failed for:', fileUrl);
        await sendWA(from, '❌ ما قدرت أحمل الملف. جرب تعيد إرساله');
        return;
      }
      base64 = Buffer.from(responseData).toString('base64');
    }

    // لو الـ PDF كبير جداً
    if (fileType === 'pdf' && base64.length > 5500000) {
      await sendWA(from, '⚠️ الملف كبير جداً، جرب نسخة أصغر (أقل من 4MB)');
      return;
    }

    const question = caption && caption.trim()
      ? caption.trim()
      : (fileType === 'pdf'
          ? 'اقرأ هذا الملف واستخرج أهم المعلومات منه — خاصة تاريخ الانتهاء أو أي تواريخ مهمة'
          : 'صف ما في هذه الصورة بالتفصيل');

    let content;
    if (fileType === 'pdf') {
      content = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: question + '\n\nأجب بعامية نجدية مختصرة ومفيدة. لو فيه تاريخ انتهاء ذكره بوضوح بصيغة YYYY-MM-DD.' }
      ];
    } else {
      const mediaType = fileType === 'png' ? 'image/png' : 'image/jpeg';
      content = [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: question + '\n\nأجب بعامية نجدية مختصرة ومفيدة. صف ما تشوفه وأجب على السؤال.' }
      ];
    }

    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514', max_tokens: 800,
      messages: [{ role: 'user', content }]
    }, { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });

    const answer = res.data.content[0].text.trim();
    await sendWA(from, answer);

    // لو فيه تاريخ انتهاء في الجواب — اسأل عن التذكير
    const dateMatch = answer.match(/(\d{4}-\d{2}-\d{2})/);
    const expiryWords = ['ينتهي','انتهاء','الصلاحية','تاريخ الانتهاء','يوم'];
    const hasExpiry = dateMatch && expiryWords.some(function(w){ return answer.includes(w); });
    if (hasExpiry) {
      const expiryDate = dateMatch[1];
      const remind = new Date(expiryDate); remind.setMonth(remind.getMonth()-1);
      const remindStr = remind.getFullYear() + '-' + String(remind.getMonth()+1).padStart(2,'0') + '-' + String(remind.getDate()).padStart(2,'0');
      await sendWA(from, 'تبيني أذكّرك في ' + remindStr + ' (قبل شهر من الانتهاء)؟\n\nأرسل *نعم* أو *لا*');
      userState[from] = { step: 'waiting_doc_remind_confirm', pendingDoc: { title: 'وثيقة', expiry_date: expiryDate }, fileUrl };
    }
  } catch(e) {
    console.error('File read error:', e.message);
    await sendWA(from, 'ما قدرت أقرأ الملف، جرب مرة ثانية');
  }
}

// ─── معالجة ملفات الزوار ──────────────────────────────────────────────────
async function handleVisitorFile(from, fileUrl, fileType, caption) {
  let visitor = null;
  try { const r = await pool.query('SELECT * FROM visitors WHERE phone=$1',[from]); if (r.rows.length) visitor = r.rows[0]; } catch(e) {}
  const visitorName = (visitor && visitor.name) || 'زائر';

  if (!fileUrl || fileType === 'doc') return; // تجاهل أنواع غير مدعومة

  try {
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const base64   = Buffer.from(response.data).toString('base64');
    const question = caption && caption.trim() ? caption.trim() : null;

    let content;
    if (fileType === 'pdf') {
      const q = question || 'استخرج أهم المعلومات من هذا الملف — خاصة أي تواريخ أو طلبات أو مواعيد';
      content = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: q + '\n\nأجب بإيجاز. لو فيه تاريخ انتهاء أو موعد مهم حدده بوضوح بصيغة YYYY-MM-DD.' }
      ];
    } else {
      const mediaType = fileType === 'png' ? 'image/png' : 'image/jpeg';
      const q = question || 'صف ما في هذه الصورة. لو فيه تاريخ أو موعد أو طلب حدده';
      content = [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: q + '\n\nأجب بإيجاز. لو فيه تاريخ انتهاء أو موعد مهم حدده بصيغة YYYY-MM-DD.' }
      ];
    }

    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514', max_tokens: 500,
      messages: [{ role: 'user', content }]
    }, { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });

    const answer = res.data.content[0].text.trim();

    // تحقق لو فيه تاريخ أو طلب في المحتوى
    const dateMatch = answer.match(/(\d{4}-\d{2}-\d{2})/);
    const hasRequest = ['يطلب','موعد','اجتماع','تذكير','ينتهي','انتهاء'].some(function(w){ return answer.includes(w); });

    if (dateMatch || hasRequest) {
      // أبلغ عبدالعزيز بما في الملف
      await sendWA(PHONE,
        '📎 *ملف من ' + visitorName + '*\n\n' +
        answer +
        (dateMatch ? '\n\n📅 تاريخ مذكور: ' + dateMatch[1] : '')
      );
      // رد على الزائر بصمت
      await sendWA(from, 'تمام، استلمت الملف وبوصله لعبدالعزيز ✅');
    } else {
      // أبلغ عبدالعزيز فقط
      await sendWA(PHONE, '📎 *ملف من ' + visitorName + '*\n\n' + answer);
      await sendWA(from, 'تمام، وصل الملف ✅');
    }

    // لو الزائر أرسل مع سؤال عن تذكير
    if (question && (question.includes('ذكر') || question.includes('تذكير') || question.includes('قبل'))) {
      if (dateMatch) {
        // احسب تذكير قبل شهر
        const expiry  = new Date(dateMatch[1]);
        const remind  = new Date(expiry); remind.setMonth(remind.getMonth()-1);
        const remindStr = remind.getFullYear() + '-' + String(remind.getMonth()+1).padStart(2,'0') + '-' + String(remind.getDate()).padStart(2,'0');
        // أضف تذكير تلقائي
        const id = Date.now();
        await pool.query('INSERT INTO tasks (id,title,type,date,time,note,requested_by,requested_by_name,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [id, 'تذكير وثيقة — ' + visitorName, 'reminder', remindStr, '09:00', answer.substring(0,100), from, visitorName, 'approved']
        ).catch(()=>{});
        await sendWA(PHONE, '🔔 تمت إضافة تذكير تلقائي بتاريخ ' + remindStr + ' لوثيقة ' + visitorName);
      }
    }

  } catch(e) {
    console.error('VisitorFile:', e.message);
  }
}

// ─── Handle Owner ─────────────────────────────────────────────────────────
async function handleOwner(from, msg) {
  const state = userState[from] || { step: 'idle' };
  if (state.step !== 'idle') { await handleOwnerState(from, msg, state); return; }

  // لو في ملف محفوظ — استخدمه مع أول سؤال ثم امسحه
  if (state.lastFile) {
    const f = state.lastFile;
    userState[from] = Object.assign({}, state, { lastFile: null });
    await handleOwnerFile(from, f.url, f.type, msg);
    return;
  }

  let context = '';
  try {
    const [pr, td, history, profile] = await Promise.all([
      pool.query("SELECT * FROM tasks WHERE status IN ('pending','awaiting_visitor_confirm') AND requested_by!='' ORDER BY created_at DESC LIMIT 3"),
      pool.query('SELECT * FROM tasks WHERE done=false AND date=$1 ORDER BY time LIMIT 5',[todayStr()]),
      getConvHistory(from, 8),
      getProfile()
    ]);
    if (profile) context += 'معلومات عن عبدالعزيز:\n' + profile + '\n\n';
    if (pr.rows.length) {
      context += 'طلبات معلقة:\n';
      pr.rows.forEach(function(t) { context += '- ' + t.requested_by_name + ': "' + t.title + '" (' + t.type + ')' + (t.time?' '+fmt12(t.time):'') + '\n'; });
    }
    if (td.rows.length) {
      context += '\nمهام اليوم:\n';
      td.rows.forEach(function(t) { context += '- ' + t.title + (t.time?' — '+fmt12(t.time):'') + (t.done?' ✅':'') + '\n'; });
    }
    if (history.length) {
      context += '\nسجل المحادثة الأخيرة:\n';
      history.forEach(function(h) { context += (h.role==='owner'?'عبدالعزيز':'نواف') + ': ' + h.message + '\n'; });
    }
    if (!context) context = 'لا يوجد طلبات أو مهام';
  } catch(e) {}

  const analysis = await analyzeOwner(msg, context);
  if (!analysis) { await sendWA(from, '❓ ما فهمت، جرب مرة ثانية'); return; }
  console.log('🧠 owner action:', analysis.action);
  setImmediate(function() { saveConvMsg(from, 'owner', msg); });

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

    case 'daily_reminder': {
      const title = analysis.task_title || msg;
      const untilDate = analysis.date || null;
      const time = analysis.time || '09:00';
      await pool.query('INSERT INTO daily_reminders (owner,title,time,until_date) VALUES ($1,$2,$3,$4)',
        [from, title, time, untilDate]);
      const untilStr = untilDate ? ' حتى ' + untilDate : '';
      await sendWA(from, '✅ سأذكرك كل يوم الساعة ' + fmt12(time) + ' بـ "' + title + '"' + untilStr);
      break;
    }

    case 'scheduled_message': {
      const msgToSend = analysis.task_title || analysis.message_to_send || msg;
      const targetName = analysis.target_name || '';
      let targetPhone = null;
      if (targetName.includes('زوج') || targetName.includes('أريام') || targetName.includes('ريام')) {
        targetPhone = WIFE_PHONE;
      } else {
        const rel = await pool.query('SELECT * FROM special_contacts WHERE name ILIKE $1 LIMIT 1', ['%'+targetName+'%']);
        if (rel.rows.length) targetPhone = rel.rows[0].phone;
      }
      if (!targetPhone) { await sendWA(from, '❓ ما عرفت رقم ' + targetName + '، أضفه بـ "أضف جهة اتصال"'); break; }
      const sendAt = analysis.date && analysis.time
        ? new Date(analysis.date + 'T' + analysis.time + ':00')
        : new Date(Date.now() + 60000);
      await pool.query('INSERT INTO scheduled_messages (owner,target_phone,target_name,message,send_at) VALUES ($1,$2,$3,$4,$5)',
        [from, targetPhone, targetName, msgToSend, sendAt]);
      await sendWA(from, '✅ تمام! سأرسل لـ' + targetName + ' الساعة ' + fmt12(analysis.time||'') + (analysis.date?' يوم '+analysis.date:'') + '\n\nالرسالة: "' + msgToSend + '"');
      break;
    }

    case 'send_message': {
      const msgToSend = analysis.message_to_send || analysis.task_title;
      if (!msgToSend) { await sendWA(from, '❓ وش الرسالة؟'); break; }
      let targetPhone = null;
      let targetName  = analysis.target_name || '';
      if (targetName.includes('زوج') || targetName.includes('أريام') || targetName.includes('ريام')) {
        targetPhone = WIFE_PHONE; targetName = 'الزوجة';
      } else {
        const rel = await pool.query('SELECT * FROM special_contacts WHERE name ILIKE $1 LIMIT 1', ['%'+targetName+'%']);
        if (rel.rows.length) { targetPhone = rel.rows[0].phone; }
        else {
          const last = await pool.query("SELECT * FROM tasks WHERE requested_by!='' AND status IN ('pending','awaiting_visitor_confirm') ORDER BY created_at DESC LIMIT 1");
          if (last.rows.length) { targetPhone = last.rows[0].requested_by; targetName = last.rows[0].requested_by_name; }
        }
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

    case 'weather': {
      const city = analysis.task_title || 'الرياض';
      const data = await getWeather(city);
      if (data) {
        const temp = parseInt(data.temp);
        let desc = '';
        if (temp >= 38) desc = 'عجاج وملاهيب';
        else if (temp >= 30) desc = 'حر';
        else if (temp <= 15) desc = 'برد';
        else desc = 'حق فرة وكوب قهوة';
        let reply = '🌤️ الجو في ' + data.city + ':\n\n';
        reply += 'برا ' + desc + ' — *' + data.temp + '*\n';
        reply += '☁️ ' + data.desc + '\n';
        reply += '💧 رطوبة: ' + data.humidity + '\n';
        reply += '💨 رياح: ' + data.wind + '\n';
        reply += '☀️ UV: ' + data.uv;
        await sendWA(from, reply);
      } else { await sendWA(from, 'ما قدرت أجيب الطقس، جرب بعدين'); }
      break;
    }

    case 'currency': {
      const rates = await getCurrencyRates();
      if (rates) {
        let reply = '💱 *أسعار العملات مقابل الريال السعودي*\n';
        reply += '📅 ' + rates.updated + '\n\n';
        reply += '🇺🇸 دولار: *' + rates.USD + '* ر.س\n';
        reply += '🇪🇺 يورو: *' + rates.EUR + '* ر.س\n';
        reply += '🇬🇧 جنيه: *' + rates.GBP + '* ر.س\n';
        reply += '🇦🇪 درهم: *' + rates.AED + '* ر.س\n';
        reply += '🇰🇼 دينار: *' + rates.KWD + '* ر.س';
        await sendWA(from, reply);
      } else { await sendWA(from, '❌ ما قدرت أجيب أسعار العملات، جرب لاحقاً'); }
      break;
    }

    case 'gold': {
      const [gold, rates] = await Promise.all([getGoldPrice(), getCurrencyRates()]);
      if (gold) {
        let reply = '🥇 *سعر الذهب*\n\n';
        reply += '⚖️ الغرام: *' + gold.gram_sar + '* ر.س\n';
        reply += '📊 الأوقية: *' + gold.oz_usd + '* دولار';
        await sendWA(from, reply);
      } else { await sendWA(from, '❌ ما قدرت أجيب سعر الذهب، جرب لاحقاً'); }
      break;
    }

    case 'news': {
      const topic = analysis.task_title || 'السعودية';
      await sendWA(from, '⏳ أجيب الأخبار...');
      const news = await getNews(topic);
      if (news && news.length > 0) {
        let reply = '📰 *أخبار ' + topic + ':*\n\n';
        news.forEach(function(n, i) { reply += (i+1) + '. ' + n + '\n'; });
        await sendWA(from, reply);
      } else {
        // fallback — اسأل Claude مباشرة
        const reply = await nawafOwnerReply('وش آخر أخبار ' + topic, context);
        if (reply) await sendWA(from, reply);
        else await sendWA(from, '❌ ما قدرت أجيب الأخبار');
      }
      break;
    }

    case 'search': {
      const query = analysis.task_title || msg;
      await sendWA(from, '🔍 أبحث...');
      const result = await webSearch(query);
      if (result) {
        // أرسل النتيجة لـ Claude يلخصها
        const summary = await nawafOwnerReply('لخص هذه المعلومات عن "' + query + '":\n' + result, context);
        await sendWA(from, summary || result);
      } else {
        // fallback — Claude من معرفته
        const reply = await nawafOwnerReply(msg, context);
        if (reply) await sendWA(from, reply);
      }
      break;
    }

    case 'add_recurring': {
      const title = analysis.task_title || msg;
      const time  = analysis.time;
      const note  = analysis.note || '';
      // استخرج الأيام من الرسالة
      const dayMap = { 'أحد':'0','اثنين':'1','ثلاثاء':'2','أربعاء':'3','خميس':'4','جمعة':'5','سبت':'6' };
      let days = [];
      Object.keys(dayMap).forEach(function(d) { if (msg.includes(d)) days.push(dayMap[d]); });
      const daysStr = days.length > 0 ? days.join(',') : '';
      if (title && time) {
        await pool.query('INSERT INTO recurring_tasks (title,type,time,days,note) VALUES ($1,$2,$3,$4,$5)',
          [title,'task',time,daysStr,note]);
        const daysLabel = days.length > 0 ? 'كل ' + Object.keys(dayMap).filter(function(d){ return days.includes(dayMap[d]); }).join(' و') : 'كل يوم';
        await sendWA(from, 'تمام، بضيف "' + title + '" ' + daysLabel + ' الساعة ' + fmt12(time) + ' تلقائياً ✅');
      } else {
        userState[from] = { step: 'waiting_datetime', taskTitle: title, taskType: 'recurring', taskNote: note };
        await sendWA(from, '⏰ وش الوقت والأيام للتذكير المتكرر؟\nمثال: "كل أحد الساعة 9 الصبح"');
      }
      break;
    }

    case 'create_file': {
      const request = analysis.task_title || msg;
      const words = request.trim().split(/\s+/).length;
      const hasDetails = request.match(/جدول|تقرير|خطة|قائمة|نموذج|استبيان|أعمدة|بيانات/i);
      if (words < 5 && !hasDetails) {
        userState[from] = { step: 'waiting_file_details', partialRequest: request };
        await sendWA(from, '📄 ابني لك الملف — بس وضح أكثر:\n\n• وش المحتوى اللي تبيه بالضبط؟\n• نوع الملف: جدول، تقرير، قائمة، نموذج؟\n• فيه بيانات أو أعمدة معينة؟');
        break;
      }
      await sendWA(from, '⏳ أبني الملف...');
      try {
        const profile = await getProfile();
        const htmlContent = await buildHtmlFile(request, profile);
        if (!htmlContent) { await sendWA(from, '❌ ما قدرت أبني الملف، وضّح أكثر'); break; }

        // تحقق من نوع الملف
        const isTable  = request.match(/جدول|اكسل|sheet|بيانات|متابعة|أعمدة|عمود/i);
        const isSurvey = request.match(/استبيان|نموذج|فورم|form/i);
        const driveType = isTable ? 'sheet' : isSurvey ? null : 'doc';
        console.log('📄 File type:', driveType, '| request:', request.substring(0,50));

        // جرب الحفظ في Drive أولاً
        let driveLink = null;
        if (driveType) driveLink = await saveFileToDrive(request, htmlContent, driveType);

        if (driveLink) {
          // احفظ في DB مع الرابط
          const fileId = 'f' + Date.now();
          await pool.query('INSERT INTO html_files (id,owner,title,content,drive_link) VALUES ($1,$2,$3,$4,$5)',
            [fileId, from, request, htmlContent, driveLink]).catch(()=>{});
          userState[from] = Object.assign(userState[from]||{}, { lastGeneratedFile: { title: request, link: driveLink, request, type: driveType } });
          const icon = isTable ? '📊' : '📝';
          await sendWA(from, icon + ' جاهز في Google Drive!\n\n' + request + '\n\n🔗 ' + driveLink + '\n\nيفتح مباشرة في ' + (isTable ? 'Google Sheets' : 'Google Docs') + ' ✨\nلو تبي تعدّل قولي أو قل "حوّله PDF"');
        } else {
          // احفظ في DB كـ fallback
          const fileId = 'f' + Date.now();
          await pool.query('INSERT INTO html_files (id,owner,title,content) VALUES ($1,$2,$3,$4)', [fileId, from, request, htmlContent]);
          const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'https://mahami-production.up.railway.app';
          const link = baseUrl + '/f/' + fileId;
          userState[from] = Object.assign(userState[from]||{}, { lastGeneratedFile: { title: request, link, request, type: 'html', fileId } });

          // لو ما في token — أرسل رابط تسجيل الدخول مرة وحدة
          const token = await getOAuthToken();
          if (!token) {
            await sendWA(from, '📄 جاهز!\n\n🔗 ' + link + '\n\n⚠️ لربط Google Drive مباشرة افتح هذا الرابط مرة وحدة:\nhttps://mahami-production.up.railway.app/oauth/login\n\nلو تبي تعدّل قولي');
          } else {
            await sendWA(from, '📄 جاهز!\n\n🔗 ' + link + '\n\nافتحه في المتصفح ✨\nلو تبي تعدّل قولي');
          }
        }
      } catch(e) {
        console.error('create_file error:', e.message);
        await sendWA(from, '❌ صار خطأ: ' + e.message.substring(0,100));
      }
      break;
    }

    case 'export_pdf': {
      let st = userState[from] || {};
      if (!st.lastGeneratedFile) st.lastGeneratedFile = await getLastFile(from);
      if (!st.lastGeneratedFile) { await sendWA(from, '❓ ما عندي ملف أحوّله، سوّ ملف أولاً'); break; }
      await sendWA(from, '⏳ أحوّل الملف PDF...');
      try {
        const link = st.lastGeneratedFile.link || '';
        const title = (st.lastGeneratedFile.title || 'ملف').substring(0, 30);
        const filename = title.replace(/\s+/g, '_') + '.pdf';

        if (link.includes('docs.google.com')) {
          const pdfBuffer = await exportDriveFilePdf(link);
          if (pdfBuffer) {
            const ok = await sendWAPdfFromBuffer(from, pdfBuffer, filename, '📄 ' + title);
            if (!ok) await sendWA(from, '❌ ما قدرت أرسل الملف، جرب مرة ثانية');
          } else {
            await sendWA(from, '❌ ما قدرت أحوّل الملف من Drive');
          }
        } else {
          await sendWA(from, '🖨️ افتح الرابط واضغط "طباعة" ثم "حفظ كـ PDF":\n\n🔗 ' + link);
        }
      } catch(e) {
        console.error('export_pdf error:', e.message);
        await sendWA(from, '❌ صار خطأ: ' + e.message.substring(0, 80));
      }
      break;
    }

    case 'edit_file': {
      let st2 = userState[from] || {};
      if (!st2.lastGeneratedFile) st2.lastGeneratedFile = await getLastFile(from);
      if (!st2.lastGeneratedFile) { await sendWA(from, 'ما عندي ملف سابق أعدّل عليه'); break; }
      const editReq = analysis.task_title || msg;
      await sendWA(from, '⏳ أعدّل...');
      try {
        const prof2 = await getProfile();
        const combined = st2.lastGeneratedFile.request + ' — تعديل: ' + editReq;
        const htmlContent = await buildHtmlFile(combined, prof2);
        if (!htmlContent) { await sendWA(from, 'ما قدرت أعدّل، وضّح أكثر'); break; }

        const isTable  = combined.match(/جدول|اكسل|sheet|بيانات|متابعة|أعمدة|عمود/i);
        const isSurvey = combined.match(/استبيان|نموذج|فورم/i);
        const driveType = isTable ? 'sheet' : isSurvey ? null : 'doc';

        let finalLink = null;
        if (driveType) finalLink = await saveFileToDrive(combined, htmlContent, driveType);

        if (finalLink) {
          // حفظ في DB مع drive_link
          const fileId = 'f' + Date.now();
          await pool.query('INSERT INTO html_files (id,owner,title,content,drive_link) VALUES ($1,$2,$3,$4,$5)',
            [fileId, from, combined, htmlContent, finalLink]).catch(()=>{});
          userState[from] = Object.assign(userState[from]||{}, { lastGeneratedFile: { title: combined, link: finalLink, request: combined, type: driveType, fileId } });
          const icon = isTable ? '📊' : '📝';
          await sendWA(from, icon + ' تم التعديل!\n\n🔗 ' + finalLink + '\n\nلو تبي تحوّله PDF قول "حوّله PDF"');
        } else {
          // fallback — حفظ في DB
          const fileId = 'f' + Date.now();
          await pool.query('INSERT INTO html_files (id,owner,title,content) VALUES ($1,$2,$3,$4)', [fileId, from, combined, htmlContent]);
          const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'https://mahami-production.up.railway.app';
          const link2 = baseUrl + '/f/' + fileId;
          userState[from] = Object.assign(userState[from]||{}, { lastGeneratedFile: { title: combined, link: link2, request: combined, type: 'html', fileId } });
          await sendWA(from, '✅ تم التعديل!\n\n🔗 ' + link2);
        }
      } catch(e) { await sendWA(from, '❌ صار خطأ في التعديل: ' + e.message.substring(0,80)); }
      break;
    }

    case 'maps': {
      const query = analysis.task_title || msg;
      // استخرج من/إلى لو ذكرهم
      const fromTo = msg.match(/من\s+(.+?)\s+(?:إلى|الى|ل)\s+(.+)/);
      if (fromTo) {
        const origin = fromTo[1].trim();
        const dest   = fromTo[2].trim();
        const mapsLink = 'https://www.google.com/maps/dir/' + encodeURIComponent(origin) + '/' + encodeURIComponent(dest);
        const info = await nawafOwnerReply('كم المسافة والوقت التقريبي من ' + origin + ' إلى ' + dest + '؟ أجب بجملة واحدة فقط بالأرقام', '');
        await sendWA(from, '🗺️ ' + origin + ' ← ' + dest + '\n\n' + (info||'') + '\n\n🔗 ' + mapsLink);
      } else {
        const mapsLink = 'https://www.google.com/maps/search/' + encodeURIComponent(query);
        const info = await nawafOwnerReply('وين يقع "' + query + '"؟ أجب بجملة واحدة', '');
        await sendWA(from, '📍 ' + query + '\n\n' + (info||'') + '\n\n🔗 ' + mapsLink);
      }
      break;
    }

    case 'show_permissions': {
      const perms = await getPermsStatus(null);
      await sendWA(from, buildPermsMsg(perms, ''));
      userState[from] = Object.assign(userState[from]||{}, { step: 'waiting_perm_toggle', permTarget: 'all', permTargetLabel: '' });
      break;
    }

    case 'set_permission': {
      const input = (analysis.task_title || msg).trim();
      const isEnable = msg.includes('شغّل') || msg.includes('شغل') || msg.includes('فعّل') || msg.includes('فعل');
      const isDisable = msg.includes('وقف') || msg.includes('أوقف') || msg.includes('اوقف');
      const targetName = analysis.target_name || null;
      let targetPhone = null;
      if (targetName) {
        const rel = await pool.query('SELECT * FROM special_contacts WHERE name ILIKE $1 LIMIT 1',['%'+targetName+'%']);
        if (rel.rows.length) targetPhone = rel.rows[0].phone;
      }
      // لو "وقف الكل" أو "شغّل الكل"
      if (msg.includes('الكل') || msg.includes('كل شي')) {
        for (const p of ALL_PERMISSIONS) await setPerm(p.key, isEnable, targetPhone||'all');
        await sendWA(from, (isEnable?'✅ شغّلت':'❌ وقّفت') + ' كل الصلاحيات' + (targetName?' مع '+targetName:''));
        break;
      }
      // رقم محدد
      const n = parseInt(input);
      if (n >= 1 && n <= ALL_PERMISSIONS.length) {
        const p = ALL_PERMISSIONS[n-1];
        await setPerm(p.key, isEnable, targetPhone||'all');
        await sendWA(from, (isEnable?'✅ شغّلت':'❌ وقّفت') + ' ' + p.label + (targetName?' مع '+targetName:''));
      } else {
        const perms = await getPermsStatus(null);
        await sendWA(from, buildPermsMsg(perms, ''));
        userState[from] = Object.assign(userState[from]||{}, { step: 'waiting_perm_toggle', permTarget: targetPhone||'all', permTargetLabel: targetName||'' });
      }
      break;
    }

    case 'show_profile': {
      const profile3 = await getProfile();
      if (!profile3) { await sendWA(from, 'ما عندي معلومات عنك بعد، بتعلم منك مع الوقت'); break; }
      await sendWA(from, '🧠 *اللي أعرفه عنك:*\n\n' + profile3);
      break;
    }

    case 'show_recurring': {
      const r = await pool.query("SELECT * FROM recurring_tasks WHERE active=true ORDER BY created_at DESC");
      if (!r.rows.length) { await sendWA(from, 'ما عندك تذكيرات متكررة'); break; }
      let list = '🔄 *تذكيراتك المتكررة:*\n\n';
      r.rows.forEach(function(t,i) {
        const dayNames = { '0':'أحد','1':'اثنين','2':'ثلاثاء','3':'أربعاء','4':'خميس','5':'جمعة','6':'سبت' };
        const days = t.days ? t.days.split(',').map(function(d){ return dayNames[d]||d; }).join(' و') : 'كل يوم';
        list += (i+1) + '. ' + t.title + ' — ' + days + (t.time?' الساعة '+fmt12(t.time):'') + '\n';
      });
      await sendWA(from, list);
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

      // تحقق لو المهمة موجودة مسبقاً
      try {
        const existing = await pool.query(
          "SELECT * FROM tasks WHERE done=false AND LOWER(title) LIKE LOWER($1) LIMIT 1",
          ['%' + title.substring(0,10) + '%']
        );
        if (existing.rows.length > 0) {
          const t = existing.rows[0];
          await sendWA(from, 'أي، موجودة عندي — "' + t.title + '"' + (t.date?' يوم '+t.date:'') + (t.time?' الساعة '+fmt12(t.time):''));
          break;
        }
      } catch(e) {}

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
      // لو الرسالة تحتوي سؤال عن مهمة موجودة، ابحث فيها أولاً
      const checkWords = ['سجلتها','سجلته','سجلتم','موجودة','موجود','ثبتتها','حطيتها','عندك','عندي','سبق'];
      const isChecking = checkWords.some(function(w){ return msg.includes(w); });
      if (isChecking) {
        // جيب آخر 5 مهام وسأل نواف يطابق
        try {
          const recent = await pool.query('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 5');
          if (recent.rows.length > 0) {
            const tasksList = recent.rows.map(function(t){ return '"' + t.title + '"' + (t.date?' يوم '+t.date:'') + (t.time?' الساعة '+fmt12(t.time):''); }).join(', ');
            const checkPrompt =
              'عبدالعزيز يسأل: "' + msg + '"\n' +
              'آخر المهام المسجلة: ' + tasksList + '\n\n' +
              'هل يسأل عن مهمة من هذه القائمة؟ إذا نعم، أجبه مباشرة بدون إعادة تسجيل.\n' +
              'مثال: "أي، رواتب أبريل مسجلة عندي — يوم 18 أبريل الساعة 11 ص"\n' +
              'إذا ما في مهمة مطابقة قل له بوضوح.\n' +
              'تكلم بعامية نجدية.';
            const reply = await callAI('claude-sonnet-4-20250514', 300, checkPrompt);
            if (reply) { await sendWA(from, reply); break; }
          }
        } catch(e) {}
      }
      const reply = await nawafOwnerReply(msg, context);
      if (reply) {
        await sendWA(from, reply);
        setImmediate(function() {
          saveConvMsg(from, 'nawaf', reply.substring(0,200));
          updateProfileFromConversation(msg, reply);
        });
      }
      else { await sendWA(from, 'قلي وش تقصد بالضبط؟'); }
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

  if (state.step === 'waiting_perm_toggle') {
    const input = msg.trim();
    const target = state.permTarget || 'all';
    const targetLabel = state.permTargetLabel || '';
    // وقف الكل / شغّل الكل
    if (input.includes('وقف الكل') || input.includes('وقف كل')) {
      for (const p of ALL_PERMISSIONS) await setPerm(p.key, false, target);
      await sendWA(from, '❌ وقّفت كل الصلاحيات' + (targetLabel?' مع '+targetLabel:''));
      userState[from] = { step: 'idle' }; return;
    }
    if (input.includes('شغّل الكل') || input.includes('شغل الكل') || input.includes('شغّل كل')) {
      for (const p of ALL_PERMISSIONS) await setPerm(p.key, true, target);
      await sendWA(from, '✅ شغّلت كل الصلاحيات' + (targetLabel?' مع '+targetLabel:''));
      userState[from] = { step: 'idle' }; return;
    }
    const n = parseInt(input);
    if (n >= 1 && n <= ALL_PERMISSIONS.length) {
      const p = ALL_PERMISSIONS[n-1];
      const current = await isPermEnabled(p.key, target === 'all' ? null : target);
      const newVal = !current;
      await setPerm(p.key, newVal, target);
      await sendWA(from, (newVal?'✅ شغّلت':'❌ وقّفت') + ' ' + p.label + (targetLabel?' مع '+targetLabel:''));
      // أرسل القائمة محدّثة
      const perms = await getPermsStatus(target === 'all' ? null : target);
      await sendWA(from, buildPermsMsg(perms, targetLabel));
      return;
    }
    if (input === 'خلاص' || input === 'تمام' || input === 'وقف') {
      userState[from] = { step: 'idle' }; return;
    }
    await sendWA(from, '❓ أرسل رقم من 1 إلى ' + ALL_PERMISSIONS.length + ' أو "خلاص"');
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
    let nv      = msg.trim();
    if (field === 'time') {
      const p = await parseTask('مهمة الساعة ' + msg);
      if (p && p.time) nv = p.time;
      else {
        // جرب تحليل مباشر
        const timeMatch = msg.match(/(\d{1,2})(?::(\d{2}))?\s*(ص|صباح|م|مساء|عصر|ظهر|ليل)?/);
        if (timeMatch) {
          let h = parseInt(timeMatch[1]);
          const m = parseInt(timeMatch[2]||'0');
          const period = timeMatch[3]||'';
          if (period.includes('م')||period.includes('مساء')||period.includes('عصر')) { if(h<12) h+=12; }
          else if (period.includes('ص')||period.includes('صباح')) { if(h===12) h=0; }
          nv = String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
        } else { await sendWA(from, '❓ ما فهمت الوقت، مثال: "10 ونص" أو "2 العصر"'); return; }
      }
    } else if (field === 'date') {
      const p = await parseTask('مهمة في ' + msg);
      if (p && p.date) nv = p.date;
      else { await sendWA(from, '❓ ما فهمت التاريخ'); return; }
    }
    await pool.query('UPDATE tasks SET ' + field + '=$1 WHERE id=$2',[nv,t.id]);
    await sendWA(from, '✅ تم التعديل!\n📌 ' + t.title + (field==='time'?' — الساعة '+fmt12(nv):''));
    userState[from] = { step: 'idle' }; return;
  }

  if (state.step === 'waiting_file_details') {
    const fullRequest = (state.partialRequest || '') + ' — ' + msg;
    await sendWA(from, '⏳ أبني الملف...');
    try {
      const profile = await getProfile();
      const htmlContent = await buildHtmlFile(fullRequest, profile);
      if (!htmlContent) { await sendWA(from, 'ما قدرت أبني الملف، وضّح أكثر'); userState[from] = { step: 'idle' }; return; }
      const fileId = 'f' + Date.now();
      await pool.query('INSERT INTO html_files (id,owner,title,content) VALUES ($1,$2,$3,$4)', [fileId, from, fullRequest, htmlContent]);
      const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'https://mahami-production.up.railway.app';
      const link = baseUrl + '/f/' + fileId;
      userState[from] = { step: 'idle', lastGeneratedFile: { title: fullRequest, link, request: fullRequest, type: 'html', fileId } };
      await sendWA(from, '📄 جاهز!\n\n🔗 ' + link + '\n\nافتحه في المتصفح ✨\nلو تبي تعدّل قولي');
    } catch(e) { await sendWA(from, '❌ صار خطأ، جرب مرة ثانية'); userState[from] = { step: 'idle' }; }
    return;
  }

  userState[from] = { step: 'idle' };
  await handleOwner(from, msg);
}

// ─── Handle Wife ──────────────────────────────────────────────────────────
async function handleWife(from, msg) {
  try {
    // جلب اسم الزوجة من DB
    const contactRow = await pool.query('SELECT name FROM special_contacts WHERE phone=$1', [from]);
    let wifeName = (contactRow.rows.length && contactRow.rows[0].name && contactRow.rows[0].name !== 'الزوجة')
      ? contactRow.rows[0].name : null;

    // لو عرّفت نفسها — احفظ الاسم
    const nameMatch = msg.match(/اسمي\s+(\S+)/);
    if (nameMatch && nameMatch[1]) {
      wifeName = nameMatch[1];
      await pool.query('UPDATE special_contacts SET name=$1 WHERE phone=$2', [wifeName, from]);
    }

    const wifeDisplay = wifeName || 'أم عبدالعزيز';

    const prompt =
      'أنت "نواف" مساعد عبدالعزيز الشخصي على واتساب.\n' +
      'هذه زوجة عبدالعزيز' + (wifeName ? ' اسمها ' + wifeName : '') + '.\n' +
      'تعاملها بود وعفوية، مثل صديق قريب من العائلة.\n' +
      'تكلم بعامية نجدية أصيلة مريحة: "ابشري"، "لا والله"، "أي تفضلي"، "تمام"، "الله يعطيك العافية"\n' +
      'ممنوع: "تحت أمرش" (الصح: تحت أمرك)، "أبو عبدالعزيز" (هو زوجها مو كنيته)\n' +
      'ممنوع: الكلام الرسمي المبالغ فيه\n' +
      'لو قالت شي مثل "أنا بجهزها" رد طبيعي مثل "ابشري تفضلي" لا تسأل أسئلة إضافية ما طلبتها\n' +
      'لو قالت "تأخر" أو أي كلام عن تأخر عبدالعزيز — تعاطف معها وأخبرها راح تبلغ عبدالعزيز\n' +
      'رسالتها: "' + msg + '"\n\n' +
      'رد قصير وطبيعي (جملة أو جملتين فقط).';

    const reply = await callAI('claude-sonnet-4-20250514', 300, prompt);
    if (reply) await sendWA(from, reply);

    // أرسل كل رسائل الزوجة لعبدالعزيز
    await sendWA(PHONE, '📱 *رسالة من ' + wifeDisplay + ':*\n' + msg);

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
      const notif = await buildRequestNotifSmart(visitorName, from, pt.type, pt.title, pt.date, pt.time);
      await sendWA(PHONE, notif);
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

  // ─── طقس وعملات للزوار قبل التحليل ─────────────────────────────────────
  if (visitorName) {
    const lm = msg;
    const isWeather  = ['الجو','الطقس','حرارة','بارد','حار','درجة الحرارة'].some(function(w){ return lm.includes(w); });
    const isCurrency = ['سعر الدولار','سعر العملة','صرف الريال','سعر الريال'].some(function(w){ return lm.includes(w); });
    if (isWeather) {
      const data = await getWeather('Riyadh');
      if (data) {
        let reply = '';
        const temp = parseInt(data.temp);
        if (temp >= 38) reply = 'الجو برا عجاج وملاهيب — ' + data.temp + '\n';
        else if (temp >= 30) reply = 'الجو حار بره — ' + data.temp + '\n';
        else if (temp <= 15) reply = 'الجو برد بره — ' + data.temp + '\n';
        else reply = 'الجو حق فرة وكوب قهوة — ' + data.temp + '\n';
        reply += data.desc + '\nرطوبة: ' + data.humidity + ' | رياح: ' + data.wind;
        await sendWA(from, reply);
      } else { await sendWA(from, 'ما قدرت أجيب الطقس الحين، جرب بعدين'); }
      return;
    }
    if (isCurrency) {
      const rates = await getCurrencyRates();
      if (rates) await sendWA(from, 'دولار: ' + rates.USD + ' ر.س | يورو: ' + rates.EUR + ' ر.س | درهم: ' + rates.AED + ' ر.س');
      return;
    }
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
    if (!await isPermEnabled('tasks', from)) {
      const reply = await nawafVisitorReply(visitorName||'الزائر', msg, state.history);
      if (reply) await sendWA(from, reply);
      return;
    }
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
    if (!await isPermEnabled('meetings', from)) {
      const reply = await nawafVisitorReply(visitorName||'الزائر', msg, state.history);
      if (reply) await sendWA(from, reply);
      return;
    }
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

  // طلب بناء أو تعديل ملف من الزائر
  const fileKeywords = ['اعمل لي','سوّ لي','سوي لي','ابن لي','جدول','ملف','اكسل','excel','pdf','تقرير','خطة','قائمة'];
  const editKeywords = ['عدّل','غيّر','اضف','احذف','عدل في الملف','غير في الملف'];
  const wantsFile = fileKeywords.some(function(w){ return msg.includes(w); });
  const wantsEdit = editKeywords.some(function(w){ return msg.includes(w); });
  const vState    = userState[from] || {};

  if (wantsEdit && vState.lastVisitorFile) {
    await sendWA(from, '⏳ أعدّل...');
    const combined  = vState.lastVisitorFile.request + ' — تعديل: ' + msg;
    const fileData  = await buildFileFromRequest(combined, '');
    if (fileData && fileData.content) {
      const fp = await generateFile(fileData.type, fileData.content, vState.lastVisitorFile.filename);
      if (fp) {
        const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'https://mahami-production.up.railway.app';
        const link    = baseUrl + '/files/' + vState.lastVisitorFile.filename;
        userState[from] = Object.assign({}, vState, { lastVisitorFile: Object.assign({}, vState.lastVisitorFile, { request: combined }) });
        await sendWA(from, 'تم التعديل 😊\n\n🔗 ' + link);
        await sendWA(PHONE, '📎 ' + visitorName + ' طلب تعديل ملف وأرسلته له');
      } else { await sendWA(from, 'صار خطأ، جرب مرة ثانية'); }
    } else { await sendWA(from, 'ما قدرت أعدّل، وضّح أكثر'); }
    return;
  }

  if (wantsFile) {
    await sendWA(from, '⏳ أبني لك الملف...');
    const fileData = await buildFileFromRequest(msg, '');
    if (fileData && fileData.content) {
      const filename = 'visitor_' + from + '_' + Date.now() + '.' + (fileData.type === 'csv' ? 'csv' : fileData.type === 'html' ? 'html' : 'txt');
      const fp = await generateFile(fileData.type, fileData.content, filename);
      if (fp) {
        const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'https://mahami-production.up.railway.app';
        const link    = baseUrl + '/files/' + filename;
        userState[from] = Object.assign({}, vState, { lastVisitorFile: { filename, request: msg } });
        await sendWA(from, 'جاهز 😊\n\n📄 ' + (fileData.title || filename) + '\n\n🔗 ' + link + '\n\nلو تبي تعدّل قولي');
        await sendWA(PHONE, '📎 ' + visitorName + ' طلب ملف: "' + msg.substring(0,60) + '"');
      } else { await sendWA(from, 'صار خطأ، جرب مرة ثانية'); }
    } else { await sendWA(from, 'ما قدرت أبني الملف، وضّح أكثر'); }
    return;
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

app.get('/documents', async function(req,res) {
  try { res.json((await pool.query('SELECT * FROM documents ORDER BY expiry_date')).rows); } catch(e) { res.json([]); }
});
app.delete('/documents/:id', async function(req,res) {
  try { await pool.query('DELETE FROM documents WHERE id=$1',[req.params.id]); res.json({ok:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

// ─── عرض الملفات من DB ────────────────────────────────────────────────────
app.get('/f/:id', async function(req,res) {
  try {
    const r = await pool.query('SELECT * FROM html_files WHERE id=$1',[req.params.id]);
    if (!r.rows.length) return res.status(404).send('الملف غير موجود');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(r.rows[0].content);
  } catch(e) { res.status(500).send('خطأ'); }
});

// ─── OAuth Google ─────────────────────────────────────────────────────────
const OAUTH_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const OAUTH_REDIRECT      = 'https://mahami-production.up.railway.app/oauth/callback';

async function getOAuthClient() {
  const { google } = require('googleapis');
  return new google.auth.OAuth2(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT);
}

async function getOAuthToken() {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key='oauth_token'");
    return r.rows[0] ? JSON.parse(r.rows[0].value) : null;
  } catch(e) { return null; }
}

async function saveOAuthToken(token) {
  await pool.query("INSERT INTO settings (key,value) VALUES ('oauth_token',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [JSON.stringify(token)]);
}

// رابط تسجيل الدخول
app.get('/oauth/login', async function(req,res) {
  const client = await getOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/documents'
    ],
    prompt: 'consent'
  });
  res.redirect(url);
});

// Callback بعد تسجيل الدخول
app.get('/oauth/callback', async function(req,res) {
  try {
    const client = await getOAuthClient();
    const { tokens } = await client.getToken(req.query.code);
    await saveOAuthToken(tokens);
    res.send('<html><body dir="rtl" style="font-family:sans-serif;text-align:center;padding:50px"><h2>✅ تم ربط Google Drive بنجاح!</h2><p>الآن كل ملف سيُحفظ مباشرة في Drive عبدالعزيز</p></body></html>');
    await sendWA(PHONE, '✅ تم ربط Google Drive! الآن الملفات تُحفظ مباشرة في Drive.');
  } catch(e) {
    console.error('OAuth callback error:', e.message);
    res.send('خطأ في تسجيل الدخول: ' + e.message);
  }
});

// حفظ ملف في Drive بحساب عبدالعزيز
async function saveFileToDrive(title, htmlContent, type) {
  try {
    const token = await getOAuthToken();
    if (!token) return null;
    const { google } = require('googleapis');
    const client = await getOAuthClient();
    client.setCredentials(token);
    client.on('tokens', async function(newTokens) {
      await saveOAuthToken(Object.assign({}, token, newTokens));
    });
    const drive = google.drive({ version: 'v3', auth: client });

    let fileId;

    if (type === 'sheet') {
      // للجداول: استخدم Sheets API مباشرة
      const sheets = google.sheets({ version: 'v4', auth: client });

      // استخرج البيانات من الـ HTML
      const tableMatch = htmlContent.match(/<table[^>]*id="mainTable"[^>]*>([\s\S]*?)<\/table>/i);
      let values = [];
      if (tableMatch) {
        const rows = tableMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
        values = rows.map(function(row) {
          const cells = row.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [];
          return cells.map(function(cell) {
            return cell.replace(/<[^>]+>/g, '').replace(/&nbsp;/g,' ').trim();
          });
        });
      }

      // أنشئ Spreadsheet
      const ss = await sheets.spreadsheets.create({
        requestBody: { properties: { title } }
      });
      fileId = ss.data.spreadsheetId;

      // أضف البيانات
      if (values.length > 0) {
        // جيب اسم الشيت الأول
        const ssData = await sheets.spreadsheets.get({ spreadsheetId: fileId });
        const sheetName = ssData.data.sheets[0].properties.title;
        await sheets.spreadsheets.values.update({
          spreadsheetId: fileId,
          range: sheetName + '!A1',
          valueInputOption: 'RAW',
          requestBody: { values }
        });
      }

      // انقل للفولدر
      try {
        await drive.files.update({
          fileId,
          addParents: DRIVE_FOLDER_ID,
          fields: 'id'
        });
      } catch(e2) { console.error('Move folder:', e2.message); }

      console.log('✅ Sheet created:', fileId);
      return 'https://docs.google.com/spreadsheets/d/' + fileId;

    } else {
      // للمستندات: رفع HTML
      const file = await drive.files.create({
        requestBody: { name: title, mimeType: 'application/vnd.google-apps.document' },
        media: { mimeType: 'text/html', body: htmlContent },
        fields: 'id,parents'
      });
      fileId = file.data.id;
      console.log('✅ Doc created:', fileId);

      try {
        const prevParents = (file.data.parents || []).join(',');
        await drive.files.update({
          fileId,
          addParents: DRIVE_FOLDER_ID,
          removeParents: prevParents,
          fields: 'id'
        });
      } catch(e2) { console.error('Move folder:', e2.message); }

      return 'https://docs.google.com/document/d/' + fileId;
    }
  } catch(e) {
    console.error('saveFileToDrive:', e.message);
    return null;
  }
}

app.get('/', function(req,res) {
  res.json({ status:'مهامي شغّال', time: new Date().toLocaleString('ar-SA') });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('مهامي على port ' + PORT); });

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

// ذاكرة المحادثة: آخر 10 رسائل لكل مستخدم
const conversationHistory = {};

function addToHistory(from, role, content) {
  if (!conversationHistory[from]) conversationHistory[from] = [];
  conversationHistory[from].push({ role, content });
  // احتفظ بآخر 10 رسائل فقط (5 من كل طرف)
  if (conversationHistory[from].length > 10) {
    conversationHistory[from] = conversationHistory[from].slice(-10);
  }
}

function getHistory(from) {
  return conversationHistory[from] || [];
}

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
  // التاريخ بتوقيت الرياض (UTC+3)
  const now = new Date();
  const riyadh = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return riyadh.toISOString().split('T')[0];
}

function nowRiyadh() {
  const now = new Date();
  return new Date(now.getTime() + 3 * 60 * 60 * 1000);
}

function buildTaskMsg(t) {
  const icons = { meeting: '📅 اجتماع', task: '✅ مهمة', reminder: '🔔 تذكير' };
  const h = nowRiyadh().getHours();
  const gr = h < 12 ? 'صباح الخير' : h < 17 ? 'مساء الخير' : 'مساء النور';
  let msg = `${gr} عبدالعزيز 🌟\n\n`;
  msg += `${icons[t.type] || '📌 مهمة'}\n`;
  msg += `📌 *${t.title}*\n`;
  msg += `⏰ ${fmt12(t.time)}\n`;
  if (t.note) msg += `📝 ${t.note}\n`;
  if (t.location) msg += `📍 ${t.location}\n`;
  msg += `\n─────────────\n`;
  msg += `رد بـ *منجز* لتأكيد الإنجاز\n`;
  msg += `رد بـ *تأجيل* لتأجيلها ساعة\n`;
  msg += `\n_مهامي_ ✨`;
  return msg;
}

// ===== دالة الذكاء الاصطناعي الرئيسية - مع سياق + تواريخ عربية + محادثة طبيعية =====
async function claudeSmartReply(from, userMsg, tasks) {
  try {
    const now = nowRiyadh();
    const todayISO = todayStr();
    const dayNames = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
    const todayName = dayNames[now.getDay()];
    const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    const tasksList = tasks.length > 0
      ? tasks.map(t => `- ${t.title} (${t.type}) | ${t.date} | ${fmt12(t.time)}${t.location ? ' | ' + t.location : ''}`).join('\n')
      : 'لا توجد مهام معلقة';

    const systemPrompt = `أنت مساعد ذكي اسمك "مهامي" تساعد عبدالعزيز في إدارة مهامه عبر واتساب.

📅 معلومات الوقت الآن:
- اليوم: ${todayName} ${todayISO}
- الوقت الحالي: ${currentTime} (توقيت الرياض)

📋 المهام المعلقة حالياً:
${tasksList}

🎯 مهمتك:
أنت تفهم الرسائل العربية الطبيعية وترد بذكاء. حدد نية المستخدم وأعد JSON فقط بهذا الشكل:

{
  "intent": "add_task | complete_task | postpone_task | delete_task | edit_task | list_tasks | chat | help",
  "reply": "ردك الطبيعي بالعربي هنا",
  "task": {
    "title": "عنوان المهمة",
    "type": "task | meeting | reminder",
    "date": "YYYY-MM-DD أو null",
    "time": "HH:MM أو null",
    "note": "ملاحظة أو فارغة",
    "location": "موقع أو فارغ"
  }
}

📌 قواعد التواريخ (عربية وميلادية):
- "بكرة" أو "غداً" = ${new Date(now.getTime() + 24*60*60*1000).toISOString().split('T')[0]}
- "بعد كم" أو "الأسبوع الجاي" = ${new Date(now.getTime() + 7*24*60*60*1000).toISOString().split('T')[0]}
- "بعد ثلاثين دقيقة" أو "بعد نص ساعة" = احسب من ${currentTime}
- أيام الأسبوع: إذا قال "الخميس" ابحث عن أقرب خميس قادم
- "الصبح" = 08:00، "الضحى" = 10:00، "الظهر" = 12:00، "العصر" = 15:30، "المغرب" = 18:30، "العشاء" = 20:00
- تواريخ ميلادية: "25/3" أو "25-3" أو "25 مارس" أو "March 25" أو "3/25" = ${now.getFullYear()}-03-25 (السنة الحالية ${now.getFullYear()} إذا لم تُذكر)
- إذا ذُكر تاريخ كامل مثل "2026-05-10" أو "10/5/2026" استخدمه مباشرة

📌 قواعد النوع:
- اجتماع/لقاء/مقابلة → meeting
- تذكير/ذكرني → reminder
- غير ذلك → task

📌 قواعد النية:
- إذا كانت رسالة عادية غير مرتبطة بالمهام → intent: "chat" وارد بشكل طبيعي
- إذا طلب قائمة مهامه → intent: "list_tasks"
- إذا أراد إضافة مهمة → intent: "add_task"

مهم: أعد JSON فقط بدون أي نص خارجه أو markdown.`;

    const history = getHistory(from);
    const messages = [
      ...history,
      { role: 'user', content: userMsg }
    ];

    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: systemPrompt,
      messages
    }, {
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    });

    const text = response.data.content[0].text.trim().replace(/```json|```/g, '').trim();
    const result = JSON.parse(text);

    // احفظ في السياق
    addToHistory(from, 'user', userMsg);
    addToHistory(from, 'assistant', result.reply || '');

    return result;
  } catch(e) {
    console.error('Claude Error:', e.message);
    return null;
  }
}

// ===== دالة استخراج المهمة (للاستخدام في خطوات الانتظار) =====
async function parseTaskFromMessage(msg) {
  try {
    const now = nowRiyadh();
    const todayISO = todayStr();
    const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `اليوم هو ${todayISO} والوقت الحالي ${currentTime} (توقيت الرياض).

استخرج معلومات المهمة وأعد JSON فقط:
{"title":"عنوان","type":"task|meeting|reminder","date":"YYYY-MM-DD أو null","time":"HH:MM أو null","note":""}

قواعد التواريخ (عربية وميلادية):
- "بكرة/غداً" = ${new Date(now.getTime() + 24*60*60*1000).toISOString().split('T')[0]}
- "بعد X دقيقة/ساعة" = احسب من الوقت الحالي ${currentTime}
- "الصبح"=08:00, "الضحى"=10:00, "الظهر"=12:00, "العصر"=15:30, "المغرب"=18:30, "العشاء"=20:00
- تواريخ ميلادية مختصرة مثل "25/3" أو "25 مارس" أو "March 25" = السنة الحالية ${now.getFullYear()} مع الشهر واليوم
- تاريخ كامل مثل "2026-05-10" أو "10/5/2026" استخدمه مباشرة
- اجتماع/لقاء/مقابلة → meeting, تذكير/ذكرني → reminder, غير ذلك → task

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

// ===== CRON: إرسال التذكيرات =====
cron.schedule('* * * * *', async () => {
  const today = todayStr();
  const now = nowRiyadh();
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

// ===== WEBHOOK: معالجة رسائل واتساب =====
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  const msg  = body?.data?.body?.trim();
  const from = body?.data?.from;
  if (!msg || !from) return;
  console.log(`📩 رسالة: ${msg}`);

  const state = userState[from] || { step: 'idle' };

  // ===== خطوات الانتظار (لا تمر على AI الرئيسي) =====

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
        await sendWA(from, `✅ تم تسجيل المهمة!\n\n📌 *${state.taskTitle}*\n⏰ ${fmt12(parsed.time)}\n📅 ${parsed.date}\n\nسأذكرك في الوقت المحدد 🔔`);
        userState[from] = { step: 'idle' };
      }
    } else {
      await sendWA(from, `❓ ما فهمت الوقت. جرب مثلاً:\n"بكرة العصر"\n"الخميس الساعة 10 الصبح"\n"بعد ساعتين"`);
    }
    return;
  }

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

  if (state.step === 'waiting_done_selection') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
      const t = state.tasks[num - 1];
      await pool.query('UPDATE tasks SET done=true WHERE id=$1', [t.id]);
      await sendWA(from, `✅ ممتاز عبدالعزيز!\n\n*${t.title}* تم تحديدها كمنجزة 🎉`);
      userState[from] = { step: 'idle' };
    } else {
      await sendWA(from, `❓ أرسل رقم المهمة فقط`);
    }
    return;
  }

  if (state.step === 'waiting_postpone_selection') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
      const t = state.tasks[num - 1];
      const [h, m] = t.time.split(':').map(Number);
      const d = new Date(); d.setHours(h + 1, m);
      const newTime = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      await pool.query('UPDATE tasks SET time=$1 WHERE id=$2', [newTime, t.id]);
      sentReminders.delete(t.id);
      await sendWA(from, `⏰ تم تأجيل *${t.title}* لـ ${fmt12(newTime)}`);
      userState[from] = { step: 'idle' };
    } else {
      await sendWA(from, `❓ أرسل رقم المهمة فقط`);
    }
    return;
  }

  if (state.step === 'waiting_delete_selection') {
    const num = parseInt(msg);
    if (!isNaN(num) && num >= 1 && num <= state.tasks.length) {
      const t = state.tasks[num - 1];
      await pool.query('DELETE FROM tasks WHERE id=$1', [t.id]);
      sentReminders.delete(t.id);
      await sendWA(from, `🗑️ تم حذف *${t.title}* بنجاح`);
      userState[from] = { step: 'idle' };
    } else {
      await sendWA(from, `❓ أرسل رقم المهمة فقط`);
    }
    return;
  }

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
      await sendWA(from, `❓ أرسل رقم صحيح`);
    }
    return;
  }

  if (state.step === 'waiting_edit_field') {
    const num = parseInt(msg);
    const t = state.task;
    const fields = { 1: 'title', 2: 'time', 3: 'date', 4: 'note', 5: 'location' };
    const labels = { 1: 'العنوان الجديد', 2: 'الوقت الجديد (مثال: العصر أو 15:00)', 3: 'التاريخ الجديد (مثال: بكرة أو 2026-03-15)', 4: 'الملاحظة الجديدة', 5: 'الموقع الجديد' };
    if (fields[num] && (num !== 5 || t.type === 'meeting')) {
      userState[from] = { step: 'waiting_edit_value', task: t, field: fields[num] };
      await sendWA(from, `✏️ أرسل ${labels[num]}:`);
    } else {
      await sendWA(from, `❓ أرسل رقم صحيح من القائمة`);
    }
    return;
  }

  if (state.step === 'waiting_edit_value') {
    const t = state.task;
    const field = state.field;
    let newValue = msg;
    if (field === 'time' || field === 'date') {
      const parsed = await parseTaskFromMessage(`مهمة ${field === 'time' ? msg : 'في ' + msg}`);
      if (field === 'time' && parsed && parsed.time) newValue = parsed.time;
      else if (field === 'date' && parsed && parsed.date) newValue = parsed.date;
      else {
        await sendWA(from, `❓ ما فهمت. جرب مثلاً:\n${field === 'time' ? '"العصر" أو "15:00" أو "بعد ساعة"' : '"بكرة" أو "الخميس" أو "2026-03-15"'}`);
        return;
      }
    }
    await pool.query(`UPDATE tasks SET ${field}=$1 WHERE id=$2`, [newValue, t.id]);
    const fieldNames = { title: 'العنوان', time: 'الوقت', date: 'التاريخ', note: 'الملاحظة', location: 'الموقع' };
    await sendWA(from, `✅ تم تعديل ${fieldNames[field]} بنجاح!\n\n📌 *${field === 'title' ? newValue : t.title}*\n${field === 'time' ? `⏰ ${fmt12(newValue)}` : field === 'date' ? `📅 ${newValue}` : ''}`);
    userState[from] = { step: 'idle' };
    return;
  }

  // ===== المعالج الذكي الرئيسي =====
  try {
    const tasksResult = await pool.query('SELECT * FROM tasks WHERE done=false ORDER BY date, time LIMIT 10');
    const tasks = tasksResult.rows;

    const aiResult = await claudeSmartReply(from, msg, tasks);

    if (!aiResult) {
      await sendWA(from, `❓ صارت مشكلة. جرب مرة ثانية أو أرسل *مساعدة*`);
      return;
    }

    const { intent, reply, task } = aiResult;

    // --- محادثة عادية ---
    if (intent === 'chat') {
      await sendWA(from, reply);
      return;
    }

    // --- مساعدة ---
    if (intent === 'help') {
      await sendWA(from, `📖 *أوامر مهامي:*\n\n• أرسل أي مهمة بكلام عادي مثل:\n  "اجتماع مع الفريق بكرة العصر"\n  "ذكرني أدفع الفاتورة الخميس الصبح"\n\n• *مهامي* - عرض المهام المعلقة\n• *منجز* - تحديد مهمة كمنجزة\n• *تأجيل* - تأجيل مهمة ساعة\n• *عدل* - تعديل مهمة\n• *احذف* - حذف مهمة\n• *مساعدة* - عرض هذه القائمة\n\nبإمكانك تكلمني بشكل طبيعي 😊`);
      return;
    }

    // --- قائمة المهام ---
    if (intent === 'list_tasks') {
      if (tasks.length === 0) { await sendWA(from, reply || '📋 لا توجد مهام معلقة حالياً ✅'); return; }
      let list = '📋 *مهامك المعلقة:*\n\n';
      tasks.forEach((t, i) => {
        const icon = t.type === 'meeting' ? '📅' : t.type === 'reminder' ? '🔔' : '✅';
        list += `${i+1}. ${icon} *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`;
      });
      await sendWA(from, list);
      return;
    }

    // --- إنجاز مهمة ---
    if (intent === 'complete_task') {
      if (tasks.length === 0) { await sendWA(from, '📋 لا توجد مهام معلقة ✅'); return; }
      if (tasks.length === 1) {
        await pool.query('UPDATE tasks SET done=true WHERE id=$1', [tasks[0].id]);
        await sendWA(from, `✅ ممتاز عبدالعزيز!\n\n*${tasks[0].title}* تم تحديدها كمنجزة 🎉`);
        return;
      }
      let list = '✅ *أي مهمة أنجزت؟*\n\n';
      tasks.forEach((t, i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
      list += `أرسل الرقم فقط`;
      await sendWA(from, list);
      userState[from] = { step: 'waiting_done_selection', tasks };
      return;
    }

    // --- تأجيل مهمة ---
    if (intent === 'postpone_task') {
      if (tasks.length === 0) { await sendWA(from, '📋 لا توجد مهام معلقة ✅'); return; }
      if (tasks.length === 1) {
        const t = tasks[0];
        const [h, m] = t.time.split(':').map(Number);
        const d = new Date(); d.setHours(h + 1, m);
        const newTime = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        await pool.query('UPDATE tasks SET time=$1 WHERE id=$2', [newTime, t.id]);
        sentReminders.delete(t.id);
        await sendWA(from, reply || `⏰ تم تأجيل *${t.title}* لـ ${fmt12(newTime)}`);
        return;
      }
      let list = '⏰ *أي مهمة تريد تأجيلها؟*\n\n';
      tasks.forEach((t, i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
      list += `أرسل الرقم فقط`;
      await sendWA(from, list);
      userState[from] = { step: 'waiting_postpone_selection', tasks };
      return;
    }

    // --- حذف مهمة ---
    if (intent === 'delete_task') {
      if (tasks.length === 0) { await sendWA(from, '📋 لا توجد مهام لحذفها ✅'); return; }
      if (tasks.length === 1) {
        await pool.query('DELETE FROM tasks WHERE id=$1', [tasks[0].id]);
        sentReminders.delete(tasks[0].id);
        await sendWA(from, reply || `🗑️ تم حذف *${tasks[0].title}* بنجاح`);
        return;
      }
      let list = '🗑️ *أي مهمة تريد حذفها؟*\n\n';
      tasks.forEach((t, i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
      list += `أرسل الرقم فقط`;
      await sendWA(from, list);
      userState[from] = { step: 'waiting_delete_selection', tasks };
      return;
    }

    // --- تعديل مهمة ---
    if (intent === 'edit_task') {
      if (tasks.length === 0) { await sendWA(from, '📋 لا توجد مهام لتعديلها ✅'); return; }
      if (tasks.length === 1) {
        const t = tasks[0];
        userState[from] = { step: 'waiting_edit_field', task: t };
        let opts = `✏️ *تعديل: ${t.title}*\n\nاختر ماذا تريد تعديله:\n\n1. العنوان\n2. الوقت\n3. التاريخ\n4. الملاحظة`;
        if (t.type === 'meeting') opts += `\n5. الموقع`;
        opts += `\n\nأرسل الرقم فقط`;
        await sendWA(from, opts);
        return;
      }
      let list = '✏️ *أي مهمة تريد تعديلها؟*\n\n';
      tasks.forEach((t, i) => { list += `${i+1}. *${t.title}*\n   ⏰ ${fmt12(t.time)} - ${t.date}\n\n`; });
      list += `أرسل الرقم فقط`;
      await sendWA(from, list);
      userState[from] = { step: 'waiting_edit_selection', tasks };
      return;
    }

    // --- إضافة مهمة جديدة ---
    if (intent === 'add_task' && task && task.title) {
      if (!task.date || !task.time) {
        userState[from] = { step: 'waiting_datetime', taskTitle: task.title, taskType: task.type||'task', taskNote: task.note||'' };
        const icon = task.type === 'meeting' ? '📅' : task.type === 'reminder' ? '🔔' : '📌';
        let question = `${icon} فاهم إنك تبي تضيف:\n*${task.title}*\n\n`;
        if (!task.date && !task.time) question += `❓ متى وفي أي وقت؟\nمثال: "بكرة العصر" أو "الخميس الساعة 10"`;
        else if (!task.date) question += `❓ في أي يوم؟`;
        else question += `❓ في أي وقت؟`;
        await sendWA(from, question);
        return;
      }
      if (task.type === 'meeting') {
        userState[from] = { step: 'waiting_location', taskTitle: task.title, taskType: 'meeting', taskNote: task.note||'', date: task.date, time: task.time };
        await sendWA(from, `📍 أين موقع الاجتماع؟\nأرسل رابط قوقل ماب أو اسم المكان\nأو أرسل *تخطي* إذا لم يكن محدداً`);
      } else {
        const id = Date.now();
        await pool.query('INSERT INTO tasks (id, title, type, date, time, note, location) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [id, task.title, task.type||'task', task.date, task.time, task.note||'', task.location||'']);
        const icon = task.type === 'reminder' ? '🔔' : '✅';
        await sendWA(from, reply || `${icon} تم تسجيل ${task.type === 'reminder' ? 'التذكير' : 'المهمة'}!\n\n📌 *${task.title}*\n⏰ ${fmt12(task.time)}\n📅 ${task.date}\n\nسأذكرك في الوقت المحدد 🔔`);
        console.log(`✨ ${task.type} جديد: ${task.title}`);
      }
      return;
    }

    // fallback
    await sendWA(from, reply || `❓ ما فهمت. أرسل *مساعدة* لعرض الأوامر`);

  } catch(e) {
    console.error('Webhook error:', e.message);
    await sendWA(from, `❓ صارت مشكلة تقنية. جرب مرة ثانية`);
  }
});

// ===== REST API =====
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
app.listen(PORT, () => {
  console.log(`🚀 مهامي سيرفر شغّال على port ${PORT}`);

  // ===== Self-ping كل 10 دقايق حتى ما ينام السيرفر =====
  const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;

  cron.schedule('*/10 * * * *', async () => {
    try {
      await axios.get(SELF_URL);
      console.log('💓 self-ping OK');
    } catch(e) {
      console.log('💓 self-ping failed:', e.message);
    }
  });
});

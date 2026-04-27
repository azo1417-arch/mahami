# 🔧 حل مشكلة Internal Server Error

## المشكلة:
```
{"error":"Internal Server Error"}
```

## الأسباب المحتملة:
1. ملف الداشبورد ما موجود في `public/`
2. قاعدة البيانات ما متصلة صح
3. متغيرات البيئة ناقصة

## الحل الكامل:

### 1️⃣ تأكد من الملفات في المشروع:

```bash
ls -la
# يجب تشوف:
# - server.js ✅
# - package.json ✅
# - .env ✅
# - public/ ✅

ls -la public/
# يجب تشوف:
# - dashboard_riyadh.html ✅
# - kanban_professional.html ✅
# - الملفات الأخرى
```

### 2️⃣ إذا الملفات ناقصة:

```bash
# أنشئ المجلد public
mkdir -p public

# انسخ الملفات:
# 1. انسخ dashboard_riyadh.html في public/
# 2. تأكد من وجود kanban_professional.html
```

### 3️⃣ تأكد من .env:

```bash
cat .env
# يجب تشوف:
DATABASE_URL=postgresql://...  ✅
PORT=3000                       ✅
GREEN_TOKEN=...                 ✅
INSTANCE_ID=...                 ✅
OWNER_PHONE=966...              ✅
```

### 4️⃣ إعادة تشغيل:

```bash
# شغّل السيرفر محلياً أولاً:
npm install
npm start

# اختبر في متصفحك:
# http://localhost:3000/health
# http://localhost:3000/dashboard
```

### 5️⃣ إذا في خطأ في السجلات:

```bash
# اقرأ الخطأ بعناية
# مثلاً:
# - "Cannot find module" = ملف ناقص
# - "ENOENT" = ملف ما موجود
# - "connection refused" = قاعدة البيانات ما تشتغل
```

### 6️⃣ Push للـ Railway:

```bash
git add .
git commit -m "fix: add missing files and fix server"
git push

# انتظر 1-2 دقيقة للنشر
```

---

## الملفات الأساسية الواجبة:

```
mahami/
├── server.js                    ✅ (من server_COPY_THIS.js)
├── package.json                 ✅ (محدّث)
├── .env                         ✅ (مع البيانات الصحيحة)
└── public/
    ├── dashboard_riyadh.html    ✅ (مهم جداً!)
    ├── kanban_professional.html ✅ (موجود في GitHub)
    └── ... ملفات أخرى
```

---

## إذا الخطأ استمر:

```bash
# 1. شغّل السيرفر محلياً واقرأ الخطأ:
npm start

# 2. تأكد من قاعدة البيانات:
psql mahami -c "SELECT 1"

# 3. تأكد من NODE_ENV:
echo $NODE_ENV

# 4. حاول حذف node_modules وإعادة التثبيت:
rm -rf node_modules package-lock.json
npm install
npm start
```


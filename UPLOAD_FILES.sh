#!/bin/bash

# ╔════════════════════════════════════════════════════════════════╗
# ║         تحميل الملفات الناقصة إلى GitHub                      ║
# ║                                                                ║
# ║  هذا السكريبت يساعدك تحمّل الملفات من /outputs                ║
# ╚════════════════════════════════════════════════════════════════╝

echo "📋 الملفات المطلوب تحميلها:"
echo ""
echo "1️⃣  server_FINAL.js       → server.js (في الجذر)"
echo "2️⃣  dashboard_riyadh.html → public/dashboard_riyadh.html"
echo "3️⃣  package.json          → package.json (في الجذر)"
echo ""

echo "⚡ الخطوات:"
echo ""
echo "# 1. انسخ server_FINAL.js من /outputs"
echo "# 2. انسخه في مشروعك وسميه server.js"
echo ""
echo "# 3. احذف server.js القديم:"
echo "cd mahami"
echo "rm server.js"
echo ""
echo "# 4. ضع الملف الجديد:"
echo "# انسخ server_FINAL.js وسميه server.js"
echo ""
echo "# 5. أنشئ مجلد public إذا ما موجود:"
echo "mkdir -p public"
echo ""
echo "# 6. انسخ dashboard_riyadh.html في public/"
echo "cp dashboard_riyadh.html public/"
echo ""
echo "# 7. حدّث package.json (من /outputs)"
echo ""
echo "# 8. تأكد من .env صحيح"
echo ""
echo "# 9. Push:"
echo "git add ."
echo "git commit -m 'add: dashboard and final server version'"
echo "git push"
echo ""
echo "======================================================"
echo "✅ بعدها Railway سيعيد النشر تلقائياً خلال 1-2 دقيقة"
echo "======================================================"


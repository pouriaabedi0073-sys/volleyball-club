# راهنمای مهاجرت پروژه

## مرحله اول: مسیرهای نسبی ✅

**تمام مسیرها به صورت نسبی تنظیم شدند**. پروژه اکنون می‌تواند در هر جایی اجرا شود.

## مرحله دوم: تنظیم Supabase Credentials

### دو روش وجود دارد:

#### روش 1: استفاده از config.js (توصیه‌شده)
1. `config.example.js` را کپی کنید به `config.js`
2. Supabase credentials خود را وارد کنید
3. در `index.html` این خط را اضافه کنید (قبل از سایر script‌ها):

```html
<script src="./config.js"></script>
```

#### روش 2: تنظیم مستقیم در index.html
در `index.html` قبل از بقیه script‌ها اضافه کنید:

```html
<script>
  window.SUPABASE_URL = 'https://your-project.supabase.co';
  window.SUPABASE_ANON_KEY = 'your-anon-key';
</script>
```

## مرحله سوم: آپلود پروژه

اکنون می‌توانید:
- بر روی هر سرور استقرار دهید
- در subdirectory قرار دهید
- در localhost اجرا کنید
- درون APK/Cordova بسته‌بندی کنید

## تست محلی

```bash
# Python 3
cd /path/to/project
python -m http.server 5500

# یا Node.js
npx http-server -p 5500
```

سپس به `http://localhost:5500` بروید

## مسائل معمول

### ❌ "Cannot find module 'supabase'"
**راه‌حل**: اطمینان دهید که Supabase SDK در index.html لود شده است:
```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
```

### ❌ "SUPABASE_URL is undefined"
**راه‌حل**: مطمئن شوید config.js یا script credentials در index.html قرار دارد

### ❌ Service Worker فعال نشد
**راه‌حل**: صفحه را refresh کنید (HTTPS لازم است اگر production است)

## فایل‌های اهم

- `index.html` - فایل اصلی
- `service-worker.js` - PWA service worker
- `manifest.json` - PWA manifest (مسیرهای نسبی)
- `sw-register.js` - service worker registration
- `backup.js` - مدیریت بک‌آپ
- `sync-backup.js` - sync Supabase
- `config.example.js` - کپی این فایل به config.js و تنظیم کنید

## بررسی تصحیحات

تمام این فایل‌ها تصحیح شدند:
- ✅ service-worker.js
- ✅ manifest.json
- ✅ manifest.webmanifest
- ✅ sw.js
- ✅ sync-backup.js
- ✅ supabase-confirm-email.html
- ✅ supabase-recovery-email.html
- ✅ tools/*.ps1 (PowerShell scripts)

برای جزئیات دیگر، [RELATIVE_PATHS_MIGRATION.md](./RELATIVE_PATHS_MIGRATION.md) را مطالعه کنید.

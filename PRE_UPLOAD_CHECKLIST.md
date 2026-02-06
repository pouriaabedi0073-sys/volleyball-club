# ✅ Checklist - مهاجرت مسیرهای نسبی

## فایل‌های بررسی شده

- [x] **service-worker.js** - همه `/volleyball/` → `./`
- [x] **manifest.json** - start_url, scope, icons نسبی
- [x] **manifest.webmanifest** - همه URLs نسبی
- [x] **sw.js** - `/assets/` → `./assets/`
- [x] **index.html** - base href, manifest.json, supabase.min.js
- [x] **sync-backup.js** - hardcoded URLs حذف شدند
- [x] **supabase-confirm-email.html** - base href و URLs
- [x] **supabase-recovery-email.html** - base href اضافه شد
- [x] **tools_check_braces.ps1** - hardcoded path → نسبی
- [x] **tools/check_braces.ps1** - hardcoded path → نسبی
- [x] **tools/check_try_balance.ps1** - hardcoded path → نسبی

## فایل‌های جدید ایجاد شده

- [x] **config.example.js** - نمونه config Supabase
- [x] **RELATIVE_PATHS_MIGRATION.md** - جزئیات تغییرات
- [x] **MIGRATION_GUIDE_FA.md** - راهنمای مهاجرت فارسی
- [x] **COMPLETION_SUMMARY.md** - خلاصهٔ نهایی

## آماده‌سازی قبل از آپلود

- [ ] `config.example.js` را `config.js` کپی کنید
- [ ] Supabase URL و ANON_KEY در `config.js` تنظیم کنید
- [ ] `<script src="./config.js"></script>` را در `index.html` اضافه کنید
- [ ] پروژه را محلی تست کنید: `python -m http.server 5500`
- [ ] Service Worker اجرا می‌شود
- [ ] Supabase به درستی متصل می‌شود
- [ ] آیکون‌ها و assets لود می‌شوند

## تست Production

- [ ] PWA manifest درست لود می‌شود
- [ ] Service Worker نصب می‌شود
- [ ] آفلاین mode کار می‌کند
- [ ] Supabase sync کار می‌کند
- [ ] بک‌آپ و restore کار می‌کند

---

**حالت**: ✅ **آماده برای آپلود**

تمام مسیرهای hardcoded تبدیل به نسبی شدند.

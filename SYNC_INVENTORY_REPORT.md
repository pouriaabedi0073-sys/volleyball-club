# گزارش جامع همگام‌سازی — پروژه Volleyball Club

تاریخ: 2025-10-15
نویسنده: خودکار (خلاصه از کد موجود)

این گزارش جمع‌بندی کاملِ موجودی (inventory) و بررسی مسیرهای مرتبط با همگام‌سازی داده‌ها و ارتباط با Supabase در این مخزن است. هدف: ارائه‌ی نقشهٔ دقیق از فایل‌ها، توابع، جداول و نقاطی که نیاز به بازبینی امنیتی/عملیاتی دارند، همراه با پیشنهادات عملی.

---

## 1) ساختار کد همگام‌سازی

خلاصهٔ سطح بالا:
- محیط: PWA (browser) با استفاده از Supabase (Postgres + PostgREST + Realtime + Storage).
- الگوها: صف محلی برای عملیات آفلاین، upsert-first برای به‌روزرسانی‌ها، sanitization کلاینتی (camelCase→snake_case، تبدیل تاریخ‌های جلالی به ISO، کوئرسیون عدد/بولین/JSON)، runtime patch برای `supabase.from()`، و یک fetch wrapper دفاعی برای REST.

فایل‌های کلیدی و نقش‌شان:

- `sync-hybrid.js`
  - نقش: قلب سیستم همگام‌سازی هیبریدی (local-first). شامل صف محلی، executor/flush logic، backupNow (ساخت snapshot و آپلود به Storage)، makeTableAPI (create/update/remove/reload برای هر جدول)، sanitizers و patch runtime برای supabase client.
  - توابع اصلی:
    - `enqueueOp(op)`, `loadQueue()`, `saveQueue()` — مدیریت صف محلی
    - `flushQueue(client)` — اجرای صف: برای `update` تلاش به `upsert(..., {onConflict})` (onConflict از `getConflictKey(table)`) و fallbackِ محافظه‌کارانه به `update().eq('id', ...)`
    - `sanitizeRowForTable(table, row)` — alias map (camel→snake)، `toISO()` برای تاریخ‌ها، `coerceNumber`, `coerceBoolean`, `ensureJSON` و تبدیل تاریخ‌های Jalali
    - `makeTableAPI(table)` — تولید API جدول با `create`, `update` (upsert-first), `remove`, `reload`
    - `backupNow(options)` — ساخت snapshot محلی/سروری، آپلود به Storage (`backups` bucket)، درج متادیتا در جدول `backups` و upsert در `shared_backups` برای کشف گروهی
    - `subscribeTableRealtime(...)` — ساخت کانال realtime و merge ورودی‌ها به `window.state`
    - `ensureSupabasePatched()` — patch کردن builder‌های `insert`, `update`, `select` برای sanitization خودکار

- `sync-supabase.js`
  - نقش: لایهٔ کوچک و مستقل برای realtime و CRUD با Supabase. استفاده برای اشتراک‌ها و عملیات همگام‌سازی ظریف.
  - توابع اصلی:
    - `init(ctx)`, `create(obj)`, `update(id, patch)` — update از طریق `upsert(..., {onConflict})` با conflict map
    - `remove(id)`, `mergeRow(row, eventType)`, `writeLastSyncMetadata(row)`
  - conflictMap مثال: `devices: ['user_id','device_id']`, `shared_backups: ['group_email']`, `profiles: ['id']`.

- `index.html` (بخش‌های JavaScript درون صفحه)
  - نقش: wiring UI → Supabase client → sync modules. ایجاد و مقداردهی `window.supabase`, نصب fetch/XHR wrappers، دکمهٔ "همگام‌سازی الآن" که `window.syncHybrid.backupNow()` را فراخوانی می‌کند، و توابع مدیریت پروفایل/دستگاه
  - نکات کلیدی:
    - global fetch wrapper: برای درخواست‌های به SUPABASE_URL هدر `apikey` را اضافه می‌کند و در مورد `PATCH /rest/v1/<table>` اگر query نداشته باشد و بدنه شامل `id` باشد، پارامتر `?id=eq.<id>` را اضافه می‌کند (دفاع در برابر PATCH بدون WHERE)
    - XMLHttpRequest wrapper fallback برای محیط‌هایی که از fetch عبور نمی‌کنند
    - Embedded auth wiring که پس از ورود کاربر `window.syncHybrid.init()` را فراخوانی می‌کند و `window.supabaseSync.setUserId()` و `setGroupEmail()` را مقداردهی می‌کند

- `test-group-sync.js`
  - نقش: اسکریپت تست دستی/کنسول برای شبیه‌سازی جریان ایجاد/به‌روزرسانی جداول و ذخیره در `shared_backups`؛ فراخوانی صریح `window.syncHybrid.players.update(...)` را دارد (اما `makeTableAPI.update` در `sync-hybrid.js` به upsert-first تبدیل شده).

- SQL files (مواجهه با type/id)
  - `supabase_id_to_text_migration.sql` — اسکریپت idempotent برای تبدیل برخی ستون‌های `id` از uuid به text با مدیریت وابستگی‌های FK.
  - `supabase_schema_suggested.sql`, `supabase_schema_fix_from_local.sql`, `supabase.sql` — پیشنهادات index/نوع ستون‌ها و ساختار جداول مورد نیاز (indexes برای onConflict keys نظیر devices user_id+device_id).

---

## 2) جداول درگیر در همگام‌سازی (تفضیلی)

در ادامه فهرست جداول که در کد همگام‌سازی ذکر شده‌اند، نقش هر جدول، کلیدهای onConflict، وضعیت migration پیشنهادی و وابستگی‌های FK (که در SQLها دیده می‌شود).

- `devices`
  - نقش: ثبت دستگاه‌های کاربر (برای تشخیص دستگاه مبدا/sync metadata)
  - onConflict: `['user_id','device_id']`
  - migration: SQL پیشنهاد ایجاد UNIQUE INDEX `idx_devices_user_deviceid_unique` روی `(user_id, device_id)` برای پشتیبانی از upsert
  - FK: `user_id` → `profiles.id`
  - رفتار: client از `upsert([{ user_id, device_id, device_name, last_seen }], { onConflict: 'user_id,device_id' })` استفاده می‌کند؛ `registerDeviceForUser()` در `index.html` تلاش می‌کند رکورد تکراری را جمع‌بندی کند.

- `profiles`
  - نقش: پروفایل کاربر؛ شامل `last_sync_at`, `last_sync_device`, `last_sync_payload` که برای کشف و metadata استفاده می‌شود
  - onConflict: `['id']` (id به عنوان کلید اصلی)
  - migration: معمولاً `id` از نوع `text` پیشنهاد شده (در اسکریپت تبدیل id→text برخی جداول اعمال می‌شوند — بررسی موردبه‌مورد لازم است)
  - FK: ممکن است به `devices.user_id` و سایر جداول اشاره شود
  - رفتار: `writeLastSyncMetadata()` در `sync-supabase.js` upsert به `profiles` می‌زند.

- `shared_backups`
  - نقش: محل کشف بک‌آپ‌های گروهی؛ ذخیره‌ی snapshot کوچک یا مرجع به بک‌آپ
  - onConflict: `['group_email']`
  - migration: جدول و index‌های مربوط به `group_email` پیشنهاد شده‌اند (`idx_backups_group_email_lower` در SQLها)
  - رفتار: `backupNow()` در `sync-hybrid.js` و مسیرهای fallback در `index.html` سعی در upsert این جدول دارند تا دستگاه‌های گروهی بتوانند بک‌آپ را پیدا کنند.

- `backups`
  - نقش: metadata بک‌آپ‌ها و لینک‌های فایل‌های آپلودشده در Storage
  - onConflict: بر اساس `id` یا ترکیبی از فیلدهای متادیتا (اسکریپت‌ها درج insert/upsert را استفاده می‌کنند)
  - migration: جدول `backups` در SQLها موجود است؛ تایپ `data jsonb`, `created_at timestamptz` و indexهایی پیشنهاد شده‌اند.

- `sessions`, `payments`, `players`, `coaches`, `competitions`, `training_plans`, `notes` (و سایر جداول domain-specific)
  - نقش: داده‌های اصلی اپلیکیشن که باید بین دستگاه‌ها همگام شوند (source of truth در سرور)
  - onConflict: غالباً `id` (یا در صورت موردی ترکیبی که در `getConflictKey()` ذکر شده)
  - migration: اگر کلاینت idهای متنی تولید می‌کند، لازم است ستون id به `text` تبدیل شود تا خطاهای `22P02 invalid input syntax for type uuid` رخ ندهد — `supabase_id_to_text_migration.sql` برای این کار نوشته شده است.
  - FK: ممکن است `players` به `teams` یا `coaches` وابسته باشد — بررسی SQL نهایی لازم است.

نکتهٔ مهم: onConflict keys باید مطابق unique constraints/indexes در DB باشند. پیش‌شرط عملیاتی: اطمینان از وجود indexes (مثلاً `devices (user_id, device_id)`، `shared_backups (group_email)`) قبل از استفاده از upsert با onConflict.

---

## 3) مسیرهای ناامن / نیازمند بازبینی (فهرست دقیق به همراه فایل/خط یا context)

در این بخش تمام نقاطی که ممکن است داده‌ها را خارج از مسیرِ sanitization و upsert-first ارسال یا دریافت کنند فهرست شده‌اند. هر مورد شامل فایل، خط/بخش و پیشنهاد رفع است.

1) `index.html` — global fetch wrapper و XHR wrapper (محل: بالای صفحه JS)
   - شرح: یک fetch wrapper وجود دارد که درخواست‌های به SUPABASE_URL را شناسایی می‌کند و header `apikey` را تزریق می‌کند و برای `PATCH /rest/v1/<table>` پارامتر `?id=eq.<id>` را اضافه می‌کند. همچنین یک `XMLHttpRequest` wrapper ساخته شده تا XHRها را نیز پوشش دهد.
   - وضعیت: این wrapper پوششِ خوبی خواهد داد اما باید بررسی کنیم همهٔ fetch/XHRها پیش از اجرا wrapper را دریافت می‌کنند (load order مهم است).
   - پیشنهادات:
     - مطمئن شوید این اسکریپت قبل از هر اسکریپتی که ممکن است fetch/XHR به Supabase بزند بارگذاری می‌شود.
     - اضافه کردن telemetry/logging محدود (مثلاً console.debug در حالت dev) وقتی wrapper یک درخواست به Supabase بازنویسی می‌کند تا بررسی شود که هیچ آدرسی از قلم نیفتاده باشد.

2) `test-group-sync.js` — مستقیم فراخوانی `window.syncHybrid.players.update(...)` (فایل: `test-group-sync.js`)
   - شرح: فراخوانی update در تست وجود دارد. در خوشبینانه‌ترین حالت `makeTableAPI.update` در `sync-hybrid.js` قبلاً upsert-first پیاده شده — اما اگر جایی از کد مستقیماً از Supabase SDK با `.update()` بدون WHERE استفاده کرده باشد، خطر وجود دارد.
   - پیشنهادات:
     - تبدیل کامل همهٔ `.update()`های پروژه به الگوی upsert-first (یا حداقل افزودن شرط `.eq('id', id)` برای مواردی که payload شامل id است).
     - جستجوی کامل برای `.update(` و بررسی context (does it include `.eq(`?)

3) Direct REST endpoints references in HTML templates (e.g., `supabase-confirm-email.html`, `confirm-signup.html`)
   - شرح: این فایل‌ها حاوی لینک‌های مستقیم به `/auth/v1/verify` و سایر آدرس‌های auth هستند. این‌ها template‌های ایمیل/صفحه تأییدند و عادی‌اند، اما در کد کلاینت باید از استفادهٔ ناامن REST جلوگیری شود.
   - پیشنهادات:
     - این موارد را به عنوان مستندات نگهداری کنید؛ نیازی به تغییر نیست مگر اینکه بخواهید API pathها را پنهان کنید.

4) Service workers (`service-worker.js`, `sw.js`)
   - شرح: هر دو فایل از `fetch(req)` برای proxy/caching استفاده می‌کنند. این‌ها روی مسیرهای عمومی عمل می‌کنند و نباید مستقیماً هدرهای auth را دستکاری کنند.
   - پیشنهادات:
     - اطمینان از اینکه service worker درخواست‌های حاوی credentials/sensitive headers را تغییر نمی‌دهد.
     - در صورت استفادۀ خاص از Supabase در SW، مطمئن شوید توکن‌ها به صورت ایمن مدیریت شده‌اند.

5) `libs/supabase.min.js`
   - شرح: SDK رسمی که fetch را داخلی استفاده می‌کند — این طبیعی و مورد انتظار است. اما مطمئن شوید نسخه‌ی استفاده شده با runtime patch و fetch wrapper شما سازگار است.
   - پیشنهادات:
     - نگهداری نسخه ثابت (pinned) از SDK؛ برای بهره‌وری و اشکال‌زدایی، در صورت امکان از غیر-minified در staging استفاده کنید.

6) سایر fetch/XHR ساده (درون `index.html`)
   - مثال‌هایی که هرچند به تصاویر یا منابع دیگر اشاره دارند، اما لازم است بررسی شوند که هیچ fetchی به SUPABASE_URL قبل از نصب wrapper انجام نشود.

جستارِ پیشنهادی برای بررسی بیشتر: `\.update\(|fetch\(|XMLHttpRequest|/rest/v1/` و سپس دستی بررسی context هر مورد.

---

## جمع‌بندی و پیشنهاد اقدامات بعدی (عملی)

1. بررسی و تایید indexes در DB برای تمام onConflict keys (حداقل: `devices(user_id,device_id)`, `shared_backups(group_email)`, `profiles(id)`).
2. اجرای `supabase_id_to_text_migration.sql` در محیط staging و بررسی عدم وقوع خطاهای 22P02 یا پیام‌های FK؛ سپس promotion به production پس از پشتیبان‌گیری کامل.
3. اضافه کردن تست smoke برای flow زیر در staging (با یک حساب تستی): signup/login → registerDeviceForUser → backupNow() → fetchSharedBackup() → merge into state. بررسی logs برای خطاهای 400/21000/22P02.
4. اطمینان از load-order: fetch/XHR wrapper باید قبل از هر اسکریپتی که ممکن است تماس HTTP برقرار کند اجرا شود. در صورت لزوم، آن اسکریپت را به بالای `<head>` منتقل کنید یا به صورت ماژول/inline در document-start بارگذاری کنید.
5. تکمیل audit: run `grep -n "\.update\(|fetch\(|XMLHttpRequest|/rest/v1/"` و بررسی دستی مواردی که `.update(` بدون `.eq(` دارند.
6. بعد از اجرای migration و تایید بازه‌ای از تست‌ها، حذف fallbackهای محافظه‌کارانه (update-with-eq) در `flushQueue` تا رفتار کاملاً idempotent و upsert-first تضمین شود.

---

## فایلِ گزارش شده (افزوده شده به پروژه)
فایل `SYNC_INVENTORY_REPORT.md` در ریشهٔ پروژه ایجاد شد و شامل محتوای بالا است.

---

اگر می‌خواهی، گام بعدی را انجام بدهم:
- الف) اجرای خودکار یک grep اضافی برای همهٔ `.update(` ها و خروجی CSV با فایل/خط و نمونه خط (پیشنهاد: مفید برای بازبینی تبدیل به upsert). یا
- ب) تولید یک checklist و snippet های کدی (قبل/بعد) برای اصلاح مواردی که `.update()` بدون WHERE استفاده شده‌اند.

بگو کدام را انجام بدم تا بلافاصله اجرا کنم و نتیجه را برات نمایش بدم.
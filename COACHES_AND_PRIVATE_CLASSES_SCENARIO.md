# سناریوی صفحهٔ مربیان و کلاس‌های خصوصی

این سند شرحِ سناریوی صفحهٔ مربیان و مدیریت کلاس‌های خصوصی (جلسات/سشن‌ها) است، استخراج‌شده از ساختار پروژه و نمونه‌های تست موجود (`test-group-sync.js`). هدف: قالبی قابل استفاده و قابل کپی برای پروژه‌های دیگر.

## خلاصهٔ استخراج‌شده از پروژه
- جداول/مجموعه‌های مرتبط در پروژه: `coaches`, `sessions`, `players`, `payments`, `training_plans`.
- نمونه دادهٔ تست در `test-group-sync.js` نشان می‌دهد که رکورد مربی شامل حداقل فیلدهای `name`, `title`, `group_email` است.
- رکورد جلسه (`session`) شامل `title`, `category`, `group_email` است.

## اهداف صفحه مربیان
- نمایش لیست مربیان با اطلاعات پایه (نام، عنوان، تصویر، تخصص، دسترسی به تقویم).
- صفحهٔ پروفایل مربی با بیوگرافی، دسترسی‌پذیری/زمان‌های آزاد، کلاس‌های قابل رزرو، بازخورد و قیمت‌ها.
- امکان فیلتر بر اساس تخصص، سطح (مثلاً Beginner/Advanced)، زبان، منطقه.

## اهداف مدیریت کلاس‌های خصوصی (Private Classes / Sessions)
- مربی می‌تواند زمان‌های قابل‌رزرو را روی تقویم مشخص کند.
- بازیکن/مشتری می‌تواند جلسهٔ خصوصی رزرو کند، پرداخت را انجام دهد و تایید رزرو دریافت کند.
- تاریخچهٔ جلسات و پرداخت‌ها نگهداری شود؛ امکان کنسلی و بازپرداخت وجود داشته باشد.

## مدل داده — پیشنهاد (بر پایهٔ استخراج)
- جدول `coaches` (نمونه):
  - `id UUID PRIMARY KEY`
  - `name TEXT`
  - `title TEXT` (مثلاً "مربی ارشد")
  - `bio TEXT NULL`
  - `photo_url TEXT NULL`
  - `specialties JSONB NULL` (لیست تخصص‌ها)
  - `availability JSONB NULL` (قوانین یا بازه‌های قابل رزرو)
  - `hourly_rate NUMERIC NULL`
  - `group_email TEXT NULL` (برای تست/گروه‌بندی در پروژه جاری)
  - `created_at TIMESTAMP DEFAULT now()`

- جدول `sessions` (جلسه/کلاس خصوصی):
  - `id UUID PRIMARY KEY`
  - `coach_id UUID REFERENCES coaches(id)`
  - `title TEXT`
  - `category TEXT`
  - `description TEXT NULL`
  - `start_at TIMESTAMP` (برای جلسات زمان‌بندی‌شده)
  - `end_at TIMESTAMP`
  - `capacity INT DEFAULT 1` (برای خصوصی معمولاً 1)
  - `price NUMERIC NULL`
  - `status TEXT` (e.g., `scheduled`, `cancelled`, `completed`)
  - `group_email TEXT NULL`
  - `created_at TIMESTAMP DEFAULT now()`

- جدول `bookings` (رزروها):
  - `id UUID PRIMARY KEY`
  - `session_id UUID REFERENCES sessions(id)`
  - `player_id UUID REFERENCES players(id)`
  - `status TEXT` (`reserved`, `confirmed`, `cancelled`, `attended`)
  - `paid BOOLEAN DEFAULT false`
  - `payment_id UUID NULL` (ارجاع به جدول `payments`)
  - `created_at TIMESTAMP DEFAULT now()`

- جدول `payments` (در پروژهٔ فعلی وجود دارد): نگهداری تراکنش‌ها و وضعیت پرداخت.

## نمونهٔ CREATE SQL (خلاصه)
```sql
CREATE TABLE coaches (
  id UUID PRIMARY KEY,
  name TEXT,
  title TEXT,
  bio TEXT,
  photo_url TEXT,
  specialties JSONB,
  availability JSONB,
  hourly_rate NUMERIC,
  group_email TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  coach_id UUID REFERENCES coaches(id),
  title TEXT,
  category TEXT,
  description TEXT,
  start_at TIMESTAMP,
  end_at TIMESTAMP,
  capacity INT DEFAULT 1,
  price NUMERIC,
  status TEXT DEFAULT 'scheduled',
  group_email TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE bookings (
  id UUID PRIMARY KEY,
  session_id UUID REFERENCES sessions(id),
  player_id UUID REFERENCES players(id),
  status TEXT DEFAULT 'reserved',
  paid BOOLEAN DEFAULT false,
  payment_id UUID,
  created_at TIMESTAMP DEFAULT now()
);
```

## API پیشنهادی
- `GET /coaches` — فهرست مربیان، با فیلترها (`?specialty=...&location=...`)
- `GET /coaches/:id` — پروفایل مربی و تقویم در دسترس
- `POST /coaches` — افزودن مربی (admin)
- `PUT /coaches/:id` — ویرایش پروفایل مربی

- `GET /sessions` — نمایش جلسات عمومی/قابل رزرو
- `GET /sessions/:id` — جزئیات جلسه
- `POST /sessions` — ایجاد جلسه (مربی یا ادمین)

- `POST /bookings` — رزرو جلسه (payload: `session_id`, `player_id`, `payment_method`) → ایجاد `booking` و هدایت به پرداخت
- `POST /payments/notify` — webhook پرداخت برای تایید تراکنش و علامت زدن `booking.paid = true`

## جریان رزرو ساده
1. کاربر جلسه را انتخاب می‌کند، زمان و مربی را می‌بیند.
2. در صورت نیاز، فرم اطلاعات و پرداخت نمایش داده می‌شود.
3. پس از پرداخت موفق، `booking` با `status = confirmed` و `paid = true` ثبت می‌شود.
4. نوتیفیکیشن ایمیل/پوش برای مربی و بازیکن ارسال می‌شود.

## تقویم و در دسترس‌بودن (Availability)
- دو مدل رایج:
  1. بازه‌های تکرارشونده (مثلاً هر سه‌شنبه 17:00–19:00)
  2. بلاک‌های دستی (تاریخ/زمان‌های مشخص)
- ذخیرهٔ availability در `coaches.availability` به‌صورت JSON با استاندارد iCal یا ساختار سادهٔ رنج زمانی.
- هنگام رزرو، بررسی تلاقی با رزروهای قبلی و availability انجام شود.

## پرداخت و سیاست‌های کنسلی
- پشتیبانی از پرداخت یکجا یا پرداخت مرحله‌ای (در صورت نیاز).
- سیاست کنسلی: تا X ساعت قبل قابل کنسل با بازپرداخت کامل/جزئی.
- webhook برای تایید پرداخت و نگهداری رکورد `payments`.

## اطلاع‌رسانی
- ایمیل و نوتیفیکیشن (push) برای موارد زیر:
  - تایید رزرو
  - یادآوری جلسه (24 ساعت / 1 ساعت قبل)
  - تغییر یا کنسلی توسط مربی

## مدیریت و داشبورد ادمین
- مدیریت مربیان (CRUD).
- مشاهدهٔ رزروها و پرداخت‌ها، و امکان بازپرداخت دستی.
- گزارش‌های درآمدی per-coach و تعداد جلسات.

## امنیت و اعتبارسنجی
- احراز هویت برای رزرو و مدیریت (JWT / session).
- صاحب‌امتیاز مربی فقط می‌تواند تقویم/قیمت‌های خود را ویرایش کند یا ادمین.
- محافظت در برابر رزرو همزمان: استفاده از تراکنش DB و قفل ردیف‌ها (SELECT FOR UPDATE) هنگام ایجاد booking.

## تست‌ها
- Unit tests برای منطق درگیری تقویم و تشخیص تداخل زمان‌ها.
- Integration tests برای جریان رزرو+پرداخت (شبیه‌سازی webhook).
- E2E برای رابط کاربری رزرو.

## نکات مهاجرتی (از پروژه‌های دیگر)
- اگر جدول `sessions` یا `coaches` در سیستم قدیمی ساختاری متفاوت داشت، پیشنهاد می‌شود batch-migration با تبدیل فیلدها و نگهداری `group_email` برای اعتبارسنجی اجرا کنید (مثل تست‌های `test-group-sync.js`).
- هنگام ایجاد دادهٔ تست، از `group_email` برای جداسازی داده‌ها استفاده شد — در مهاجرت می‌توان از فیلد مشابه برای تعیین منبع استفاده کرد.

---

فایل تولید شد تا مستقیماً در پروژه کپی شود و قابل توسعه باشد.

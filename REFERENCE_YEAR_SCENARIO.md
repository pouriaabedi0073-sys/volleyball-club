# سناریوی تعیین "سال مرجع" (Reference Year)

هدف این مستند تعریف روش و قواعد تعیین "سال مرجع" برای استفادهٔ یکپارچه در پروژه‌های دیگر است. "سال مرجع" معمولاً برای محاسبهٔ سنِ بازیکن، محاسبهٔ دوره‌های آماری، یا تعیین فصل/سال رقابتی استفاده می‌شود.

## تعریف
- سال مرجع: عدد صحیح نمایانگر سالی که ملاکِ محاسبات زمانی قرار می‌گیرد (مثلاً 2026).
- می‌تواند به‌صورت خودکار از تاریخ مسابقه یا به‌صورت صریح در پیکربندی تعیین شود.

## قواعد پیشنهادی انتخاب سال مرجع
1. پیکربندی صریح در سیستم (اولویت بالا):
   - مقدار `REFERENCE_YEAR` در فایل پیکربندی یا متغیر محیطی قرار گیرد.
   - مثال: `REFERENCE_YEAR=2026`
2. استخراج از فصل/مسابقه (در غیاب پیکربندی):
   - اگر عملیات مربوط به یک مسابقه/فصل مشخص است، سال مرجع = سال شروع فصل یا سال وقوع مسابقه.
   - برای مسابقاتی که در انتهای سال برگزار می‌شوند (مثلاً دسامبر)، اگر فصل مرتبط سال بعدی را پوشش می‌دهد، از سال فصل استفاده کنید.
3. پیش‌فرض منطقی (Fallback):
   - اگر هیچ داده‌ای موجود نیست، از سال جاری سرور استفاده شود (`(new Date()).getFullYear()`).

## کاربردها
- محاسبهٔ گروه سنی: تعیین سن براساس `reference_year - birth_year` یا دقیق‌تر با مقایسهٔ تاریخ تولد با تاریخ مرجع (`reference_year-01-01`).
- گزارش‌های سالانه/فصلی: تعیین بازهٔ آماری برای گزارش‌ها.
- مهاجرت/بازپخش تاریخچه: تمام محاسبات زمانی باید از یک `reference_year` یکسان استفاده کنند تا نتایج قابل بازپخش باشند.

## نمونه SQL
- محاسبهٔ سنِ بازیکن در ابتدای سال مرجع (سال/01/01):

```sql
-- پارامتر: :reference_year (مثلاً 2026)
SELECT
  id,
  name,
  dob,
  (:reference_year - EXTRACT(YEAR FROM dob))
    - (CASE WHEN TO_CHAR(dob, 'MMDD') > '0101' THEN 1 ELSE 0 END) AS age_at_reference
FROM players;
```

- مثال محاسبهٔ گروه سنی با آستانه‌ها:

```sql
WITH ages AS (
  SELECT id, name,
    (:reference_year - EXTRACT(YEAR FROM dob)
      - (CASE WHEN TO_CHAR(dob,'MMDD') > '0101' THEN 1 ELSE 0 END)) AS age
  FROM players
)
SELECT id, name,
  CASE
    WHEN age < 12 THEN 'U12'
    WHEN age < 14 THEN 'U14'
    WHEN age < 16 THEN 'U16'
    WHEN age < 18 THEN 'U18'
    ELSE 'Adult'
  END AS age_group
FROM ages;
```

## نمونه JS
```js
function getReferenceYear(config) {
  if (config && config.REFERENCE_YEAR) return Number(config.REFERENCE_YEAR);
  if (config && config.seasonStartDate) return new Date(config.seasonStartDate).getFullYear();
  return new Date().getFullYear();
}

function ageAtReference(dobIso, referenceYear) {
  const dob = new Date(dobIso);
  const refDate = new Date(referenceYear, 0, 1); // Jan 1 of reference year
  let age = referenceYear - dob.getFullYear();
  if (dob.getMonth() > 0 || (dob.getMonth() === 0 && dob.getDate() > 1)) {
    age -= 1;
  }
  return age;
}
```

## نکات پیاده‌سازی
- همیشه `reference_year` را به‌عنوان پارامتر ورودی به توابع محاسباتی پاس دهید؛ از استفادهٔ ضمنی از تاریخ جاری در منطق محاسباتی خودداری کنید.
- نگهداری مقدار `reference_year` در لاگ یا metadata رویدادها تا محاسبات بازپخش‌پذیر باشند.
- در APIها، اجازهٔ override از طریق query param یا body را درنظر بگیرید (با اعتبارسنجی).

## مهاجرت و بازپخش (Replay)
- برای بازپخش تاریخچه از یک تاریخچهٔ مسابقات، مقدار `reference_year` باید قطعی و ثبت‌شده باشد تا نتایج بازپخش برابر با نتایج اصلی باشند.
- هنگام ایجاد دیتاست جدید یا ریمپینگ، `reference_year` باید در metadata ذخیره شود.

## پیشنهادات عملی
- قرار دادن `REFERENCE_YEAR` در فایل پیکربندی پروژه (`.env`, `config.json`) و نمایش آن در صفحهٔ تنظیمات مدیریتی.
- ایجاد endpoint کمکی برای بازنویسی یا محاسبهٔ خودکار سال مرجع برای مجموعه‌ای از رویدادها قبل از اجرای batch jobهای دسته‌ای.

---

فایل تولید شده برای استفادهٔ سریع در پروژه‌های دیگر. در صورت تمایل، می‌توانم یک نسخهٔ انگلیسی یا نسخهٔ آمادهٔ کد (Express endpoint + SQL migration script) هم اضافه کنم.

راهنمای سریع TWA (Trusted Web Activity)

این فایل یک راهنمای کوتاه و عملی برای فعال‌سازی TWA برای اپ شماست. مراحل زیر را دنبال کنید و مقادیر placeholder را با مقادیر واقعی جایگزین کنید.

1) مقادیر لازم
- package name (نام بسته اندروید): مقدار مثال: com.example.yourapp
- SHA-256 certificate fingerprint (اثر انگشت گواهی SHA-256): می‌توانید این مقدار را از keystore امضای اپ یا از Google Play (اگر از App Signing استفاده می‌کنید) تهیه کنید.

2) قالب فایل digital asset links (برای میزبانی در سرور)
- فایل نمونه ایجاد شده: `/.well-known/assetlinks.json`
- محتوا نمونه (hex با ':' جدا شده):

[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.example.yourapp",
      "sha256_cert_fingerprints": ["AA:BB:CC:...:ZZ"]
    }
  }
]

نکته: این فایل باید از طریق HTTPS در آدرس `https://<your-domain>/.well-known/assetlinks.json` در دسترس باشد و هدر Content-Type: application/json بازگرداند.

3) به‌دست آوردن SHA-256 fingerprint (نمونه دستورات)
- با keytool (Windows PowerShell / cmd):
  keytool -list -v -keystore <path-to-keystore.jks> -alias <alias>

این دستور مقداری شبیه به `SHA256: AA:BB:...` برمی‌گرداند. آن مقدار hex (با دونقطه یا با فاصله) را در assetlinks.json قرار دهید.

4) مقدار مربوطه در `manifest.webmanifest`
شما قبلاً فایل `manifest.webmanifest` را با `related_applications` حاوی placeholder به‌روزرسانی کرده‌اید. دو نکته:
- در `manifest.webmanifest` ما از شکل دیگری (base64) درون `related_applications` استفاده کردیم. اگر Play Console مقدار base64 برای گواهی می‌دهد، همان‌را جایگزین کنید.
- اگر Play App Signing فعال است، باید از اثر انگشتی که Play Console نمایش می‌دهد استفاده کنید (ممکن است certificate گواهی Google Play باشد، نه کلید امضای محلی شما).

5) ساخت و بسته‌بندی TWA
دو روش متداول:
- Bubblewrap (سریع و خط فرمان):
  - نصب: `npm i -g @bubblewrap/cli`
  - مقداردهی اولیه: `bubblewrap init --manifest https://<your-domain>/manifest.webmanifest` (پاسخ به سوالات برای package name و signing)
  - ساخت: `bubblewrap build`
  - امضای APK/AAB و آپلود روی Play Console

- Android Studio (روش گرافیکی):
  - ایجاد یک پروژه و اضافه کردن dependency برای Trusted Web Activity (androidx.browser)
  - پیکربندی `AndroidManifest.xml` و فایل‌های مربوط به TWA
  - ساخت، امضا و آپلود

6) نکات تکمیلی
- اطمینان حاصل کنید `https://<your-domain>/.well-known/assetlinks.json` به‌درستی قابل دسترسی و معتبر باشد.
- بررسی اعتبار: از ابزارهای آنلاین Digital Asset Links یا Chrome on Android (پس از نصب اپ) برای عیب‌یابی استفاده کنید.
- اگر صفحه شما از `manifest.json` لینک شده است (در `index.html`)، دو راه دارید:
  - یا `index.html` را به `manifest.webmanifest` اشاره دهید، یا تغییرات `related_applications` را در `manifest.json` هم اعمال کنید. (فعلاً فایل `manifest.webmanifest` حاوی تنظیمات TWA است.)

7) چک‌لیست سریع
- [ ] package name صحیح را در manifest و assetlinks.json قرار دادم
- [ ] SHA256 certificate fingerprint را تهیه و در هر دو مکان لازم قرار دادم
- [ ] فایل `/.well-known/assetlinks.json` را روی دامنه اصلی میزبانی کردم (HTTPS)
- [ ] اپ را با همان کلید امضا کردم یا اثر انگشت Play Console را استفاده کردم
- [ ] اپ را در Play Console منتشر یا تست کردم

اگر می‌خواهید، می‌توانم:
- `index.html` را به `manifest.webmanifest` اشاره دهم (یا مقادیر مشابه را در `manifest.json` آپدیت کنم).
- یک اسکریپت کوچک برای بررسی دسترسی `assetlinks.json` بنویسم.

### یادداشت (فارسی)

مهم‌ترین قدم برای تبدیل PWA به اپلیکیشن اندروید، استفاده از ابزاری مانند PWABuilder یا Bubblewrap است که یک Trusted Web Activity (TWA) می‌سازد. این کار باعث می‌شود اپلیکیشن شما بتواند در Google Play منتشر شود و در اندروید مانند یک اپ نیتیو اجرا گردد.

برای این منظور، باید یک فایل به نام `assetlinks.json` بسازید و آن را در مسیر `https://<your-domain>/.well-known/assetlinks.json` قرار دهید تا گوگل (و دستگاه‌های اندروید) بتوانند تأیید کنند شما مالک وب‌سایت و اپلیکیشن هستید. من فعلاً نمی‌توانم این فایل را با مقادیر واقعی ایجاد کنم، چون برای پر کردن فیلد `sha256_cert_fingerprints` نیاز به اثر انگشت (SHA-256) کلید امضای اپ دارم که بعد از ساخت یا امضای اولین نسخه APK/AAB مشخص می‌شود.

نکته دربارهٔ پوشهٔ `.well-known` و مشکلات آپلود:
- بعضی از ابزارهای گرافیکی (مثل Windows Explorer) ممکن است ایجاد پوشه‌ای که با نقطه شروع می‌شود را مشکل بدانند، اما Git و GitHub این پوشه را پشتیبانی می‌کنند.
- راه‌های ساده برای ایجاد/آپلود:
  - از PowerShell یا CMD استفاده کنید: `mkdir .well-known` یا در PowerShell: `New-Item -ItemType Directory -Name '.well-known'`.
  - یا در رابط وب گیت‌هاب یک فایل جدید ایجاد کنید و مسیر آن را `.well-known/assetlinks.json` وارد کنید — گیت‌هاب به‌طور خودکار پوشه را می‌سازد.
  - اگر از GitHub Pages با پوشه `docs/` منتشر می‌کنید، می‌توانید پوشهٔ `.well-known` را داخل `docs/` ایجاد کنید تا هنگام انتشار در ریشه سایت قرار گیرد.

اگر همچنان نمی‌خواهید یا نمی‌توانید پوشهٔ `.well-known` را مستقیم در سورس قرار دهید، گزینه‌های جایگزین:
- قرار دادن فایل در مسیر دیگر (مثلاً `/static/assetlinks.json`) و افزودن یک قانون redirect/rewrite در میزبان (Netlify, Firebase Hosting, nginx و غیره) تا درخواست `/.well-known/assetlinks.json` را به فایل واقعی هدایت کند.
- استفاده از یک GitHub Action یا اسکریپت CI که هنگام نشر، فایل `assetlinks.json` را در شاخهٔ منتشرشده (یا branch `gh-pages`) در مسیر `/.well-known/` تولید/کپی کند.

خلاصه: من یک نمونهٔ `assetlinks.example.json` و یک README داخل پوشهٔ `.well-known` اضافه کرده‌ام تا وقتی آماده بودید، مقادیر واقعی (package name و SHA-256) را جایگزین کنید و فایل را در ریشهٔ سایت میزبانی کنید.


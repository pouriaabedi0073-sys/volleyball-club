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


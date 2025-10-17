# Runbook: اجرای پاک‌سازی و ایجاد ایندکس‌ها در Staging

این سند گام‌به‌گام نحوهٔ اجرای `db_cleanup_create_indexes.sql` در محیط staging و تست upsertها را توضیح می‌دهد.

پیش‌نیازها
- دسترسی به پایگاه داده staging (host, port, dbname, user, password یا اتصال از طریق SSH tunnel)
- ابزار `psql` نصب شده روی ماشینی که اجرا می‌کنید
- فایل `db_cleanup_create_indexes.sql` در ریشهٔ پروژه
- دسترسی به کنسول مرورگر برای تست upsertها (تحت session کاربر تست)

گام‌های پیشنهادی

1. بک‌آپ کامل از پایگاه داده

   - اگر از pg_dump استفاده می‌کنید:

   ```powershell
   pg_dump -h <staging_host> -U <username> -d <dbname> -F c -b -v -f backup_before_cleanup.dump
   ```

2. اجرای اسکریپت SQL (در ماشینی که psql نصب دارد)

   ```powershell
   psql -h <staging_host> -U <username> -d <dbname> -f db_cleanup_create_indexes.sql
   ```

   - اگر نیاز به مشخص کردن پورت دارید اضافه کنید: `-p 5432`
   - اگر تمایل دارید، ابتدا با `psql -h <host> -U <user> -d <db> -f db_cleanup_create_indexes.sql` اجرا کنید و خروجی را بررسی کنید.

3. تایید نتایج و بررسی جدول `cleanup_audit`

   ```sql
   SELECT * FROM public.cleanup_audit ORDER BY removed_at DESC LIMIT 100;
   SELECT COUNT(*) FROM public.devices;
   SELECT COUNT(*) FROM public.shared_backups;
   ```

4. تست upsertها از کنسول مرورگر

   - باز کردن اپ در حالت staging و لاگین با کاربر تست
   - باز کردن DevTools → Console
   - paste کردن محتوای فایل `test_upserts_console.js` و اجرا

5. رفع خطاهای احتمالی

   - اگر خطاهای 400/22P02 دیدید، لاگ چاپ‌شده از سمت سرویس (response body) را بررسی کنید. معمولاً پیغام خطا نوع mismatch یا constraint violation را نشان می‌دهد.
   - بررسی کنید که unique indexها پس از cleanup ساخته شده باشند:

   ```sql
   SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('devices','shared_backups');
   ```

6. پس از موفقیت در staging

   - ثبت زمان و خروجی‌ها
   - گرفتن backup مجدد قبل از اجرای production
   - برقراری maintenance window برای تولید و اجرای همین اسکریپت در production


Notes
- اگر schema شما اندکی متفاوت است (مثلاً نام ستون id یا نوع ستون متفاوت باشد)، اسکریپت را قبل از اجرا اصلاح کنید.
- اگر می‌خواهید case-insensitive uniqueness برای `group_email` داشته باشید، راهکار جایگزین شامل افزودن ستون `group_email_lower` و پر کردن آن و سپس ایندکس روی آن است.

# مهاجرت به مسیرهای نسبی (Relative Paths)

## خلاصه
تمام مسیرهای کدشده (hardcoded) و مطلق (absolute) به مسیرهای نسبی (relative) تبدیل شدند تا پروژه در هر مکانی به صورت جدید کار کند.

## فایل‌های تصحیح شده

### 1. **service-worker.js**
- ✅ تمام مسیرهای `/volleyball/...` → `./...`
- ✅ مثال: `/volleyball/index.html` → `./index.html`

### 2. **manifest.json**
- ✅ `"start_url": "/volleyball/?source=pwa"` → `"./?source=pwa"`
- ✅ `"scope": "/volleyball/"` → `"./"`
- ✅ `"id": "/volleyball/?source=pwa"` → `"./?source=pwa"`
- ✅ تمام icon URLs: `/volleyball/assets/...` → `./assets/...`
- ✅ تمام shortcuts URLs نسبی شدند

### 3. **manifest.webmanifest**
- ✅ همان تغییرات manifest.json اعمال شد
- ✅ `"start_url": "/index.html#home"` → `"./index.html#home"`
- ✅ `"scope": "/"` → `"./"`
- ✅ `"id": "/"` → `"./"`

### 4. **sw.js**
- ✅ `/assets/icons/...` → `./assets/icons/...`
- ✅ `/assets/fonts/...` → `./assets/fonts/...`

### 5. **tools_check_braces.ps1**
- ✅ `$path = 'c:\Users\m-pc\Desktop\project_fixed_\sync-hybrid.js'` → `$path = '..\sync-hybrid.js'`

### 6. **tools\check_braces.ps1**
- ✅ مسیر hardcoded → مسیر نسبی

### 7. **tools\check_try_balance.ps1**
- ✅ مسیر hardcoded → مسیر نسبی

### 8. **sync-backup.js**
- ✅ Supabase URL hardcoded حذف شد
- ✅ اکنون `window.SUPABASE_URL` و `window.SUPABASE_ANON_KEY` الزامی است
- ✅ باید توسط index.html قبل از load این فایل تنظیم شود

### 9. **supabase-confirm-email.html**
- ✅ `base href="/volleyball/"` → `base href=""`
- ✅ URL‌های hardcoded Supabase به `{{ .ConfirmationURL }}` تبدیل شدند
- ✅ دیگر domain‌های hardcoded وجود ندارند

### 10. **supabase-recovery-email.html**
- ✅ `<base href>` اضافه شد (خالی برای نسبی)

## مسیرهای نسبی توضیح

```
./           # current directory
../          # parent directory
./assets/    # assets folder in current directory
```

## اطلاعات Supabase

**⚠️ مهم**: Supabase credentials اکنون باید در index.html یا یک فایل config جدا تنظیم شوند.

مثال در index.html:
```html
<script>
  window.SUPABASE_URL = 'https://your-project.supabase.co';
  window.SUPABASE_ANON_KEY = 'your-anon-key';
</script>
<script src="./sync-backup.js"></script>
```

## آپلود به مکان جدید

اکنون می‌توانید:
1. تمام فایل‌ها را در هر جایی قرار دهید
2. پروژه از هر مسیری کار می‌کند
3. localhost, production, subdirectory همه پشتیبانی می‌شود

## تست

```bash
# روی localhost
python -m http.server 5500

# یا Node.js
npx http-server -p 5500
```

سپس به `http://localhost:5500` بروید

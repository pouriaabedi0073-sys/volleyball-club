// اسکریپت تست همگام‌سازی گروهی
// این اسکریپت را در کنسول مرورگر اجرا کنید

const TEST_GROUP_EMAIL = 'test-group@example.com';
const TEST_DATA = {
  player: {
    name: 'بازیکن تست',
    phone: '09123456789',
    group_email: TEST_GROUP_EMAIL
  },
  coach: {
    name: 'مربی تست',
    title: 'مربی ارشد',
    group_email: TEST_GROUP_EMAIL
  },
  session: {
    title: 'جلسه تست',
    category: 'عمومی',
    group_email: TEST_GROUP_EMAIL
  },
  payment: {
    amount: 1000000,
    payment_month: '7',
    payment_year: '1402',
    group_email: TEST_GROUP_EMAIL
  },
  competition: {
    title: 'مسابقه تست',
    team_a: 'تیم الف',
    team_b: 'تیم ب',
    group_email: TEST_GROUP_EMAIL
  },
  training_plan: {
    title: 'برنامه تست',
    body: 'محتوای تست',
    group_email: TEST_GROUP_EMAIL
  },
  note: {
    content: 'یادداشت تست',
    group_email: TEST_GROUP_EMAIL
  }
};

// تابع کمکی برای نمایش لاگ‌ها
function log(msg, data) {
  console.log(`[گروه: ${TEST_GROUP_EMAIL}] ${msg}`, data || '');
}

// تابع اصلی تست
async function runGroupSyncTest() {
  if (!window.supabase) {
    throw new Error('Supabase client not found. Please login and ensure `window.supabase` is available.');
  }

  log('شروع تست همگام‌سازی گروهی (مستقیم با Supabase)...');
  const client = window.supabase;

  // If backupSync exists, set group email for compatibility
  try { if (window.backupSync && typeof window.backupSync.setGroupEmail === 'function') window.backupSync.setGroupEmail(TEST_GROUP_EMAIL); } catch(_){ }

  try {
    // 1. ایجاد بازیکن تست
    log('ایجاد بازیکن تست...');
    const player = await client.from('players').insert([Object.assign({}, TEST_DATA.player, { created_at: new Date().toISOString() })]).select();
    log('بازیکن ایجاد شد:', player);

    // 2. ایجاد مربی تست
    log('ایجاد مربی تست...');
    const coach = await client.from('coaches').insert([Object.assign({}, TEST_DATA.coach, { created_at: new Date().toISOString() })]).select();
    log('مربی ایجاد شد:', coach);

    // 3. ایجاد جلسه تست
    log('ایجاد جلسه تست...');
    const session = await client.from('sessions').insert([Object.assign({}, TEST_DATA.session, { created_at: new Date().toISOString() })]).select();
    log('جلسه ایجاد شد:', session);

    // 4. ایجاد پرداخت تست
    log('ایجاد پرداخت تست...');
    const payment = await client.from('payments').insert([Object.assign({}, TEST_DATA.payment, { created_at: new Date().toISOString() })]).select();
    log('پرداخت ایجاد شد:', payment);

    // 5. ایجاد مسابقه تست
    log('ایجاد مسابقه تست...');
    const competition = await client.from('competitions').insert([Object.assign({}, TEST_DATA.competition, { created_at: new Date().toISOString() })]).select();
    log('مسابقه ایجاد شد:', competition);

    // 6. ایجاد برنامه تمرینی تست
    log('ایجاد برنامه تمرینی تست...');
    const plan = await client.from('training_plans').insert([Object.assign({}, TEST_DATA.training_plan, { created_at: new Date().toISOString() })]).select();
    log('برنامه تمرینی ایجاد شد:', plan);

    // 7. ذخیره در shared_backups: prefer backupSync if available, otherwise write to shared_backups
    log('ذخیره در shared_backups...');
    if (window.backupSync && typeof window.backupSync.createBackup === 'function') {
      try {
        await window.backupSync.setGroupEmail(TEST_GROUP_EMAIL);
        const res = await window.backupSync.createBackup();
        log('backupSync created backup:', res);
      } catch(e) { log('backupSync create failed, falling back', e); }
    } else {
      try {
        log('shared_backups upsert skipped (storage-only mode)');
        /*
        const sb = await client.from('shared_backups').upsert([{ group_email: TEST_GROUP_EMAIL, data: TEST_DATA, device_id: 'test-device', last_sync_at: new Date().toISOString() }], { onConflict: 'group_email' }).select();
        log('shared_backups upsert result', sb);
        */
      } catch(e) { log('shared_backups upsert failed', e); }
    }

    // 8. بررسی realtime — attach basic listeners
    log('منتظر دریافت رویدادهای realtime (کنسول)...');
    window.addEventListener('supabase:realtime', (e) => { log('رویداد realtime دریافت شد:', e.detail); });
    window.addEventListener('sync:merge', (e) => { log('رویداد sync:merge دریافت شد:', e.detail); });

    // 9. بررسی همگام‌سازی با تغییر داده‌ها — update the first created player if available
    log('تست به‌روزرسانی...');
    try {
      const pid = player && player.data && player.data[0] && player.data[0].id ? player.data[0].id : null;
      if (pid) {
        const upd = await client.from('players').update({ name: 'بازیکن تست ویرایش شده' }).eq('id', pid).select();
        log('به‌روزرسانی انجام شد', upd);
      } else log('شناسه بازیکن برای به‌روزرسانی یافت نشد');
    } catch(uerr) { log('update failed', uerr); }

  } catch (error) {
    log('خطا در تست:', error);
    throw error;
  }
}

// تابع پاک‌سازی داده‌های تست
async function cleanupTestData() {
  log('پاک‌سازی داده‌های تست...');
  
  try {
    const tables = ['players', 'coaches', 'sessions', 'payments', 'competitions', 'training_plans'];
    
    for (const table of tables) {
      await window.supabase
        .from(table)
        .delete()
        .eq('group_email', TEST_GROUP_EMAIL);
    }
    
    log('داده‌های تست پاک شدند');
  } catch (error) {
    log('خطا در پاک‌سازی:', error);
  }
}

// راهنمای اجرا
console.log(`
برای اجرای تست:
1. ابتدا مطمئن شوید که در برنامه لاگین هستید
2. دستور زیر را اجرا کنید:
   await runGroupSyncTest()

برای پاک کردن داده‌های تست:
   await cleanupTestData()

برای مشاهده لاگ‌های realtime، کنسول را باز نگه دارید.
`);
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
  if (!window.supabase || !window.syncHybrid) {
    throw new Error('Supabase یا syncHybrid در دسترس نیست');
  }

  log('شروع تست همگام‌سازی گروهی...');
  
  // تنظیم ایمیل گروه برای همگام‌سازی
  window.supabaseSync.setGroupEmail(TEST_GROUP_EMAIL);
  
  try {
    // 1. ایجاد بازیکن تست
    log('ایجاد بازیکن تست...');
    const player = await window.syncHybrid.players.create(TEST_DATA.player);
    log('بازیکن ایجاد شد:', player);

    // 2. ایجاد مربی تست
    log('ایجاد مربی تست...');
    const coach = await window.syncHybrid.coaches.create(TEST_DATA.coach);
    log('مربی ایجاد شد:', coach);

    // 3. ایجاد جلسه تست
    log('ایجاد جلسه تست...');
    const session = await window.syncHybrid.sessions.create(TEST_DATA.session);
    log('جلسه ایجاد شد:', session);

    // 4. ایجاد پرداخت تست
    log('ایجاد پرداخت تست...');
    const payment = await window.syncHybrid.payments.create(TEST_DATA.payment);
    log('پرداخت ایجاد شد:', payment);

    // 5. ایجاد مسابقه تست
    log('ایجاد مسابقه تست...');
    const competition = await window.syncHybrid.competitions.create(TEST_DATA.competition);
    log('مسابقه ایجاد شد:', competition);

    // 6. ایجاد برنامه تمرینی تست
    log('ایجاد برنامه تمرینی تست...');
    const plan = await window.syncHybrid.trainingPlans.create(TEST_DATA.training_plan);
    log('برنامه تمرینی ایجاد شد:', plan);

    // 7. ذخیره در shared_backups
    log('ذخیره در shared_backups...');
    const backup = await window.syncHybrid.sharedBackups.create({
      group_email: TEST_GROUP_EMAIL,
      data: TEST_DATA,
      device_id: 'test-device'
    });
    log('shared_backup ایجاد شد:', backup);

    // 8. بررسی realtime
    log('منتظر دریافت رویدادهای realtime...');
    
    // افزودن event listener برای رویدادهای realtime
    window.addEventListener('supabase:realtime', (e) => {
      log('رویداد realtime دریافت شد:', e.detail);
    });

    window.addEventListener('sync:merge', (e) => {
      log('رویداد sync:merge دریافت شد:', e.detail);
    });

    // 9. بررسی همگام‌سازی با تغییر داده‌ها
    log('تست به‌روزرسانی...');
    await window.syncHybrid.players.update(player.data[0].id, {
      name: 'بازیکن تست ویرایش شده'
    });
    log('به‌روزرسانی انجام شد');

  } catch (error) {
    log('خطا در تست:', error);
    throw error;
  }
}

// تابع پاک‌سازی داده‌های تست
async function cleanupTestData() {
  log('پاک‌سازی داده‌های تست...');
  
  try {
    const tables = ['players', 'coaches', 'sessions', 'payments', 'competitions', 'training_plans', 'shared_backups'];
    
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
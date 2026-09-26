# الاسترجاع والتراجع (Recovery & Rollback)

القاعدة: **لا تضيع أي بيانات بصمت.** كل كتابة على `ayyam_data` تحفظ النسخة السابقة أولًا.

## أين توجد النسخ؟

| المكان | ماذا فيه | من يقرؤه |
|---|---|---|
| `ayyam_snapshots` | نسخة تلقائية قبل **كل** كتابة (من التطبيق الجديد أو القديم). يُحتفظ بآخر 50 + آخر نسخة من كل يوم لمدة 60 يومًا + كل نسخة قبل reset/import/restore لمدة سنة | الخادم فقط (مع مفتاح الجهاز عبر `ayyam_list_snapshots`) |
| `ayyam_recovery_points` | نسخ يدوية دائمة (مثل نسخة Phase 0) ونسخ الأرشفة عند التراجع | الخادم فقط (SQL Editor) |
| `backups/*.json` على جهاز المطوّر | تصدير كامل قبل أي تغيير كبير | ملف محلي، غير مرفوع على GitHub |
| زر «تصدير نسخة احتياطية» في التطبيق | نسخة من الجهاز | أنت |

## استرجاع حالة سابقة (من SQL Editor في Supabase)

```sql
-- 1) اعرض النسخ المتاحة (الأحدث أولًا)
select id, revision, epoch, reason, created_at,
       (select count(*) from jsonb_object_keys(data->'logs')) as log_days
from public.ayyam_snapshots order by id desc limit 30;

-- 2) الاسترجاع الآمن: كتابة عادية تحفظ الحالة الحالية أولًا وترفع الـepoch
--    (فلا يستطيع جهاز قديم إعادة الحالة الخاطئة). ضع رقم النسخة ورقم المراجعة الحالي:
select public.ayyam_restore(
  '<DEVICE_KEY>',
  <snapshot_id>,
  (select revision from public.ayyam_data where id = 'main'),
  gen_random_uuid()
);
```

للاسترجاع من `ayyam_recovery_points` (مثل نسخة Phase 0 رقم 1) بنفس الطريقة الآمنة:

```sql
select public.ayyam_commit(
  '<DEVICE_KEY>',
  (select revision from public.ayyam_data where id = 'main'),
  (select data from public.ayyam_recovery_points where id = 1),
  gen_random_uuid(),
  'restore'
);
```

## التراجع عن migration الـPhase 1

فقط إذا **لم** يُنشر التطبيق الجديد (v2) بعد:

1. شغّل `supabase/rollback/20260927000200_down.sql` في SQL Editor.
2. النتيجة: يرجع الـschema كما كان، بيانات `ayyam_data` لا تُلمس، وكل snapshots تُنسخ إلى `ayyam_recovery_points` قبل حذف جداولها.

هذا السيناريو مُختبر آليًا (`tests/db/migrations.test.mjs`).

## مفتاح الجهاز

- يُخزَّن على الخادم كـbcrypt hash فقط في `ayyam_config` (لا يقرؤه المتصفح).
- التعيين أو التغيير (من SQL Editor فقط):

  ```sql
  select public.ayyam_set_device_key('<new key, 16+ chars>');
  ```

- بعد تغيير المفتاح أدخل المفتاح الجديد على كل جهاز.

# خطة النشر والتراجع للإنتاج (Production Rollout & Rollback)

القاعدة الحاكمة: **لا تُفقد أي بيانات بصمت.** كل خطوة هنا قابلة للتراجع، وكل كتابة على `ayyam_data` تأخذ لقطة (snapshot) أولًا. راجع أيضًا [`RECOVERY.md`](RECOVERY.md).

النشر **يدوي بالكامل ويقوم به المالك**. لا شيء في هذه الوثيقة يُنشر تلقائيًا من `reliability-v2`.

---

## خريطة الترحيلات (migrations) ومقابلها من المراحل

| الملف | المرحلة | الحالة على Production |
|---|---|---|
| `20260927000100_baseline.sql` | Phase 1 (المزامنة السحابية) | مُطبَّق |
| `20260927000200_revision_snapshots_device_key.sql` | Phase 1 (revision + snapshots + device key) | مُطبَّق |
| `20260927000300_push_delivery_v2.sql` | Phase 4 (نظام الإشعارات) | **معلّق — يُطبَّق في هذا النشر** |
| `20260927000400_commit_accept_enriched.sql` | Phase 3/6 (قبول شكل enriched + epoch مُشتق من البيانات) | **معلّق — يُطبَّق في هذا النشر** |

> `20260927000400` ضروري قبل نشر واجهة v2: بدونه يرفض `ayyam_commit` حمولة المزامنة الجديدة (`reg/tomb`). طبِّق `000300` ثم `000400` بهذا الترتيب.

---

## قائمة التحقق قبل النشر (Rollout Checklist)

نفِّذها **بالترتيب**. لا تنتقل لخطوة قبل التحقق من سابقتها.

1. **تأكيد نسخة Phase 0 الاحتياطية.** تأكد أن نقطة الاسترجاع الأصلية ما زالت موجودة:
   ```sql
   select id, reason, created_at from public.ayyam_recovery_points order by id;
   ```
   يجب أن تظهر نسخة Phase 0. لا تحذفها.

2. **تسجيل بصمة/عدّ/مراجعة بيانات الإنتاج الحالية** (نقطة مقارنة قبل/بعد):
   ```sql
   select revision, epoch,
          (select count(*) from jsonb_object_keys(data->'logs'))     as log_days,
          (select count(*) from jsonb_object_keys(data->'template')) as tpl_days,
          md5(data::text) as data_hash
   from public.ayyam_data where id = 'main';
   ```
   احفظ الناتج خارج القاعدة (نسخة نصية). ستُقارن به في الخطوتين 11 و13.

3. **تطبيق ترحيلات Phase 4 (والمعلّقة).** طبِّق بالترتيب:
   ```bash
   supabase db push   # يطبّق 000300 ثم 000400 (وأي معلّق) بترتيب الطابع الزمني
   ```
   أو نفِّذ ملفَّي `000300` ثم `000400` يدويًا في SQL Editor. تحقق:
   ```sql
   select proname from pg_proc where proname in
     ('push_enqueue','push_claim','push_mark_sent','register_push');   -- موجودة
   -- ويقبل ayyam_commit شكل enriched (اختبار جاف بمفتاح خاطئ = unauthorized وليس invalid)
   ```

4. **نشر دالة `ayyam-reminders` (v2).**
   ```bash
   supabase functions deploy ayyam-reminders --project-ref oiyfhymdjvsvodkzzive
   ```

5. **ضبط `CRON_SECRET` في أسرار الدالة** (قيمة قوية عشوائية، لا تدخل المستودع):
   ```bash
   supabase secrets set CRON_SECRET=<STRONG_RANDOM> --project-ref oiyfhymdjvsvodkzzive
   # وكذلك مفاتيح VAPID: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (إن لم تُضبط)
   ```

6. **التحقق من سر Vault `ayyam_cron_secret`** (نفس قيمة `CRON_SECRET`):
   ```sql
   select vault.create_secret('<STRONG_RANDOM>', 'ayyam_cron_secret');  -- أول مرة فقط
   select name from vault.secrets where name = 'ayyam_cron_secret';     -- للتأكد من الوجود
   ```
   يجب أن تتطابق قيمة Vault مع `CRON_SECRET` في الدالة، وإلا فكل نداء cron يرجع 401.

7. **تطبيق/تحديث إعداد cron.** شغّل `supabase/setup-reminders.sql` (يلغي الجداول القديمة ويجدول `ayyam-reminders` كل 5 دقائق):
   ```sql
   -- محتوى supabase/setup-reminders.sql
   select jobname, schedule from cron.job where jobname = 'ayyam-reminders';  -- للتأكد
   ```

8. **اختبار تفويض نقطة الإشعارات (Smoke).** بدون السر يجب أن تُرفض، ومع السر تنجح:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" \
     https://oiyfhymdjvsvodkzzive.supabase.co/functions/v1/ayyam-reminders            # 401
   curl -s -o /dev/null -w "%{http_code}\n" -H "X-Cron-Secret: <STRONG_RANDOM>" \
     https://oiyfhymdjvsvodkzzive.supabase.co/functions/v1/ayyam-reminders            # 200
   ```

9. **نشر واجهة v2** (الملفات الثابتة على Vercel من `reliability-v2` بعد الدمج المعتمد). تأكد أن `vercel.json` منشور (رؤوس CSP فعّالة).

10. **التحقق من تدفق مفتاح الجهاز لأول مرة.** على جهاز نظيف: افتح التطبيق ← يُطلب مفتاح المزامنة مرة واحدة ← أدخله ← لا يظهر المفتاح في أي مكان (الواجهة/التشخيص/الـconsole).

11. **التحقق من سحب المزامنة (pull).** بعد إدخال المفتاح يجب أن تظهر بيانات الإنتاج نفسها. قارن `log_days`/`revision` بالخطوة 2.

12. **إجراء تعديل اختباري بسيط** (مهمة باسم `اختبار النشر` مثلًا) وحفظه.

13. **التحقق من زيادة revision + وجود snapshot.**
    ```sql
    select revision, epoch from public.ayyam_data where id='main';                 -- revision زاد
    select id, reason, created_at from public.ayyam_snapshots order by id desc limit 3;
    ```
    احذف المهمة الاختبارية بعدها (تعديل عادي، يأخذ snapshot أيضًا).

14. **التحقق من إعادة تسجيل الإشعارات.** اضغط 🔔، امنح الإذن:
    ```sql
    select count(*) from public.push_subscriptions where is_active;                -- ≥ 1
    ```

15. **التحقق من التعديل دون اتصال ثم إعادة الاتصال.** فعّل وضع الطيران، عدّل مهمة، أعد الاتصال ← يُرفع التغيير، لا فقدان بيانات، `تغييرات غير مرفوعة = ٠` في التشخيص.

16. **التحقق من تحديث/تثبيت الـSW.** بعد نشر إصدار SW جديد يظهر شريط التحديث؛ الضغط عليه يعيد التحميل على إصدار متماسك دون فقدان تعديل معلّق.

17. **التحقق من خلوّ الـconsole من أخطاء** وقت التشغيل (بما فيها انتهاكات CSP = صفر).

18. **إبقاء نقاط الاسترجاع القديمة دون مساس.** لا تحذف `ayyam_recovery_points` ولا snapshots السابقة.

---

## خطة التراجع (Rollback)

يوجد سيناريوهان منفصلان. لا يكفي «أرجع الـcommit».

### الحالة A: تراجع الخلفية (Backend) قبل نشر الواجهة

الوضع: طبّقت ترحيلات/دالة/cron لكن واجهة v2 **لم تُنشر بعد** (المستخدمون ما زالوا على v1 القديمة).

خطوات التراجع:
- **cron:** أوقف الجدولة فورًا حتى لا تُرسل إشعارات من إعداد نصف-منشور:
  ```sql
  select cron.unschedule(jobid) from cron.job where jobname = 'ayyam-reminders';
  ```
- **الدالة:** لا حاجة لحذفها؛ بدون cron لن تُستدعى. اختياريًا احذف أسرارها.
- **جداول push:** `push_subscriptions/push_reminders/push_deliveries` جداول جديدة مستقلة؛ وجودها فارغة لا يضر v1. اتركها أو أفرغها:
  ```sql
  truncate public.push_deliveries, public.push_reminders, public.push_subscriptions;
  ```

الأثر على كل مكوّن في الحالة A:

| المكوّن | الأثر | إجراء |
|---|---|---|
| **schema** | `000300`/`000400` **متوافقة إلى الخلف**: `000400` يوسّع `ayyam_commit` ليقبل الشكلين (القديم materialized والجديد enriched)، فـv1 القديمة تظل تكتب بنجاح. | لا تراجع للـschema مطلوب؛ آمن الإبقاء. |
| **device key** | لا يتغير؛ نفس التجزئة في `ayyam_config`. | لا شيء. |
| **epoch** | لم يتغير (لا reset/import). | لا شيء. |
| **snapshots** | تتراكم كالمعتاد. | لا تحذف. |
| **IndexedDB** | لم يُنشر عميل v2، فلا مخزن جديد على أجهزة المستخدمين. | لا شيء. |
| **SW caches** | لم يُنشر SW جديد. | لا شيء. |
| **push tables** | فارغة/غير مستخدمة. | truncate اختياري. |
| **cron** | يجب **إيقافه** (الإجراء الوحيد الإلزامي). | `cron.unschedule`. |

> إن أردت التراجع عن `000200` تحديدًا يوجد `supabase/rollback/20260927000200_down.sql` — لكنه يحذف snapshots/device-key؛ **لا تستخدمه إلا بعد أخذ نسخة كاملة** ولا لزوم له في الحالة A.

### الحالة B: الواجهة v2 مُنشورة بالفعل ونحتاج التراجع

الوضع: عميل v2 وصل لأجهزة المستخدمين (IndexedDB + SW v2 + مفتاح جهاز + شكل enriched على الخادم)، ثم قررنا العودة لـv1.

المبدأ: **العودة إلى v1 مقبولة لأن الخلفية متوافقة إلى الخلف**؛ v1 القديمة تقرأ/تكتب الشكل materialized، والخادم يقبله. لكن انتبه للنقاط التالية:

| المكوّن | الأثر عند التراجع لـv1 | إجراء آمن |
|---|---|---|
| **schema** | يبقى كما هو (متوافق خلفيًا). **لا تُنزّل schema** — إنزاله يحذف بيانات. | لا تراجع للـschema. اترك `000300/000400`. |
| **device key** | v1 لا تستخدم مفتاح جهاز؛ تتجاهله. القيمة تبقى في `ayyam_config` لعودة v2 لاحقًا. | اتركه. |
| **epoch** | v1 لا تكتب epoch؛ الخادم يُبقي آخر epoch (`000400` يشتقّه من البيانات). لا ارتداد للأجيال. | لا شيء. |
| **snapshots** | مصدر الأمان الأساسي: قبل أي كتابة من v1 أو v2 هناك snapshot. لأي استرجاع استخدم `RECOVERY.md`. | لا تحذف. |
| **IndexedDB** | v1 لا تقرأ مخزن v2 (`ayyam`)؛ تعود لتخزينها القديم (localStorage). **قد تبقى تعديلات معلّقة في outbox على أجهزة كانت offline** لم تُرفع. | قبل التراجع: تأكد أن `تغييرات غير مرفوعة = ٠` على الأجهزة النشطة، أو اطلب من المستخدم فتح v2 مرة أخيرة متصلًا حتى يُفرَّغ الـoutbox. |
| **SW caches** | SW v2 يقدّم أصول v2 من الكاش. نشر v1 وحده لا يكفي — **يجب إبطال SW القديم** وإلا يظل يخدم v2 من الكاش. | انشر `sw.js` جديدًا بإصدار أعلى (يُخدَّم `no-store` من `vercel.json`) يُنظّف الكاش القديم عند التفعيل، أو انشر SW صغيرًا يستدعي `caches.delete` لكل كاش `ayyam-*` ثم `skipWaiting`. تحقق من اختفاء كاش `ayyam-app-5.1.0`. |
| **push tables** | إشعارات v1 القديمة (إن وُجدت) مختلفة. اشتراكات v2 تبقى صالحة على الخادم. | إن أوقفت إشعارات v2 أوقف cron (`cron.unschedule`)؛ لا تحذف الاشتراكات إن كنت ستعود لـv2. |
| **cron** | يستمر بإرسال إشعارات v2. | أوقفه إن لم تعد v1 تدعم نفس الإشعارات: `cron.unschedule`. |

**خلاصة الحالة B:** التراجع = (1) نشر واجهة v1 القديمة، (2) نشر SW يُبطل كاش v2 وينظّفه، (3) إيقاف cron إن لزم، (4) **عدم إنزال الـschema ولا حذف snapshots/device-key/اشتراكات**، (5) التأكد من تفريغ outbox على الأجهزة قبل التخلي عن مخزن v2. أي استرجاع لبيانات يُنفَّذ من snapshots عبر `RECOVERY.md`.

---

## بعد النشر
- أبقِ فرع `reliability-v2` والوسوم حتى استقرار الإنتاج.
- راقب `push_deliveries` (حالات `failed`/`retry`) وأخطاء الدالة أول 24 ساعة.
- لا تحذف أي نقطة استرجاع قبل مرور فترة أمان (≥ أسبوع من التشغيل السليم).

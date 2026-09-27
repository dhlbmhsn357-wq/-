(async function(){
  "use strict";

  // Native Android shell detection (Capacitor). FALSE on web/PWA (AyyamNative is injected only inside
  // the APK by build-webdir), so every native-guarded branch below is a no-op on the web.
  const NATIVE = (typeof AyyamNative !== 'undefined') && AyyamNative.isNativeAndroid && AyyamNative.isNativeAndroid();

  const BG_URL = 'bg.jpg'; // loaded only when the background is enabled

  const PERIODS = [
    {key:'fajr',    label:'الفجر',    color:'#7C93C4'},
    {key:'dhuhr',   label:'الظهر',    color:'#E8B84B'},
    {key:'asr',     label:'العصر',    color:'#C4703A'},
    {key:'maghrib', label:'المغرب',   color:'#B9456B'},
    {key:'isha',    label:'العشاء',   color:'#4A5A8C'},
  ];
  const PERIOD_MAP = Object.fromEntries(PERIODS.map(p=>[p.key,p]));

  const DAY_CODES = ['sat','sun','mon','tue','wed','thu','fri'];
  const DAY_LABELS = {sat:'السبت', sun:'الأحد', mon:'الاثنين', tue:'الثلاثاء', wed:'الأربعاء', thu:'الخميس', fri:'الجمعة'};
  const DAY_LABELS_SHORT = {sat:'سبت', sun:'أحد', mon:'اثنين', tue:'ثلاثاء', wed:'أربعاء', thu:'خميس', fri:'جمعة'};
  // JS getDay(): 0=Sun..6=Sat -> map to our codes
  const JSDAY_TO_CODE = {0:'sun',1:'mon',2:'tue',3:'wed',4:'thu',5:'fri',6:'sat'};

  let idSeq = 1;
  const nid = ()=> 't'+(idSeq++)+'_'+Date.now().toString(36);

  function td(period,title,time){ return {id:nid(), period, title, time}; }

  // القالب المشترك لأغلب الأيام (السبت، الأحد، الثلاثاء، الأربعاء): الجيم من المغرب للعشاء
  function commonDayGym(){
    return [
      td('dhuhr','ورد القرآن / الشغل','الظهر – ٣:٣٠'),
      td('asr','تحضير لمجلس العصر','٣:٣٠ – العصر'),
      td('asr','مجلس العصر + الشغل','العصر – المغرب'),
      td('maghrib','الجيم','المغرب – العشاء'),
      td('isha','خارطة الثغور (ساعتان)','العشاء – الفجر'),
      td('isha','اجتماع النقط + حفظ القرآن + المعهد القرآني للامتحانات','العشاء – الفجر'),
      td('isha','الدعوي (تحضير)','العشاء – الفجر'),
    ];
  }
  // الاثنين والخميس: فطار من المغرب للعشاء بدل الجيم (بسبب الصيام)
  function fastingDayIftar(){
    return [
      td('dhuhr','ورد القرآن / الشغل','الظهر – ٣:٣٠'),
      td('asr','تحضير لمجلس العصر','٣:٣٠ – العصر'),
      td('asr','مجلس العصر + الشغل','العصر – المغرب'),
      td('maghrib','فطار','المغرب – العشاء'),
      td('isha','خارطة الثغور (ساعتان)','العشاء – الفجر'),
      td('isha','اجتماع النقط + حفظ القرآن + المعهد القرآني للامتحانات','العشاء – الفجر'),
      td('isha','الدعوي (تحضير)','العشاء – الفجر'),
    ];
  }
  const FRIDAY = [
    td('fajr','النوم','٦:٣٠ – ١١:٣٠'),
    td('fajr','مجلس تزكية','بعد الفجر'),
    td('fajr','ورد القيام + قراءة السورة المفصل + ركعتا الوتر','قبل الفجر'),
    td('dhuhr','ورد التلاوة + سماع التفسير','١٢ – الظهر'),
    td('dhuhr','جلسة الضحى / إفطار',''),
    td('dhuhr','خروجة','الظهر – العصر'),
    td('asr','صلة الرحم + دعاء الجمعة','العصر – المغرب'),
    td('maghrib','جلسة التقييم','المغرب – العشاء'),
    td('isha','جلسة مع الصحبة','العشاء – الفجر'),
  ];

  // STABLE ids for the default schedule (same on every device): so two fresh devices that both seed
  // the defaults converge to the SAME task set instead of duplicating it, and the enriched model
  // never mistakes a reload for a delete+re-add.
  function defaultTemplate(){
    const withStableIds = (day, arr) => arr.map((t,i)=>({...t, id:'def-'+day+'-'+i}));
    return {
      sat: withStableIds('sat', commonDayGym()),
      sun: withStableIds('sun', commonDayGym()),
      mon: withStableIds('mon', fastingDayIftar()),
      tue: withStableIds('tue', commonDayGym()),
      wed: withStableIds('wed', commonDayGym()),
      thu: withStableIds('thu', fastingDayIftar()),
      fri: withStableIds('fri', FRIDAY),
    };
  }


  // ---------- storage (Supabase-backed, with local cache fallback) ----------
  const SUPABASE_URL = 'https://oiyfhymdjvsvodkzzive.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9peWZoeW1kanZzdm9ka3p6aXZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyNzkyOTYsImV4cCI6MjA5ODg1NTI5Nn0.OWcXtMZ2j6ge5bKfQYeP8xrDGt4W8oQuct3xZAbOyqE';
  const ROW_ID = 'main'; // single-user app: one fixed row holds everything
  // If the Supabase library failed to load (CDN down / offline first run) the app still works locally.
  const sb = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
  const SYNC_TIMEOUT_MS = 10000;
  const APP_VERSION = '5.1.1'; // bump per release; kept in step with sw.js SW_VERSION

  const LS_TPL = 'ayyam_template_v1';
  const LS_LOG = 'ayyam_logs_v1';
  const LS_PREFS = 'ayyam_prefs_v1';
  const LS_CACHE = 'ayyam_cloud_cache_v1'; // latest local state (includes edits not yet synced)
  const LS_BASE = 'ayyam_sync_base_v1';    // exact server state after the last successful sync
  const LS_PENDING = 'ayyam_sync_pending_v1'; // '1' while there are local edits not yet on the server

  let syncState = 'idle'; // idle | syncing | error | offline
  let lastSyncOkAt = null; // ms epoch of the last successful sync (diagnostics only)
  let saveTimer = null;

  function updateSyncBadge(){
    const el = document.getElementById('syncBadge');
    if(!el) return;
    const map = {
      idle:   {text:'', show:false},
      syncing:{text:'⏳ جارِ المزامنة...', show:true},
      saved:  {text:'☁️ تمت المزامنة', show:true},
      error:  {text:'⚠️ تعذّرت المزامنة — محفوظ على الجهاز', show:true},
      offline:{text:'📴 غير متصل — محفوظ على الجهاز، سيُرفع لاحقًا', show:true},
      'need-key':{text:'🔑 أدخل مفتاح المزامنة', show:true},
    };
    // A failed local save takes precedence: never show "saved" when the device could not store it.
    const s = storageError
      ? {text:'⚠️ تعذّر الحفظ على الجهاز — التغيير في الذاكرة فقط', show:true}
      : (map[syncState] || map.idle);
    el.style.cursor = (syncState==='need-key') ? 'pointer' : '';
    el.textContent = s.text;
    el.classList.toggle('hidden', !s.show);
    if(syncState==='saved'){
      clearTimeout(updateSyncBadge._t);
      updateSyncBadge._t = setTimeout(()=>{ syncState='idle'; updateSyncBadge(); }, 2500);
    }
  }

  // ---------- durable local storage (IndexedDB primary, localStorage as fallback mirror) ----------
  // The stored/synced unit is the "enriched" value (LWW registers + tombstones + epoch) from
  // AyyamModel. The app renders the materialized bundle produced from it. localStorage keeps a
  // best-effort mirror so the app still works if IndexedDB is blocked (private mode).
  const M = (typeof AyyamModel !== 'undefined') ? AyyamModel : null;
  const LS_ENRICHED = 'ayyam_enriched_v2';
  const LS_BASE_V2  = 'ayyam_base_v2';
  const LS_DEVICE_ID = 'ayyam_device_id_v1';
  let store = null;            // AyyamStore instance, or null in degraded (localStorage-only) mode
  let storageDegraded = false; // true once we know IndexedDB is unusable
  let enriched = M ? M.empty(0) : null;   // current enriched state
  let baseEnriched = M ? M.empty(0) : null; // last server-confirmed enriched
  let baseRevision = null;     // server revision of baseEnriched (null = not yet known)
  let pendingMem = false;      // "there are unsynced local changes"

  function newId(){ return (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-'+Date.now()+'-'+Math.random().toString(36).slice(2); }
  function deviceId(){
    let id;
    try{ id = localStorage.getItem(LS_DEVICE_ID); }catch(e){}
    if(!id){ id = newId(); try{ localStorage.setItem(LS_DEVICE_ID, id); }catch(e){} }
    return id;
  }
  const DEVICE_ID = deviceId();

  function isEnriched(v){ return isObj(v) && v.v===2 && isObj(v.reg); }
  function lsMirrorEnriched(en){ try{ localStorage.setItem(LS_ENRICHED, JSON.stringify(en)); }catch(e){} }

  // Persist a user edit atomically (state + one pending op with a fresh op_id). Throws if not durable.
  async function persistEnrichedEdit(en, reason){
    const opId = (self.crypto&&crypto.randomUUID)?crypto.randomUUID():'op'+Date.now()+Math.random();
    if(store){
      await store.saveEdit(en, opId, { reason: reason || 'sync', base_revision: baseRevision });
      lsMirrorEnriched(en);
      return opId;
    }
    localStorage.setItem(LS_ENRICHED, JSON.stringify(en)); // degraded: throws surface as "not saved"
    try{ localStorage.setItem(LS_PENDING, '1'); }catch(e){}
    return opId;
  }
  async function persistEnrichedState(en){ // adopt server-merged result (no new pending op)
    if(store){ await store.saveState(en); lsMirrorEnriched(en); return; }
    lsMirrorEnriched(en);
  }
  async function persistBaseV2(en, revision){
    baseEnriched = en; baseRevision = revision;
    if(store){ try{ await store.putBase({ data: en, revision, epoch: en.epoch }); }catch(e){} }
    try{ localStorage.setItem(LS_BASE_V2, JSON.stringify({ data: en, revision })); }catch(e){}
  }

  function isPending(){ return pendingMem; }
  function setPending(on){
    pendingMem = on;
    if(on){ try{ localStorage.setItem(LS_PENDING,'1'); }catch(e){} }
    else { try{ localStorage.removeItem(LS_PENDING); }catch(e){} }
  }
  async function clearPending(en, revision){
    setPending(false);
    await persistBaseV2(en, revision);
    if(store){ try{ const op = await store.pendingOp(); if(op) await store.confirmOutbox(op.op_id); }catch(e){} }
  }

  // Load a materialized-or-enriched local value and a base, upgrading v1/Phase-2 shapes to enriched.
  // Pending local changes are preserved: they are diffed against the base and stamped as newest.
  function buildEnrichedFrom(stateRaw, baseRaw){
    const nowT = Date.now();
    if(isEnriched(stateRaw)){
      const b = isEnriched(baseRaw && baseRaw.data) ? baseRaw.data : (baseRaw && baseRaw.data ? M.toEnriched(sanitizeBundle(baseRaw.data),1) : M.empty(stateRaw.epoch));
      return { en: stateRaw, base: b, rev: baseRaw ? (baseRaw.revision ?? null) : null };
    }
    // v1 / Phase-2 materialized state → enrich, stamping only the pending diff (vs base) as new
    const baseMat = baseRaw && baseRaw.data ? sanitizeBundle(baseRaw.data) : null;
    const baseEn = baseMat ? M.toEnriched(baseMat, 1) : M.empty(0);
    const localMat = stateRaw ? sanitizeBundle(stateRaw) : null;
    const en = localMat ? M.enrich(baseEn, localMat, nowT, DEVICE_ID) : (baseMat ? baseEn : null);
    return { en, base: baseEn, rev: baseRaw ? (baseRaw.revision ?? null) : null };
  }

  // Open IndexedDB, migrate once from localStorage (non-destructive), load + upgrade to enriched.
  async function initStorage(){
    try{
      if(!(typeof AyyamStore !== 'undefined' && AyyamStore.available() && M)) throw new Error('no idb/model');
      store = await AyyamStore.open();
      await store.migrateFromLocalStorage(k=>{ try{ return localStorage.getItem(k); }catch(e){ return null; } }, sanitizeBundle);
      const stateRaw = await store.getState();
      const baseRaw = await store.getBase();
      const built = buildEnrichedFrom(stateRaw, baseRaw);
      pendingMem = (await store.outboxCount()) > 0;
      if(built.en){
        enriched = built.en; baseEnriched = built.base; baseRevision = built.rev;
        if(!isEnriched(stateRaw)) await persistEnrichedState(enriched); // store upgraded shape once
        store.logDiag({ type:'startup', pending: pendingMem, epoch: enriched.epoch });
        return { state: M.materialize(enriched), degraded:false };
      }
      store.logDiag({ type:'startup-empty' });
      return { state:null, degraded:false };
    }catch(e){
      // IndexedDB unavailable → localStorage-only mode.
      store = null; storageDegraded = true;
      let sRaw=null, bRaw=null;
      try{ const raw = localStorage.getItem(LS_ENRICHED); if(raw) sRaw = JSON.parse(raw); }catch(_){}
      if(!sRaw){ try{ const raw = localStorage.getItem(LS_CACHE); if(raw) sRaw = JSON.parse(raw); }catch(_){} } // Phase-2/v1 cache
      try{ const raw = localStorage.getItem(LS_BASE_V2); if(raw) bRaw = JSON.parse(raw); }catch(_){}
      if(!bRaw){ try{ const raw = localStorage.getItem(LS_BASE); if(raw) bRaw = { data: JSON.parse(raw), revision:null }; }catch(_){} }
      try{ if(localStorage.getItem(LS_PENDING)==='1') pendingMem = true; }catch(_){}
      const built = M ? buildEnrichedFrom(sRaw, bRaw) : { en:null };
      if(built.en){ enriched = built.en; baseEnriched = built.base; baseRevision = built.rev; return { state: M.materialize(enriched), degraded:true }; }
      return { state:null, degraded:true };
    }
  }

  function defaultPrefs(){ return {theme:'night', bgOn:true, bgOpacity:72, bgBlur:0, location:null}; }

  // ---------- data validation ----------
  // Everything read from the server or localStorage goes through here, so a single bad
  // value can never crash rendering (it is dropped or replaced with a safe default).
  const isObj = v => v!==null && typeof v==='object' && !Array.isArray(v);
  const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const EPOCH_KEY = '0000-00-00'; // sorts before every real date key

  function cleanTask(t){
    if(!isObj(t) || typeof t.id!=='string' || !t.id) return null;
    return {
      id: t.id,
      title: typeof t.title==='string' ? t.title : String(t.title ?? ''),
      time: typeof t.time==='string' ? t.time : '',
      period: PERIOD_MAP[t.period] ? t.period : null,
    };
  }
  function cleanList(a){ return Array.isArray(a) ? a.map(cleanTask).filter(Boolean) : []; }
  function cleanFlags(o){
    const r = {};
    if(isObj(o)) Object.keys(o).forEach(k=>{ if(o[k]===true) r[k] = true; });
    return r;
  }
  function cleanOverrides(o){
    const r = {};
    if(isObj(o)) Object.keys(o).forEach(k=>{
      const v = o[k];
      if(isObj(v) && typeof v.title==='string' && v.title){
        r[k] = { title: v.title, time: typeof v.time==='string' ? v.time : '', period: PERIOD_MAP[v.period] ? v.period : null };
      }
    });
    return r;
  }
  function cleanTemplate(t){
    if(!isObj(t)) return defaultTemplate();
    const out = {};
    DAY_CODES.forEach(c=> out[c] = cleanList(t[c]));
    return out;
  }
  function logHasActivity(l){
    return Object.keys(l.done).length || l.extra.length || Object.keys(l.hidden).length || Object.keys(l.overrides).length;
  }
  // Location for prayer-time reminders (read by the ayyam-reminders edge function); null = Cairo default.
  function cleanLocation(l){
    if(!isObj(l)) return null;
    const lat = Number(l.lat), lng = Number(l.lng);
    if(!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat)>90 || Math.abs(lng)>180) return null;
    return { lat, lng, tz: typeof l.tz==='string' && l.tz ? l.tz : 'Africa/Cairo' };
  }
  function sanitizeBundle(raw){
    const src = isObj(raw) ? raw : {};
    const template = cleanTemplate(src.template);
    const logs = {};
    if(isObj(src.logs)) Object.keys(src.logs).forEach(k=>{
      const l = src.logs[k];
      if(!DATE_KEY_RE.test(k) || !isObj(l)) return;
      const clean = { done: cleanFlags(l.done), extra: cleanList(l.extra), hidden: cleanFlags(l.hidden), overrides: cleanOverrides(l.overrides) };
      if(logHasActivity(clean)) logs[k] = clean; // empty day entries carry no information
    });
    // Template history: `template` applies from tplArchive.since onward; each archived version applies
    // from its id (a date key) until the next version. Old data without it = one template for all dates.
    const a = isObj(src.tplArchive) ? src.tplArchive : {};
    const tplArchive = {
      since: typeof a.since==='string' && DATE_KEY_RE.test(a.since) ? a.since : EPOCH_KEY,
      versions: Array.isArray(a.versions)
        ? a.versions.filter(v=>isObj(v) && typeof v.id==='string' && DATE_KEY_RE.test(v.id))
            .map(v=>({ id: v.id, template: cleanTemplate(v.template) }))
        : [],
    };
    const p = isObj(src.prefs) ? src.prefs : {};
    const d = defaultPrefs();
    const num = (v,min,max,def)=> Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
    const prefs = {
      theme: p.theme==='day' ? 'day' : 'night',
      bgOn: typeof p.bgOn==='boolean' ? p.bgOn : d.bgOn,
      bgOpacity: num(p.bgOpacity, 30, 95, d.bgOpacity),
      bgBlur: num(p.bgBlur, 0, 10, d.bgBlur),
      location: cleanLocation(p.location),
    };
    return {template, logs, prefs, tplArchive};
  }

  // The v2 conflict engine lives in js/sync-model.js (LWW registers + tombstones + epoch). The old
  // v1 three-way object merge was removed here when the CAS engine replaced it.

  function withTimeout(p, ms){
    let t;
    return Promise.race([p, new Promise((_, rej)=>{ t = setTimeout(()=>rej(new Error('timeout')), ms); })])
      .finally(()=> clearTimeout(t));
  }
  const clone = o => JSON.parse(JSON.stringify(o));
  function currentBundle(){ return {template, logs, prefs, tplArchive}; }
  function setState(s){ template = s.template; logs = s.logs; prefs = s.prefs; tplArchive = s.tplArchive; }

  // Applies a merged/adopted enriched value to the visible state and refreshes the view.
  async function adoptEnriched(en, persist){
    enriched = en;
    setState(M.materialize(en));
    if(persist) await persistEnrichedState(en);
    applyPrefs();
    if(!$('mainView').classList.contains('hidden')) render();
    if(!$('settingsView').classList.contains('hidden')){ renderTplDays(); renderTplTasks(); }
    if(!$('reportsView').classList.contains('hidden')) renderReports();
    scheduleWidgetPush(); // adopt/merge/pull/reset changed today's data → refresh widget snapshot
  }

  // ---------- device key (per device, entered once; never shown/logged/committed) ----------
  const LS_DEVICE_KEY = 'ayyam_device_key_v1';
  // On native Android the key lives in Android Keystore-backed secure storage (hydrated into memory at
  // startup so these stay synchronous). On web it stays in localStorage exactly as before.
  function getDeviceKey(){ if(NATIVE) return AyyamNative.getKeyCached(); try{ return localStorage.getItem(LS_DEVICE_KEY) || ''; }catch(e){ return ''; } }
  let secureWarned = false;
  function setDeviceKey(k){
    if(NATIVE){
      try{ AyyamNative.setKey(k).then(r=>{
        if(store) store.logDiag({ type:'secure-set', backing:(r&&r.backing)||'?', degraded:!!(r&&r.degraded) }); // no key value, ever
        if(r && r.degraded && !secureWarned){ secureWarned = true; alert('تعذّر حفظ مفتاح المزامنة في التخزين الآمن على هذا الجهاز؛ سيُحفظ محليًا. قد تحتاج إعادة إدخاله لاحقًا.'); }
      }).catch(()=>{}); }catch(e){}
      return;
    }
    try{ k ? localStorage.setItem(LS_DEVICE_KEY, k) : localStorage.removeItem(LS_DEVICE_KEY); }catch(e){}
  }
  let needsKey = false; // true when the server rejected our key (or none set) and we have changes to sync
  // Entered once per device, kept only in this device's localStorage. Never shown elsewhere or logged.
  function promptForKey(){
    const k = window.prompt('مفتاح المزامنة (يُدخل مرة واحدة على هذا الجهاز لحماية بياناتك):', '');
    if(k === null) return;
    const key = k.trim();
    if(key.length < 16){ alert('المفتاح قصير جدًا. انسخه كما هو من جهازك الآخر.'); return; }
    setDeviceKey(key);
    needsKey = false;
    syncNow();
  }

  async function rpc(fn, args){
    if(!sb) throw new Error('supabase unavailable');
    const { data, error } = await withTimeout(sb.rpc(fn, args), SYNC_TIMEOUT_MS);
    if(error) throw error;
    return data;
  }

  const MAX_ATTEMPTS = 6;
  const backoff = a => Math.min(1000 * Math.pow(2, a), 15000) + Math.floor(Math.random()*400);
  const sleep = ms => new Promise(r=>setTimeout(r, ms));
  let syncing = false, syncQueued = false, changeSeq = 0;
  // Retry a FAILED sync a few times with backoff (e.g. the network wasn't quite ready right after an
  // 'online' event). Without this a single failed reconnect-sync would wait for the next focus/online.
  let retryTimer = null, retryCount = 0;
  const MAX_SYNC_RETRIES = 5;
  function clearSyncRetry(){ clearTimeout(retryTimer); retryTimer = null; retryCount = 0; }
  function scheduleSyncRetry(){
    if(retryTimer || retryCount >= MAX_SYNC_RETRIES || navigator.onLine === false) return;
    retryCount++;
    retryTimer = setTimeout(()=>{ retryTimer = null; syncNow(); }, Math.min(2000 * retryCount, 8000));
  }

  // v2 sync: pull → merge (LWW + tombstones + epoch) → compare-and-swap commit, retrying on conflict
  // with backoff and re-merge; never a forced overwrite. Idempotent by the pending op's op_id.
  async function syncNow(reason){
    clearTimeout(saveTimer); saveTimer = null;
    if(syncing){ syncQueued = true; return; }
    syncing = true;
    const seqAtStart = changeSeq;
    const key = getDeviceKey();
    const hadPending = isPending();
    if(hadPending){ syncState = 'syncing'; updateSyncBadge(); }
    try{
      if(!M) throw new Error('model unavailable');
      if(!key){ if(hadPending){ needsKey = true; syncState = 'need-key'; } return; }
      const op = store ? await store.pendingOp() : null;
      const opId = op ? op.op_id : newId();
      const commitReason = (op && op.reason) || reason || 'sync'; // reason from the durable outbox (survives races)

      for(let attempt=0; attempt<MAX_ATTEMPTS; attempt++){
        const pull = await rpc('ayyam_pull', { p_key: key });
        if(pull.status === 'unauthorized'){ needsKey = true; syncState = 'need-key'; setDeviceKey(''); return; }
        needsKey = false;
        const serverEn = pull.exists ? M.toEnriched(pull.data, 1) : M.empty(0);
        const serverRev = pull.exists ? pull.revision : 0;

        const res = M.merge(baseEnriched || M.empty(0), enriched, serverEn);
        if(res.parked && store) await store.saveRecovery({ reason:'epoch-fence', epoch: res.parked.epoch, data: M.materialize(res.parked) });
        let merged = M.pruneTombstones(res.merged, Date.now());

        // Nothing new to push? adopt server view and finish.
        if(pull.exists && JSON.stringify(merged) === JSON.stringify(serverEn)){
          await adoptEnrichedIfChanged(merged);
          await persistBaseV2(merged, serverRev);
          if(changeSeq===seqAtStart){ await clearPending(merged, serverRev); if(hadPending) syncState='saved'; }
          lastSyncOkAt = Date.now();
          clearSyncRetry();
          return;
        }
        const commit = await rpc('ayyam_commit', { p_key:key, p_expected_revision: serverRev, p_data: merged, p_op_id: opId, p_reason: commitReason });
        if(commit.status === 'unauthorized'){ needsKey = true; syncState='need-key'; setDeviceKey(''); return; }
        if(commit.status === 'conflict'){ await sleep(backoff(attempt)); continue; } // someone wrote first → re-pull/re-merge
        if(commit.status === 'invalid' || commit.status === 'too_large'){ syncState='error'; if(store) store.logDiag({type:'commit-rejected', status:commit.status}); return; }
        // ok or duplicate (duplicate = our earlier write already applied; safe)
        await adoptEnrichedIfChanged(merged);
        await persistBaseV2(merged, commit.revision);
        if(changeSeq===seqAtStart){ await clearPending(merged, commit.revision); if(hadPending) syncState='saved'; }
        else { setPending(true); } // edits arrived during sync → keep pending; will re-run below
        lastSyncOkAt = Date.now();
        clearSyncRetry();
        return;
      }
      syncState = 'error'; // exhausted retries
    }catch(e){
      if(isPending()) syncState = navigator.onLine===false ? 'offline' : 'error';
      if(store) store.logDiag({ type:'sync-error', message: String(e && e.name || 'err') });
      scheduleSyncRetry(); // e.g. the network wasn't ready right after 'online' → try again shortly
    }finally{
      syncing = false;
      updateSyncBadge();
      if(syncQueued || changeSeq!==seqAtStart){ syncQueued = false; setTimeout(()=>syncNow(), 50); }
    }
  }
  async function adoptEnrichedIfChanged(en){
    if(JSON.stringify(en) !== JSON.stringify(enriched)) await adoptEnriched(en, true);
  }

  // Saves an edit durably (state + one pending op), then schedules a sync. Never claims saved on failure.
  // reason 'reset'/'import' start a new epoch generation (fences older devices).
  let storageError = false, storageWarned = false;
  async function saveBundle(reason){
    changeSeq++;
    const now = Date.now();
    if(reason === 'reset' || reason === 'import') enriched = M.bumpEpoch(enriched, currentBundle(), now, DEVICE_ID);
    else enriched = M.enrich(enriched, currentBundle(), now, DEVICE_ID);
    setPending(true);
    syncState = 'syncing';
    updateSyncBadge();
    try{
      await persistEnrichedEdit(enriched, (reason==='reset'||reason==='import') ? reason : 'sync');
      storageError = false;
    }catch(e){
      storageError = true;
      if(store) store.logDiag({ type:'storage-error', message: String(e && e.name || e) });
      if(!storageWarned){
        storageWarned = true;
        alert('تعذّر حفظ التغيير على هذا الجهاز (قد تكون المساحة ممتلئة أو التخزين محظورًا). سنحاول رفعه إلى السحابة، لكن يُفضّل تصدير نسخة احتياطية.');
      }
    }
    updateSyncBadge();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(()=>syncNow(reason==='reset'?'reset':reason==='import'?'import':'sync'), 600);
  }

  // Reconnecting/refocusing/resuming always syncs — to PUSH our changes and PULL other devices'.
  // A short debounce coalesces bursts of these events; syncNow itself is single-flight (no storms).
  let syncDebounce = null, startupDone = false;
  function scheduleSync(){ if(!startupDone) return; clearTimeout(syncDebounce); syncDebounce = setTimeout(()=>syncNow(), 300); }
  window.addEventListener('online', scheduleSync);
  window.addEventListener('focus', scheduleSync);
  window.addEventListener('pageshow', scheduleSync);       // bfcache resume (iOS/Safari)
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState==='hidden'){
      if(saveTimer) syncNow();   // flush a pending edit before backgrounding (local write already done)
    } else {
      scheduleSync();            // refocus/resume: pull others' changes
    }
  });

  function saveTemplate(t){ template = t; saveBundle(); }
  function saveLogs(l){ logs = l; saveBundle(); }
  function savePrefs(p){ prefs = p; saveBundle(); }

  // Real values come from the local cache / Supabase at startup (see bottom of script).
  let template = defaultTemplate();
  let logs = {};
  let prefs = defaultPrefs();
  let tplArchive = { since: EPOCH_KEY, versions: [] };

  // The template in effect on a given date. Editing the template only changes today and later;
  // past days keep the version that was active back then (see beginTemplateEdit).
  function templateFor(key){
    if(key >= tplArchive.since) return template;
    const versions = tplArchive.versions.filter(v=>v.id < tplArchive.since).sort((a,b)=> a.id < b.id ? -1 : 1);
    if(!versions.length) return template;
    let pick = versions[0];
    versions.forEach(v=>{ if(v.id <= key) pick = v; });
    return pick.template;
  }
  // Call before every change to the template: on the first edit of a day, archive the version
  // that applied until yesterday so history and reports stay as they were.
  function beginTemplateEdit(){
    const today = dateKey(new Date());
    if(tplArchive.since >= today) return;
    const keep = tplArchive.versions.filter(v=>v.id!==tplArchive.since);
    tplArchive = { since: today, versions: [...keep, { id: tplArchive.since, template: clone(template) }] };
  }

  function applyPrefs(){
    document.documentElement.setAttribute('data-theme', prefs.theme);
    document.body.classList.toggle('has-bg', !!prefs.bgOn);
    if(prefs.bgOn){
      document.body.style.backgroundImage = "url('" + BG_URL + "')";
    } else {
      document.body.style.backgroundImage = '';
    }
    document.documentElement.style.setProperty('--bg-overlay',
      prefs.theme==='day'
        ? `rgba(255,250,238,${prefs.bgOpacity/100})`
        : `rgba(10,12,16,${prefs.bgOpacity/100})`
    );
    document.documentElement.style.setProperty('--bg-blur', prefs.bgBlur+'px');

    Array.from(document.querySelectorAll('#themeToggle button')).forEach(b=>{
      b.classList.toggle('active', b.dataset.theme===prefs.theme);
    });
    const bgToggle = document.getElementById('bgToggle');
    const bgOpacity = document.getElementById('bgOpacity');
    const bgBlur = document.getElementById('bgBlur');
    if(bgToggle) bgToggle.checked = !!prefs.bgOn;
    if(bgOpacity) bgOpacity.value = prefs.bgOpacity;
    if(bgBlur) bgBlur.value = prefs.bgBlur;
    const locInfo = document.getElementById('locationInfo');
    if(locInfo){
      locInfo.textContent = prefs.location
        ? `المواقيت محسوبة لموقعك (${toArabicNum(prefs.location.lat.toFixed(3))}، ${toArabicNum(prefs.location.lng.toFixed(3))})، ويتحدّث تلقائيًا كل ما تفتح التطبيق في مكان جديد.`
        : 'لم يُحدَّد موقعك بعد، فالمواقيت محسوبة للقاهرة. اضغط «تحديث موقعي الآن» واسمح بالوصول للموقع.';
    }
  }

  function dateKey(d){
    const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }
  function dayCodeFor(d){ return JSDAY_TO_CODE[d.getDay()]; }

  function ensureLog(key){
    if(!logs[key]) logs[key] = {done:{}, extra:[], hidden:{}, overrides:{}};
    if(!logs[key].done) logs[key].done = {};
    if(!logs[key].extra) logs[key].extra = [];
    if(!logs[key].hidden) logs[key].hidden = {};
    if(!logs[key].overrides) logs[key].overrides = {};
    return logs[key];
  }
  // Read-only access for rendering: never creates entries (only real edits should add to the data).
  function readLog(key){ return logs[key] || {done:{}, extra:[], hidden:{}, overrides:{}}; }

  function parseKey(k){ const [y,m,d] = k.split('-').map(Number); return new Date(y, m-1, d); } // local midnight

  // First day the app was actually used (earliest day with any recorded activity), capped at today.
  // Stats and reports ignore earlier days instead of counting them as failures.
  function firstActiveKey(){
    const today = dateKey(new Date());
    let first = today;
    Object.keys(logs).forEach(k=>{ if(k < first && logHasActivity(logs[k])) first = k; });
    return first;
  }

  function tasksForDate(d){
    const code = dayCodeFor(d);
    const key = dateKey(d);
    const log = readLog(key);
    const base = (templateFor(key)[code]||[])
      .filter(t=>!log.hidden[t.id])
      .map(t=>{
        const ov = log.overrides[t.id];
        const merged = ov ? {...t, ...ov} : t;
        return {...merged, done:!!log.done[t.id], fromTemplate:true, origId:t.id};
      });
    const extra = log.extra.map(t=>({...t, done:!!log.done[t.id], fromTemplate:false}));
    return base.concat(extra);
  }

  function pct(tasks){
    if(tasks.length===0) return 0;
    const done = tasks.filter(t=>t.done).length;
    return Math.round((done/tasks.length)*100);
  }

  // ---------- native widget snapshot (native Android only; no-op on web) ----------
  // The widget is a DERIVED, best-effort mirror. This runs AFTER the app's own durable save, is
  // debounced, and is fully failure-isolated: a bridge/build failure logs a diagnostic and never
  // rolls back or blocks task data. The snapshot always represents TODAY (what the widget shows).
  let widgetTimer = null;
  function widgetPrivacy(){ try{ return localStorage.getItem('ayyam_widget_privacy_v1')==='1'; }catch(e){ return false; } }
  function todayWidgetLabel(d){ const code=dayCodeFor(d); return (DAY_LABELS[code]||'') + ' ' + d.toLocaleDateString('ar-EG',{day:'numeric',month:'long'}); }
  function pushWidgetSnapshotNow(){
    if(!NATIVE || typeof AyyamWidget==='undefined') return;
    try{
      const today = new Date();
      const tasks = tasksForDate(today).map(t=>({ id:t.id, title:t.title, time:t.time, period:t.period, done:t.done }));
      const snap = AyyamWidget.buildSnapshot({ date: dateKey(today), dayLabel: todayWidgetLabel(today), tasks, now: Date.now(), privacy: widgetPrivacy() });
      AyyamNative.updateWidgetSnapshot(snap).then(r=>{ if(store && r && !r.ok && !r.skipped) store.logDiag({ type:'widget-bridge-fail' }); }).catch(()=>{});
    }catch(e){ if(store) store.logDiag({ type:'widget-build-fail' }); }
  }
  function scheduleWidgetPush(){ if(!NATIVE) return; clearTimeout(widgetTimer); widgetTimer = setTimeout(pushWidgetSnapshotNow, 500); }
  // Native-only settings row: hide task names in the widget. When on, titles/times are omitted from
  // the native snapshot entirely (never stored), and the widget shows a remaining-count message.
  function setupWidgetPrivacyToggle(){
    const row = $('widgetPrivacyRow'), cb = $('widgetPrivacyToggle');
    if(!row || !cb) return;
    row.classList.remove('hidden');
    cb.checked = widgetPrivacy();
    cb.addEventListener('change', ()=>{
      try{ localStorage.setItem('ayyam_widget_privacy_v1', cb.checked ? '1' : '0'); }catch(e){}
      pushWidgetSnapshotNow(); // rebuild immediately so stored snapshot reflects the new privacy state
    });
  }

  // Deep link from the widget: only ayyam://today[?task=<id>] is honored (no arbitrary URLs).
  function focusTask(id){
    try{
      const el = document.querySelector('.task[data-task-id="'+ (window.CSS && CSS.escape ? CSS.escape(id) : id) +'"]');
      if(!el) return; // task no longer exists → just stay on Today (no crash)
      el.scrollIntoView({ behavior:'smooth', block:'center' });
      el.classList.add('flash'); setTimeout(()=>el.classList.remove('flash'), 2000);
    }catch(e){}
  }
  function handleDeepLink(url){
    try{
      if(typeof url!=='string' || url.indexOf('ayyam://')!==0) return; // validate scheme
      const u = new URL(url);
      if(u.hostname !== 'today') return;                                // only the Today host
      selectedDate = new Date();
      if($('settingsView') && !$('settingsView').classList.contains('hidden')) closeSettings();
      if($('reportsView') && !$('reportsView').classList.contains('hidden')) closeReports();
      hideStartupState();
      if(loadingEl) loadingEl.classList.add('hidden');
      render();
      const taskId = u.searchParams.get('task');
      if(taskId) setTimeout(()=>focusTask(taskId), 150);
    }catch(e){}
  }
  // Android hardware/system Back: close the top-most thing; exit only when nothing is left to close.
  function handleBack(){
    try{
      const add = $('addOverlay');
      if(add && add.classList.contains('show')){ closeAddSheet(); return; }        // 1. open sheet
      if($('settingsView') && !$('settingsView').classList.contains('hidden')){ closeSettings(); return; } // 2. settings
      if($('reportsView') && !$('reportsView').classList.contains('hidden')){ closeReports(); return; }     // 3. reports
      AyyamNative.exitApp();                                                        // 4. nothing → exit
    }catch(e){ try{ AyyamNative.exitApp(); }catch(_){} }
  }
  // Native Android push (FCM). Same 🔔 philosophy: user-initiated. Registers the FCM token on the
  // backend via the device-key-gated RPC. The token is never shown/logged. Dormant until FCM is configured.
  async function enableNativePush(){
    const key = getDeviceKey();
    if(!key){ promptForKey(); return; }
    let r; try{ r = await AyyamNative.registerAndroidPush(); }catch(e){ r = { status:'error' }; }
    if(r.status==='unsupported'){ alert('إشعارات أندرويد غير مُهيّأة بعد على هذا الإصدار.'); return; }
    if(r.status==='denied' || r.status==='not-granted'){ alert('لم يُمنح إذن الإشعارات. فعّله من إعدادات التطبيق ثم أعد المحاولة.'); return; }
    if(r.status!=='token'){ alert('تعذّر تفعيل الإشعارات. حاول لاحقًا.'); return; }
    try{
      const { data, error } = await withTimeout(sb.rpc('register_android_push', { p_key:key, p_token:r.token, p_device_id:DEVICE_ID }), SYNC_TIMEOUT_MS);
      if(!error && data && data.status==='ok'){ if(store) store.logDiag({ type:'fcm-registered' }); const b=$('notifyBtn'); if(b){ b.textContent='🔔✓'; b.setAttribute('aria-label','الإشعارات مفعّلة'); } } // never log the token
      else if(data && data.status==='unauthorized'){ setDeviceKey(''); alert('مفتاح المزامنة غير صحيح. أعد إدخاله ثم فعّل الإشعارات.'); }
      else alert('تعذّر تسجيل الإشعارات على الخادم.');
    }catch(e){ alert('تعذّر تسجيل الإشعارات. تأكد من الاتصال وحاول مرة أخرى.'); }
  }

  function toArabicNum(n){
    const map = {'0':'٠','1':'١','2':'٢','3':'٣','4':'٤','5':'٥','6':'٦','7':'٧','8':'٨','9':'٩'};
    return String(n).replace(/[0-9]/g, d=>map[d]);
  }

  // ---------- state ----------
  let selectedDate = new Date();
  let settingsDay = 'sat';
  let pendingPeriod = null;

  // ---------- rendering ----------
  const $ = id => document.getElementById(id);

  function startOfWeek(d){
    // week starts Saturday
    const jsDay = d.getDay(); // 0 sun .. 6 sat
    const offset = (jsDay + 1) % 7; // days since Saturday
    const s = new Date(d);
    s.setDate(d.getDate() - offset);
    s.setHours(0,0,0,0);
    return s;
  }

  function render(){
    renderHero();
    renderWeekStrip();
    renderMissingBanner();
    renderGroups();
    scheduleWidgetPush(); // native-only; refresh the widget's TODAY snapshot after any visible change
  }

  function renderMissingBanner(){
    const el = $('missingBanner');
    if(!el) return;
    const tasks = tasksForDate(selectedDate);
    const missing = tasks.filter(t=>!t.done);
    const isFuture = (()=>{
      const t = new Date(); t.setHours(0,0,0,0);
      const s = new Date(selectedDate); s.setHours(0,0,0,0);
      return s > t;
    })();

    if(tasks.length===0){ el.classList.add('hidden'); return; }
    el.classList.remove('hidden');

    if(missing.length===0){
      el.classList.add('ok');
      const isToday = dateKey(selectedDate)===dateKey(new Date());
      el.innerHTML = `<div class="missing-head">✅ الحمد لله، كل مهام ${isToday ? 'اليوم' : 'هذا اليوم'} متكاملة</div>`;
      return;
    }
    el.classList.remove('ok');
    const verb = isFuture ? 'مخطط لها' : 'ناقصة عليك';
    el.innerHTML = `
      <div class="missing-head">⏳ ${toArabicNum(missing.length)} مهمة ${verb}</div>
      <div class="missing-list">
        ${missing.map(t=>`<span class="missing-chip">${escapeHtml(t.title)}</span>`).join('')}
      </div>`;
  }

  function renderHero(){
    const code = dayCodeFor(selectedDate);
    $('dayName').textContent = DAY_LABELS[code];
    $('dayDate').textContent = selectedDate.toLocaleDateString('ar-EG', {day:'numeric', month:'long'});

    const tasks = tasksForDate(selectedDate);
    const byPeriod = {};
    PERIODS.forEach(p=> byPeriod[p.key] = tasks.filter(t=>t.period===p.key));

    const spectrum = $('spectrum');
    spectrum.innerHTML = '';
    const labels = $('segLabels');
    labels.innerHTML = '';
    PERIODS.forEach(p=>{
      const segTasks = byPeriod[p.key];
      const segPct = segTasks.length ? Math.round((segTasks.filter(t=>t.done).length/segTasks.length)*100) : 0;
      const seg = document.createElement('div');
      seg.className='seg';
      const fill = document.createElement('div');
      fill.className='fill';
      fill.style.width = segPct+'%';
      fill.style.background = p.color;
      seg.appendChild(fill);
      spectrum.appendChild(seg);

      const lbl = document.createElement('span');
      lbl.textContent = p.label;
      labels.appendChild(lbl);
    });

    $('statToday').textContent = toArabicNum(pct(tasks))+'٪';
    $('statTodayLbl').textContent = dateKey(selectedDate)===dateKey(new Date()) ? 'اليوم' : DAY_LABELS[code];

    // week pct
    const wStart = startOfWeek(selectedDate);
    const firstDay = parseKey(firstActiveKey());
    let weekTasks = [];
    for(let i=0;i<7;i++){
      const d = new Date(wStart); d.setDate(wStart.getDate()+i);
      if(d > new Date()) continue; // don't count future days in week avg
      if(d < firstDay) continue;   // nor days before the app was used
      weekTasks = weekTasks.concat(tasksForDate(d));
    }
    $('statWeek').textContent = toArabicNum(pct(weekTasks))+'٪';

    // streak: consecutive 100% days. Today counts once it's complete; while it's still
    // in progress the streak is counted up to yesterday instead of dropping to zero.
    let streak = 0;
    let cursor = new Date();
    cursor.setHours(0,0,0,0);
    const todayTasks = tasksForDate(cursor);
    if(!(todayTasks.length>0 && pct(todayTasks)===100)) cursor.setDate(cursor.getDate()-1);
    while(cursor >= firstDay){
      const dTasks = tasksForDate(cursor);
      if(dTasks.length>0 && pct(dTasks)===100){
        streak++;
        cursor.setDate(cursor.getDate()-1);
      } else break;
    }
    $('statStreak').textContent = toArabicNum(streak);
  }

  function renderWeekStrip(){
    const wStart = startOfWeek(selectedDate);
    const strip = $('weekStrip');
    strip.innerHTML='';
    const today = dateKey(new Date());
    for(let i=0;i<7;i++){
      const d = new Date(wStart); d.setDate(wStart.getDate()+i);
      const code = dayCodeFor(d);
      const key = dateKey(d);
      const isToday = key===today;
      const isSelected = key===dateKey(selectedDate);
      const tasks = tasksForDate(d);
      const p = tasks.length ? pct(tasks) : 0;

      const btn = document.createElement('button');
      btn.className = 'wday' + (isToday?' today':'') + (isSelected?' selected':'');
      btn.innerHTML = `<span class="lbl">${DAY_LABELS_SHORT[code]}</span>
        <span class="dot${p===100?' full':''}">${p===100?'✓':toArabicNum(d.getDate())}</span>`;
      btn.addEventListener('click', ()=>{ selectedDate = d; render(); });
      strip.appendChild(btn);
    }
  }

  function renderGroups(){
    const tasks = tasksForDate(selectedDate);
    const groupsEl = $('groups');
    groupsEl.innerHTML = '';

    if(tasks.length===0){
      groupsEl.innerHTML = '<p class="empty">لا مهام في هذا اليوم بعد. اضغط + لإضافة أول مهمة.</p>';
      return;
    }

    PERIODS.forEach(p=>{
      const list = tasks.filter(t=>t.period===p.key);
      if(list.length===0) return;
      const section = document.createElement('div');
      const head = document.createElement('div');
      head.className='group-head';
      head.innerHTML = `<span class="dot-sm" style="background:${p.color}"></span>
        <span class="group-title">${p.label}</span>
        <span class="group-count">${toArabicNum(list.filter(t=>t.done).length)}/${toArabicNum(list.length)}</span>`;
      section.appendChild(head);
      list.forEach(t=> section.appendChild(taskRow(t)));
      groupsEl.appendChild(section);
    });

    const free = tasks.filter(t=>!t.period);
    if(free.length){
      const section = document.createElement('div');
      const head = document.createElement('div');
      head.className='group-head';
      head.innerHTML = `<span class="dot-sm" style="background:var(--text-dim)"></span>
        <span class="group-title">مهام حرة</span>
        <span class="group-count">${toArabicNum(free.filter(t=>t.done).length)}/${toArabicNum(free.length)}</span>`;
      section.appendChild(head);
      free.forEach(t=> section.appendChild(taskRow(t)));
      groupsEl.appendChild(section);
    }
  }

  function taskRow(t){
    const row = document.createElement('div');
    row.className = 'task' + (t.done?' done':'');
    if(t.id) row.dataset.taskId = t.id; // deep-link focus target (harmless on web)
    const check = document.createElement('button');
    check.className = 'check' + (t.done?' checked':'');
    check.textContent = t.done ? '✓' : '';
    check.setAttribute('aria-label', t.done ? 'إلغاء الإتمام' : 'تمّ');
    check.addEventListener('click', ()=> toggleTask(t));
    row.appendChild(check);

    const mid = document.createElement('div');
    mid.className = 'task-main';
    mid.setAttribute('role','button');
    mid.tabIndex = 0; // reachable and editable from the keyboard too
    mid.setAttribute('aria-label', 'تعديل: ' + t.title);
    mid.innerHTML = `<div class="task-title">${escapeHtml(t.title)}</div>`;
    mid.addEventListener('click', ()=> openEditSheet(t));
    mid.addEventListener('keydown', (e)=>{
      if(e.key==='Enter' || e.key===' '){ e.preventDefault(); openEditSheet(t); }
    });
    row.appendChild(mid);

    if(t.time){
      const time = document.createElement('span');
      time.className='task-time';
      time.textContent = t.time;
      row.appendChild(time);
    }

    const del = document.createElement('button');
    del.className='task-del';
    del.textContent='✕';
    del.setAttribute('aria-label','حذف المهمة');
    del.addEventListener('click', (e)=>{ e.stopPropagation(); deleteTask(t); });
    row.appendChild(del);

    return row;
  }

  function escapeHtml(s){
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function toggleTask(t){
    const key = dateKey(selectedDate);
    const log = ensureLog(key);
    if(log.done[t.id]) delete log.done[t.id]; else log.done[t.id] = true;
    saveLogs(logs);
    render();
  }

  // Deletes a task for THIS DAY ONLY. If it comes from the recurring
  // template, it is hidden just for this date (template stays intact
  // for other days) — if it's a one-off extra task, it's removed entirely.
  function deleteTask(t){
    const key = dateKey(selectedDate);
    const log = ensureLog(key);
    if(t.fromTemplate){
      log.hidden[t.origId] = true;
      delete log.done[t.origId];
      delete log.overrides[t.origId];
    } else {
      log.extra = log.extra.filter(x=>x.id!==t.id);
      delete log.done[t.id];
    }
    saveLogs(logs);
    render();
  }

  // ---------- add / edit task sheet ----------
  let editingTask = null; // null = adding new, otherwise the task object being edited

  function openAddSheet(){
    editingTask = null;
    $('sheetTitle').textContent = 'مهمة جديدة';
    $('saveAdd').textContent = 'إضافة';
    $('taskTitle').value='';
    $('taskTime').value='';
    pendingPeriod = null;
    const pick = $('periodPick');
    pick.innerHTML='';
    const noneChip = makeChip('بدون وقت محدد', null, 'var(--surface)');
    pick.appendChild(noneChip);
    PERIODS.forEach(p=> pick.appendChild(makeChip(p.label, p.key, p.color)));
    showSheet();
  }

  function openEditSheet(t){
    editingTask = t;
    $('sheetTitle').textContent = 'تعديل المهمة';
    $('saveAdd').textContent = 'حفظ التعديل';
    $('taskTitle').value = t.title;
    $('taskTime').value = t.time || '';
    pendingPeriod = t.period || null;
    const pick = $('periodPick');
    pick.innerHTML='';
    const noneChip = makeChip('بدون وقت محدد', null, 'var(--surface)');
    pick.appendChild(noneChip);
    PERIODS.forEach(p=> pick.appendChild(makeChip(p.label, p.key, p.color)));
    showSheet();
  }

  function makeChip(label, key, color){
    const chip = document.createElement('button');
    chip.className='period-chip'+(pendingPeriod===key?' active':'');
    chip.textContent=label;
    chip.style.background = pendingPeriod===key ? color : '';
    chip.setAttribute('aria-pressed', String(pendingPeriod===key));
    chip.addEventListener('click', ()=>{
      pendingPeriod = key;
      Array.from(chip.parentElement.children).forEach(c=>{
        c.classList.remove('active'); c.style.background=''; c.setAttribute('aria-pressed','false');
      });
      chip.classList.add('active');
      chip.style.background = color;
      chip.setAttribute('aria-pressed','true');
    });
    return chip;
  }

  let sheetReturnFocus = null;
  function showSheet(){
    sheetReturnFocus = document.activeElement;
    $('addOverlay').classList.add('show');
    setTimeout(()=> $('taskTitle').focus(), 50);
  }
  function closeAddSheet(){
    $('addOverlay').classList.remove('show');
    editingTask=null;
    // return focus to where the user was (if that element still exists after re-render)
    if(sheetReturnFocus && document.contains(sheetReturnFocus)) sheetReturnFocus.focus();
    sheetReturnFocus = null;
  }
  // Keyboard: Enter saves, Escape cancels, Tab stays inside the open sheet.
  $('addOverlay').addEventListener('keydown', (e)=>{
    if(e.key==='Escape'){ e.preventDefault(); closeAddSheet(); return; }
    if(e.key==='Enter' && (e.target.id==='taskTitle' || e.target.id==='taskTime')){ e.preventDefault(); saveNewTask(); return; }
    if(e.key==='Tab'){
      const f = Array.from($('addOverlay').querySelectorAll('input, button'));
      const first = f[0], last = f[f.length-1];
      if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); }
    }
  });

  function saveNewTask(){
    const title = $('taskTitle').value.trim();
    if(!title){ $('taskTitle').focus(); return; }
    const time = $('taskTime').value.trim();
    const key = dateKey(selectedDate);
    const log = ensureLog(key);

    if(editingTask){
      if(editingTask.fromTemplate){
        // store a per-day override so the recurring template stays untouched
        log.overrides[editingTask.origId] = { title, time, period: pendingPeriod };
      } else {
        const item = log.extra.find(x=>x.id===editingTask.id);
        if(item){ item.title = title; item.time = time; item.period = pendingPeriod; }
      }
    } else {
      log.extra.push({id:nid(), title, time, period:pendingPeriod});
    }
    saveLogs(logs);
    closeAddSheet();
    render();
  }

  function clearWholeDay(){
    const ok = confirm('هل تريد مسح كل مهام هذا اليوم؟ يمكنك دائمًا إضافة مهام جديدة بعدها.');
    if(!ok) return;
    const key = dateKey(selectedDate);
    const code = dayCodeFor(selectedDate);
    const log = ensureLog(key);
    (templateFor(key)[code]||[]).forEach(t=>{ log.hidden[t.id] = true; delete log.done[t.id]; delete log.overrides[t.id]; });
    log.extra = [];
    saveLogs(logs);
    render();
  }

  function restoreDayToTemplate(){
    const ok = confirm('هل تريد استرجاع مهام هذا اليوم كما في القالب الأسبوعي؟ سيتم حذف أي تعديلات خاصة بهذا اليوم.');
    if(!ok) return;
    const key = dateKey(selectedDate);
    const log = ensureLog(key);
    log.hidden = {};
    log.overrides = {};
    saveLogs(logs);
    render();
  }

  // ---------- settings / template editor ----------
  function openSettings(){
    $('mainView').classList.add('hidden');
    $('settingsView').classList.remove('hidden');
    $('fabAdd').classList.add('hidden');
    renderTplDays();
    renderTplTasks();
    applyPrefs();
    updateSyncKeyInfo();
    updateDiagInfo();
  }
  function updateSyncKeyInfo(){
    const el = $('syncKeyInfo'); if(!el) return;
    el.textContent = getDeviceKey()
      ? 'هذا الجهاز مرتبط بمفتاح المزامنة. بياناتك تتزامن بأمان بين أجهزتك.'
      : 'لم يُدخل مفتاح المزامنة على هذا الجهاز بعد. أدخله ليتزامن مع أجهزتك الأخرى.';
  }
  // Diagnostics: non-sensitive status only. NEVER shows the device key, endpoints, coordinates or secrets.
  async function getSwVersion(){
    try{
      if(!(navigator.serviceWorker && navigator.serviceWorker.controller)) return '—';
      return await new Promise((resolve)=>{
        const ch = new MessageChannel();
        const t = setTimeout(()=>resolve('—'), 1000);
        ch.port1.onmessage = (e)=>{ clearTimeout(t); resolve((e.data && e.data.version) || '—'); };
        navigator.serviceWorker.controller.postMessage({ type:'GET_VERSION' }, [ch.port2]);
      });
    }catch(e){ return '—'; }
  }
  function syncStateLabel(){
    const m = { idle:'خامل', syncing:'يتزامن الآن', saved:'تمّت المزامنة', error:'خطأ مؤقت', offline:'غير متصل', 'need-key':'يحتاج مفتاح المزامنة' };
    return m[syncState] || syncState;
  }
  function relTime(ts){
    if(!ts) return '—';
    const s = Math.max(0, Math.round((Date.now()-ts)/1000));
    if(s < 60) return 'قبل ' + toArabicNum(s) + ' ث';
    const mn = Math.round(s/60); if(mn < 60) return 'قبل ' + toArabicNum(mn) + ' د';
    const h = Math.round(mn/60); if(h < 24) return 'قبل ' + toArabicNum(h) + ' س';
    return 'قبل ' + toArabicNum(Math.round(h/24)) + ' يوم';
  }
  // Non-sensitive diagnostics ONLY. Never the device key/hash, push endpoint, p256dh/auth,
  // coordinates, secrets or raw bundle data — see the field list below.
  async function collectDiag(){
    let pushActive = false;
    try{ if('serviceWorker' in navigator && 'PushManager' in window){ const reg = await navigator.serviceWorker.ready; pushActive = !!(await reg.pushManager.getSubscription()); } }catch(e){}
    const sw = await getSwVersion();
    let outbox = isPending() ? 1 : 0, recovery = 0, schema = null;
    try{ if(store){ outbox = (await store.listOutbox()).length; recovery = (await store.getRecovery()).length; schema = store.schemaVersion; } }catch(e){}
    const localOnly = (function(){ try{ return localStorage.getItem('ayyam_local_only_v1')==='1'; }catch(e){ return false; } })();
    // Native-only, non-sensitive extras (Platform/version/secure state/widget state). No secrets, no titles.
    const nativeLines = [];
    if(NATIVE){
      try{
        nativeLines.push('المنصة: أندرويد');
        const info = await AyyamNative.appInfo();
        if(info) nativeLines.push('إصدار تطبيق أندرويد: ' + (info.version||'—') + (info.build!=null ? ' ('+info.build+')' : ''));
        const ss = AyyamNative.secureState ? AyyamNative.secureState() : null;
        if(ss) nativeLines.push('التخزين الآمن: ' + (ss.degraded ? 'محدود (fallback)' : 'آمن') + (ss.backing ? ' — '+ss.backing : ''));
        const ws = await AyyamNative.widgetStatus();
        if(ws){
          nativeLines.push('جسر الودجت: ' + (ws.hasSnapshot ? 'نشط' : 'بلا لقطة'));
          if(ws.date) nativeLines.push('تاريخ لقطة الودجت: ' + ws.date);
          if(ws.generatedAt) nativeLines.push('تحديث لقطة الودجت: ' + relTime(Date.parse(ws.generatedAt)));
        }
        nativeLines.push('خصوصية الودجت: ' + (widgetPrivacy() ? 'مفعّلة (إخفاء الأسماء)' : 'غير مفعّلة'));
        const pc = AyyamNative.pushChannel ? AyyamNative.pushChannel() : null;
        if(pc) nativeLines.push('قناة الإشعارات: ' + (pc.channel==='fcm' ? ('FCM' + (pc.configured ? '' : ' (غير مُهيّأة بعد)')) : 'Web Push'));
      }catch(e){}
    }
    return [
      'إصدار التطبيق: ' + APP_VERSION,
      'عامل الخدمة: ' + sw,
      'مخطط قاعدة البيانات: ' + (typeof schema==='number' ? toArabicNum(schema) : '—'),
      'الاتصال: ' + (navigator.onLine ? 'متصل' : 'غير متصل'),
      'حالة المزامنة: ' + syncStateLabel(),
      'آخر مزامنة ناجحة: ' + relTime(lastSyncOkAt),
      'رقم المراجعة على الخادم: ' + (baseRevision!=null ? toArabicNum(baseRevision) : '—'),
      'رقم الجيل (epoch): ' + ((enriched && enriched.epoch!=null) ? toArabicNum(enriched.epoch) : '—'),
      'تغييرات غير مرفوعة: ' + toArabicNum(outbox),
      'عناصر الاسترجاع: ' + toArabicNum(recovery),
      'الإشعارات: ' + (pushActive ? 'مفعّلة' : 'غير مفعّلة'),
      'مفتاح المزامنة: ' + (getDeviceKey() ? 'مُدخل' : 'غير مُدخل'),
      'التخزين المحلي: ' + (storageDegraded ? 'محدود (بدون قاعدة بيانات)' : (store && store.newerSchema ? 'إصدار أحدث — يُنصح بتحديث التطبيق' : 'سليم')),
      'الوضع المحلي فقط: ' + (localOnly ? 'نعم' : 'لا'),
      'معرّف الجهاز: ' + (DEVICE_ID ? DEVICE_ID.slice(0,8) : '—'),
    ].concat(nativeLines);
  }
  async function updateDiagInfo(){
    const el = $('diagInfo'); if(!el) return;
    el.textContent = (await collectDiag()).join('\n');
  }
  async function copyDiag(){
    try{
      const txt = (await collectDiag()).join('\n');
      if(navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(txt);
      else { const ta=document.createElement('textarea'); ta.value=txt; ta.setAttribute('readonly',''); document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
      const b=$('copyDiag'); if(b){ const o=b.textContent; b.textContent='تم النسخ ✓'; setTimeout(()=>{ b.textContent=o; }, 1500); }
    }catch(e){ alert('تعذّر النسخ'); }
  }
  function closeSettings(){
    $('settingsView').classList.add('hidden');
    $('mainView').classList.remove('hidden');
    $('fabAdd').classList.remove('hidden');
    render();
  }

  // ---------- reports ----------
  let reportRange = 'week';

  // Every range starts no earlier than the first day the app was used (parsed as local midnight,
  // so today is always included).
  function rangeDates(range){
    const today = new Date(); today.setHours(0,0,0,0);
    const firstDay = parseKey(firstActiveKey());
    let start;
    if(range==='week'){
      start = startOfWeek(today);
    } else if(range==='month'){
      start = new Date(today.getFullYear(), today.getMonth(), 1);
    } else {
      start = firstDay;
    }
    if(start < firstDay) start = firstDay;
    const dates = [];
    const cursor = new Date(start);
    while(cursor <= today){
      dates.push(new Date(cursor));
      cursor.setDate(cursor.getDate()+1);
    }
    return dates;
  }

  function renderReports(){
    const dates = rangeDates(reportRange);
    const todayKey = dateKey(new Date());
    let allTasks = [];
    const perDay = [];
    dates.forEach(d=>{
      const tasks = tasksForDate(d);
      allTasks = allTasks.concat(tasks);
      perDay.push({date:d, tasks});
    });
    // Only fully-finished days count toward "weakest day" / "most missed"
    // judgments — today is still in progress and shouldn't be scored as a failure.
    const perDayFinal = perDay.filter(({date}) => dateKey(date) !== todayKey);

    const byPeriodEl = $('reportByPeriod');
    byPeriodEl.innerHTML = '';
    if(allTasks.length===0){
      byPeriodEl.innerHTML = '<p class="empty" style="padding:10px 0;">لا بيانات كافية بعد</p>';
    } else {
      PERIODS.forEach(p=>{
        const segTasks = allTasks.filter(t=>t.period===p.key);
        const segPct = segTasks.length ? Math.round((segTasks.filter(t=>t.done).length/segTasks.length)*100) : 0;
        const row = document.createElement('div');
        row.className='bar-row';
        // a period with no tasks in this range shows "—" instead of a misleading 0%
        row.innerHTML = `
          <span class="bar-lbl">${p.label}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${segPct}%;background:${p.color}"></span></span>
          <span class="bar-pct">${segTasks.length ? toArabicNum(segPct)+'٪' : '—'}</span>`;
        byPeriodEl.appendChild(row);
      });
    }

    const weakEl = $('reportWeakDays');
    weakEl.innerHTML = '';
    const byCode = {};
    DAY_CODES.forEach(c=> byCode[c] = {sum:0,count:0});
    perDayFinal.forEach(({date,tasks})=>{
      if(tasks.length===0) return;
      const code = dayCodeFor(date);
      byCode[code].sum += pct(tasks);
      byCode[code].count += 1;
    });
    const weakSorted = DAY_CODES
      .map(c=>({code:c, avg: byCode[c].count ? Math.round(byCode[c].sum/byCode[c].count) : null}))
      .filter(x=>x.avg!==null)
      .sort((a,b)=>a.avg-b.avg);
    if(weakSorted.length===0){
      weakEl.innerHTML = '<p class="empty" style="padding:10px 0;">لا بيانات كافية بعد</p>';
    } else {
      weakSorted.forEach(x=>{
        const item = document.createElement('div');
        item.className='missing-day-item';
        item.innerHTML = `<span>${DAY_LABELS[x.code]}</span><span class="tasks-mini">${toArabicNum(x.avg)}٪ متوسط الإنجاز</span>`;
        weakEl.appendChild(item);
      });
    }

    const missEl = $('reportMissedTasks');
    missEl.innerHTML = '';
    const missCount = {};
    perDayFinal.forEach(({tasks})=>{
      tasks.forEach(t=>{
        if(!t.done){
          missCount[t.title] = (missCount[t.title]||0)+1;
        }
      });
    });
    const missSorted = Object.entries(missCount).sort((a,b)=>b[1]-a[1]).slice(0,6);
    if(missSorted.length===0){
      missEl.innerHTML = '<p class="empty" style="padding:10px 0;">ما فيش مهام متفوتة، أحسنت 🎉</p>';
    } else {
      missSorted.forEach(([title,count])=>{
        const item = document.createElement('div');
        item.className='missing-day-item';
        item.innerHTML = `<span>${escapeHtml(title)}</span><span class="tasks-mini">فاتت ${toArabicNum(count)} ${count===1?'مرة':'مرات'}</span>`;
        missEl.appendChild(item);
      });
    }
  }

  function openReports(){
    $('mainView').classList.add('hidden');
    $('reportsView').classList.remove('hidden');
    $('fabAdd').classList.add('hidden');
    renderReports();
  }
  function closeReports(){
    $('reportsView').classList.add('hidden');
    $('mainView').classList.remove('hidden');
    $('fabAdd').classList.remove('hidden');
  }
  function renderTplDays(){
    const el = $('tplDays');
    el.innerHTML='';
    DAY_CODES.forEach(code=>{
      const btn = document.createElement('button');
      btn.className='tpl-day-btn'+(settingsDay===code?' active':'');
      btn.textContent = DAY_LABELS[code];
      btn.addEventListener('click', ()=>{ settingsDay=code; renderTplDays(); renderTplTasks(); });
      el.appendChild(btn);
    });
  }
  function renderTplTasks(){
    const el = $('tplTasks');
    el.innerHTML='';
    (template[settingsDay]||[]).forEach(t=>{
      const row = document.createElement('div');
      row.className='tpl-task-row';
      // period picker (replaces the old read-only colour dot); its border shows the period colour
      const periodSel = document.createElement('select');
      periodSel.className = 'tpl-period';
      periodSel.setAttribute('aria-label','وقت المهمة');
      [{key:'', label:'حرة'}, ...PERIODS].forEach(p=>{
        const o = document.createElement('option');
        o.value = p.key; o.textContent = p.label;
        periodSel.appendChild(o);
      });
      periodSel.value = t.period || '';
      const paintPeriod = ()=>{ periodSel.style.borderInlineStart = '4px solid ' + (t.period ? PERIOD_MAP[t.period].color : 'var(--line)'); };
      paintPeriod();
      periodSel.addEventListener('change', ()=>{
        beginTemplateEdit();
        t.period = periodSel.value || null;
        paintPeriod();
        saveTemplate(template);
      });
      row.appendChild(periodSel);

      const titleInput = document.createElement('input');
      titleInput.value = t.title;
      titleInput.setAttribute('aria-label','اسم المهمة');
      titleInput.addEventListener('input', ()=>{ beginTemplateEdit(); t.title = titleInput.value; saveTemplate(template); });
      row.appendChild(titleInput);

      const timeInput = document.createElement('input');
      timeInput.className = 'tpl-time-input';
      timeInput.value = t.time || '';
      timeInput.style.color='var(--text-dim)';
      timeInput.placeholder='الوقت';
      timeInput.setAttribute('aria-label','الوقت');
      timeInput.addEventListener('input', ()=>{ beginTemplateEdit(); t.time = timeInput.value; saveTemplate(template); });
      row.appendChild(timeInput);

      const del = document.createElement('button');
      del.className='task-del';
      del.style.flex='none';
      del.textContent='✕';
      del.setAttribute('aria-label','حذف المهمة من القالب');
      del.addEventListener('click', ()=>{
        if(!confirm(`حذف «${t.title}» من قالب ${DAY_LABELS[settingsDay]}؟ الأيام السابقة لن تتأثر.`)) return;
        beginTemplateEdit();
        template[settingsDay] = template[settingsDay].filter(x=>x.id!==t.id);
        saveTemplate(template);
        renderTplTasks();
      });
      row.appendChild(del);

      el.appendChild(row);
    });
  }

  // ---------- wiring ----------
  $('syncBadge').addEventListener('click', ()=>{ if(syncState==='need-key') promptForKey(); });
  $('prevDay').addEventListener('click', ()=>{ selectedDate = new Date(selectedDate); selectedDate.setDate(selectedDate.getDate()-1); render(); });
  $('nextDay').addEventListener('click', ()=>{ selectedDate = new Date(selectedDate); selectedDate.setDate(selectedDate.getDate()+1); render(); });

  $('fabAdd').addEventListener('click', openAddSheet);
  $('cancelAdd').addEventListener('click', closeAddSheet);
  $('saveAdd').addEventListener('click', saveNewTask);
  $('addOverlay').addEventListener('click', (e)=>{ if(e.target.id==='addOverlay') closeAddSheet(); });

  $('clearDayBtn').addEventListener('click', clearWholeDay);
  $('restoreDayBtn').addEventListener('click', restoreDayToTemplate);
  $('enterKeyBtn').addEventListener('click', ()=>{ promptForKey(); updateSyncKeyInfo(); });

  $('openSettings').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('tplAddTask').addEventListener('click', ()=>{
    const t = {id:nid(), period:null, title:'مهمة جديدة', time:''};
    beginTemplateEdit();
    if(!template[settingsDay]) template[settingsDay]=[];
    template[settingsDay].push(t);
    saveTemplate(template);
    renderTplTasks();
  });

  // reports
  $('openReports').addEventListener('click', openReports);
  $('closeReports').addEventListener('click', closeReports);
  { const cd = $('copyDiag'); if(cd) cd.addEventListener('click', copyDiag); }
  Array.from(document.querySelectorAll('.report-tab')).forEach(tab=>{
    tab.addEventListener('click', ()=>{
      reportRange = tab.dataset.range;
      Array.from(document.querySelectorAll('.report-tab')).forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      renderReports();
    });
  });

  // theme toggle (main header)
  $('themeToggle').addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-theme]');
    if(!btn) return;
    prefs.theme = btn.dataset.theme;
    savePrefs(prefs);
    applyPrefs();
  });

  // appearance controls (in settings)
  $('bgToggle').addEventListener('change', (e)=>{
    prefs.bgOn = e.target.checked;
    savePrefs(prefs);
    applyPrefs();
  });
  $('bgOpacity').addEventListener('input', (e)=>{
    prefs.bgOpacity = parseInt(e.target.value,10);
    savePrefs(prefs);
    applyPrefs();
  });
  $('bgBlur').addEventListener('input', (e)=>{
    prefs.bgBlur = parseInt(e.target.value,10);
    savePrefs(prefs);
    applyPrefs();
  });

  // ---------- prayer-times location ----------
  // Reminders are computed on the server from the last saved location, so keep it current:
  // it refreshes silently every time the app is opened (once location access is allowed)
  // and is saved only when you've actually moved, so it doesn't cause a sync on every open.
  const LS_GEO_ASKED = 'ayyam_geo_asked_v1';
  const r3 = v => Math.round(v*1000)/1000; // ~100 m
  function kmBetween(a, b){
    const R = 6371, rad = x => x*Math.PI/180;
    const dLat = rad(b.lat-a.lat), dLng = rad(b.lng-a.lng);
    const h = Math.sin(dLat/2)**2 + Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLng/2)**2;
    return 2*R*Math.asin(Math.sqrt(h));
  }
  function refreshLocation(interactive){
    if(!navigator.geolocation){ if(interactive) alert('تحديد الموقع غير مدعوم في هذا المتصفح.'); return; }
    navigator.geolocation.getCurrentPosition((pos)=>{
      const next = {
        lat: r3(pos.coords.latitude), lng: r3(pos.coords.longitude),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Cairo',
      };
      const cur = prefs.location;
      if(!interactive && cur && cur.tz===next.tz && kmBetween(cur, next) < 1) return; // hasn't moved
      prefs.location = next;
      savePrefs(prefs);
      applyPrefs();
    }, ()=>{
      if(interactive) alert('تعذّر تحديد موقعك. تأكد من السماح للتطبيق بالوصول للموقع وأن الـ GPS مفعّل.');
    }, {timeout:15000, maximumAge: interactive ? 0 : 5*60*1000, enableHighAccuracy:false});
  }
  async function autoRefreshLocation(){
    let state = 'unknown';
    try{ state = (await navigator.permissions.query({name:'geolocation'})).state; }catch(e){}
    if(state==='granted'){ refreshLocation(false); return; }
    // Ask once by itself — only when notifications are on, since that's what the location is for.
    if(state==='prompt' && 'Notification' in window && Notification.permission==='granted'){
      let asked = false;
      try{ asked = localStorage.getItem(LS_GEO_ASKED)==='1'; localStorage.setItem(LS_GEO_ASKED,'1'); }catch(e){}
      if(!asked) refreshLocation(false);
    }
  }
  $('useMyLocation').addEventListener('click', ()=> refreshLocation(true));
  document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible') autoRefreshLocation(); });

  // data management
  $('exportData').addEventListener('click', ()=>{
    const backup = {...currentBundle(), exportedAt: new Date().toISOString()};
    const blob = new Blob([JSON.stringify(backup, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ayyam-backup-' + dateKey(new Date()) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=> URL.revokeObjectURL(url), 1000); // revoking synchronously can cancel the download on some browsers
  });

  // Restore a backup file produced by "export". The file is validated like server data;
  // the restored state then syncs to the server like any other edit.
  $('importData').addEventListener('click', ()=> $('importFile').click());
  $('importFile').addEventListener('change', async (e)=>{
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow choosing the same file again later
    if(!file) return;
    let raw;
    try{ raw = JSON.parse(await file.text()); }catch(err){ raw = null; }
    if(!isObj(raw) || !isObj(raw.template) || !isObj(raw.logs)){
      alert('هذا الملف ليس نسخة احتياطية صالحة من تطبيق أيام.');
      return;
    }
    const restored = sanitizeBundle(raw);
    const days = Object.keys(restored.logs).length;
    const when = typeof raw.exportedAt==='string' ? new Date(raw.exportedAt) : null;
    const whenTxt = when && !isNaN(when) ? ' (بتاريخ ' + when.toLocaleDateString('ar-EG') + ')' : '';
    if(!confirm(`استرجاع النسخة الاحتياطية${whenTxt}؟\nتحتوي على سجل ${toArabicNum(days)} يوم.\nسيتم استبدال بياناتك الحالية بالكامل.`)) return;
    setState(restored);
    saveBundle('import'); // new generation: fences older devices from re-adding replaced data
    applyPrefs();
    renderTplDays();
    renderTplTasks();
    alert('تم استرجاع النسخة الاحتياطية.');
  });
  $('resetData').addEventListener('click', ()=>{
    const ok = confirm('سيتم حذف كل المهام والسجلات والعودة للقالب الافتراضي. هل أنت متأكد؟');
    if(!ok) return;
    template = defaultTemplate();
    logs = {};
    tplArchive = { since: EPOCH_KEY, versions: [] };
    saveBundle('reset'); // new generation: a stale offline device can't bring the old data back
    renderTplDays();
    renderTplTasks();
    closeSettings();
  });

  // ---------- PWA: manifest, icon, service worker, install prompt ----------
  function setupPWA(){
    // Manifest and icons are static files (manifest.webmanifest, icon-*.png) linked in <head>.

    // Service worker: offline support + push notifications, with a safe update-on-demand flow.
    // Disabled in the native Android shell: Capacitor serves a local app shell from the APK, so the SW's
    // caching role is redundant (avoids two competing cache layers). Web/PWA keeps the SW unchanged.
    if('serviceWorker' in navigator && !NATIVE){
      // relative path so it also works when hosted under a sub-path (e.g. GitHub Pages)
      navigator.serviceWorker.register('sw.js').then((reg)=>{
        // A worker is already waiting (installed a new coherent version) → offer the update.
        if(reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);
        reg.addEventListener('updatefound', ()=>{
          const nw = reg.installing;
          if(!nw) return;
          nw.addEventListener('statechange', ()=>{
            // "installed" while a controller exists = an update is ready and WAITING (we never auto-activate).
            if(nw.state==='installed' && navigator.serviceWorker.controller) showUpdateBanner(nw);
          });
        });
        // check for an update shortly after load and when the app regains focus
        setTimeout(()=>reg.update().catch(()=>{}), 3000);
        document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible') reg.update().catch(()=>{}); });
      }).catch(()=>{ store && store.logDiag && store.logDiag({type:'sw-register-failed'}); });

      // When the new worker takes control (after the user opts in), reload ONCE onto the coherent version.
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', ()=>{
        if(reloaded) return; reloaded = true; location.reload();
      });
    }
    function showUpdateBanner(worker){
      const banner = $('updateBanner'); if(!banner) return;
      banner.classList.remove('hidden');
      $('updateNow').onclick = ()=>{
        $('updateNow').disabled = true;
        worker.postMessage({ type:'SKIP_WAITING' }); // activate the waiting version → controllerchange → reload
      };
    }

    // ---------- Push notifications setup ----------
    const VAPID_PUBLIC_KEY = 'BDtsM-zFTDjyvrkjcJlmhV2Q6z4CozF4Vx1GxHEwOgk7gyJhzVsKwdKRWxI8POSMWJDLcXVcsXvj33hIyMK_ENA';

    function urlBase64ToUint8Array(base64String){
      const padding = '='.repeat((4 - base64String.length % 4) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const rawData = atob(base64);
      const outputArray = new Uint8Array(rawData.length);
      for(let i=0; i<rawData.length; i++){ outputArray[i] = rawData.charCodeAt(i); }
      return outputArray;
    }

    async function isPushSupported(){
      return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    }

    async function getExistingPushSubscription(){
      if(!(await isPushSupported())) return null;
      const reg = await navigator.serviceWorker.ready;
      return reg.pushManager.getSubscription();
    }

    // A subscription made with a different (older) VAPID key can't receive our pushes.
    function subscriptionMatchesKey(sub){
      const k = sub && sub.options && sub.options.applicationServerKey;
      if(!k) return false;
      const a = new Uint8Array(k), b = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
      return a.length===b.length && a.every((x,i)=>x===b[i]);
    }

    async function subscribeToPush(){
      if(!(await isPushSupported())){
        alert('الإشعارات غير مدعومة في هذا المتصفح.');
        return;
      }
      // Once blocked, browsers never show the prompt again — tell the user where to re-enable it.
      const blockedHelp = 'الإشعارات محظورة لهذا الموقع، والمتصفح لن يعرض طلب الإذن مرة أخرى.\n\n'
        + 'لتفعيلها:\n'
        + '• لو فاتح التطبيق من المتصفح: اضغط على رمز القفل أو الإعدادات بجانب عنوان الموقع ← الأذونات ← الإشعارات ← سماح.\n'
        + '• لو مثبّت التطبيق على الشاشة الرئيسية: اضغط مطولًا على أيقونة التطبيق ← معلومات التطبيق ← الإشعارات ← تفعيل.\n\n'
        + 'ثم ارجع واضغط 🔔 مرة أخرى.';
      if(Notification.permission === 'denied'){ alert(blockedHelp); return; }
      const permission = await Notification.requestPermission();
      if(permission === 'denied'){ alert(blockedHelp); return; }
      if(permission !== 'granted'){
        alert('لم يتم منح إذن الإشعارات. اضغط 🔔 مرة أخرى واختر «سماح».');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if(sub && !subscriptionMatchesKey(sub)){
        try{ await sub.unsubscribe(); }catch(e){}
        sub = null;
      }
      if(!sub){
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
      }
      const json = sub.toJSON();
      // Register through the device-key-protected RPC (register_push): a real upsert on the endpoint,
      // no direct table access from the browser. Needs the sync key — the same one used for data sync.
      const key = getDeviceKey();
      if(!key){
        alert('لتفعيل الإشعارات أدخل مفتاح المزامنة أولًا (من إعدادات المزامنة).');
        promptForKey();
        return;
      }
      let saved = false, unauthorized = false;
      if(sb){
        try{
          const { data, error } = await withTimeout(sb.rpc('register_push', {
            p_key: key, p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth,
          }), SYNC_TIMEOUT_MS);
          if(!error && data && data.status === 'ok') saved = true;
          else if(data && data.status === 'unauthorized') unauthorized = true;
        }catch(e){ saved = false; }
      }
      if(unauthorized){ alert('مفتاح المزامنة غير صحيح. أعد إدخاله ثم فعّل الإشعارات.'); setDeviceKey(''); promptForKey(); return; }
      if(!saved){
        alert('تعذّر تسجيل الإشعارات على الخادم. تأكد من الاتصال وحاول مرة أخرى.');
        return;
      }
      $('notifyBtn').textContent = '🔔✓';
      $('notifyBtn').setAttribute('aria-label','الإشعارات مفعّلة');
      autoRefreshLocation();
    }

    async function setupNotifyButton(){
      // Native Android: Web Push is unavailable in the WebView (proven in F1) → use the FCM channel.
      // The button shows only once FCM is configured (plugin + Firebase); until then it stays hidden.
      if(NATIVE){
        const pc = AyyamNative.pushChannel ? AyyamNative.pushChannel() : {configured:false};
        if(pc.configured){
          $('notifyBtn').classList.remove('hidden');
          $('notifyBtn').addEventListener('click', enableNativePush);
        }
        return;
      }
      if(!(await isPushSupported())) return; // keep hidden if unsupported
      $('notifyBtn').classList.remove('hidden');
      const existing = await getExistingPushSubscription();
      if(existing && subscriptionMatchesKey(existing)){
        $('notifyBtn').textContent = '🔔✓';
        $('notifyBtn').setAttribute('aria-label','الإشعارات مفعّلة');
      }
      $('notifyBtn').addEventListener('click', subscribeToPush);
    }
    setupNotifyButton();

    // Install prompt handling
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e)=>{
      e.preventDefault();
      deferredPrompt = e;
      $('installBtn').classList.remove('hidden');
    });
    $('installBtn').addEventListener('click', async ()=>{
      if(!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      $('installBtn').classList.add('hidden');
    });
    window.addEventListener('appinstalled', ()=>{
      $('installBtn').classList.add('hidden');
    });
  }
  setupPWA();

  // ---------- initial data load (durable local first, then merge with Supabase) ----------
  const loadingEl = document.getElementById('loadingOverlay');
  function enrichedIsEmpty(){ return !enriched || Object.keys(enriched.reg).length===0; }
  // Seed the default schedule on a truly fresh start. Stamped at a BASELINE time so a real edit made
  // on any device always wins, and with STABLE ids so two devices seeding converge (no duplicate schedule).
  async function seedDefault(localOnly){
    const fresh = { template: defaultTemplate(), logs: {}, prefs: defaultPrefs(), tplArchive: { since: EPOCH_KEY, versions: [] } };
    enriched = M.toEnriched(fresh, 1); // baseline stamps → any real server data wins on merge (no blind overwrite)
    setState(M.materialize(enriched));
    if(localOnly){ try{ localStorage.setItem('ayyam_local_only_v1','1'); }catch(e){} }
    setPending(true);
    try{ await persistEnrichedEdit(enriched); storageError=false; }catch(e){ storageError=true; }
    await syncNow('init'); // deterministic: commit the seed before startup finishes (no race with scheduleSync)
  }

  // First-load pull on a device with no local data — classifies the outcome precisely so we never show
  // the default schedule as if it were the user's real data when we simply couldn't reach the server.
  // → 'ready' (adopted real data) | 'empty' (server reachable, no data) | 'need-key' | 'unreachable'
  async function firstLoadPull(){
    const key = getDeviceKey();
    if(!key) return 'need-key';
    if(!M || !sb) return 'unreachable';
    try{
      const pull = await rpc('ayyam_pull', { p_key: key });
      if(pull.status === 'unauthorized'){ setDeviceKey(''); return 'need-key'; }
      if(pull.exists){
        const serverEn = M.toEnriched(pull.data, 1);
        await adoptEnriched(serverEn, true);
        await persistBaseV2(serverEn, pull.revision);
        setPending(false);
        return 'ready';
      }
      return 'empty';
    }catch(e){ return 'unreachable'; }
  }

  // The first-load overlay: distinct, honest states (never defaults-as-data on an uncertain server).
  function hideStartupState(){ const el=$('startupState'); if(el) el.classList.add('hidden'); }
  function showStartupState(kind){
    if(loadingEl) loadingEl.classList.add('hidden');
    const el = $('startupState'); if(!el) return;
    el.classList.remove('hidden');
    const msg=$('startupMsg'), icon=$('startupIcon');
    const retry=$('startupRetry'), keyBtn=$('startupKey'), off=$('startupOffline');
    [retry,keyBtn,off].forEach(b=>b.classList.add('hidden'));
    if(kind==='need-key'){
      icon.textContent='🔑';
      msg.textContent='لعرض بياناتك ومزامنتها بين أجهزتك، أدخل مفتاح المزامنة على هذا الجهاز.';
      keyBtn.classList.remove('hidden');
      off.classList.remove('hidden');
    } else { // load-failed
      icon.textContent='☁️';
      msg.textContent='تعذّر تحميل بياناتك من السحابة. تحقّق من الاتصال وأعد المحاولة.';
      retry.classList.remove('hidden');
      off.classList.remove('hidden');
    }
  }
  async function runFirstLoad(){
    const r = await firstLoadPull();
    if(r==='ready'){ hideStartupState(); if(loadingEl) loadingEl.classList.add('hidden'); render(); }
    else if(r==='empty'){ hideStartupState(); await seedDefault(false); if(loadingEl) loadingEl.classList.add('hidden'); render(); }
    else if(r==='need-key'){ needsKey=true; syncState='need-key'; updateSyncBadge(); showStartupState('need-key'); }
    else { showStartupState('load-failed'); } // unreachable
  }
  $('startupRetry').addEventListener('click', ()=>{ if(loadingEl) loadingEl.classList.remove('hidden'); hideStartupState(); runFirstLoad(); });
  $('startupKey').addEventListener('click', ()=>{
    const k = window.prompt('مفتاح المزامنة (يُدخل مرة واحدة على هذا الجهاز):','');
    if(k===null) return;
    if(k.trim().length<16){ alert('المفتاح قصير جدًا.'); return; }
    setDeviceKey(k.trim()); needsKey=false;
    if(loadingEl) loadingEl.classList.remove('hidden'); hideStartupState(); runFirstLoad();
  });
  $('startupOffline').addEventListener('click', async ()=>{
    hideStartupState();
    await seedDefault(true); // local-only: baseline-stamped, so a later reconnect merges (not overwrites)
    if(loadingEl) loadingEl.classList.add('hidden');
    render();
  });

  // Native: load the secure device key into memory before anything reads it, and sync on app resume.
  if(NATIVE){ try{ await AyyamNative.hydrate(); }catch(e){} try{ AyyamNative.onResume(()=>{ scheduleSync(); scheduleWidgetPush(); }); }catch(e){} }

  const init = await initStorage();          // open IndexedDB, migrate once, load enriched state
  if(init.state) setState(init.state);
  applyPrefs(); // cached prefs applied immediately so the theme doesn't flash
  if(init.state && !enrichedIsEmpty()){
    // existing device: show local data right away; sync merges server changes in the background
    if(loadingEl) loadingEl.classList.add('hidden');
    render();
    syncNow();
  } else {
    // no local data: show nothing (not the default schedule) behind the overlay until we know the truth
    setState({ template: M ? M.emptyTemplate() : {sat:[],sun:[],mon:[],tue:[],wed:[],thu:[],fri:[]}, logs: {}, prefs: prefs, tplArchive: { since: EPOCH_KEY, versions: [] } });
    render();
    await runFirstLoad();
  }
  updateSyncBadge();
  startupDone = true; // enable focus/online/pageshow-triggered syncs now that first-load is settled
  scheduleWidgetPush(); // seed the widget snapshot once startup state is settled
  if(NATIVE){
    try{ AyyamNative.onDeepLink(handleDeepLink); const lu = await AyyamNative.getLaunchUrl(); if(lu) handleDeepLink(lu); }catch(e){}
    try{ AyyamNative.onBack(handleBack); }catch(e){}
    try{ setupWidgetPrivacyToggle(); }catch(e){}
  }
  autoRefreshLocation();
})();

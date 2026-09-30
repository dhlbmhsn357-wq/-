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
  const APP_VERSION = '5.2.1'; // bump per release; kept in step with sw.js SW_VERSION
  // Update manifest for the DIRECT-APK Android updater. It uses GitHub's stable "latest release" redirect,
  // so the URL never changes and always resolves to the most recently PUBLISHED release's update.json (the
  // release workflow generates it with the real versionCode/sha256/apkUrl and attaches it). The end user
  // never opens GitHub — the app fetches this JSON directly. A Play build ignores this (Play In-App Updates).
  // See js/update-model.js (validation) and update.json in the repo (format example).
  const UPDATE_MANIFEST_URL = 'https://github.com/dhlbmhsn357-wq/-/releases/latest/download/update.json';
  const LS_UPDATE_CHECK = 'ayyam_update_check_v1';

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
      'need-key':{text:'☁️ سجّل الدخول للمزامنة', show:true},
      'need-auth':{text:'☁️ سجّل الدخول للمزامنة', show:true},
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
      store = await AyyamStore.open(accountMode ? AC().dbNameFor(accountUid) : undefined);
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

  function defaultPrefs(){ return {theme:'night', bgOn:true, bgOpacity:72, bgBlur:0, location:null, dayTimezone:''}; }

  // ---------- data validation ----------
  // Everything read from the server or localStorage goes through here, so a single bad
  // value can never crash rendering (it is dropped or replaced with a safe default).
  const isObj = v => v!==null && typeof v==='object' && !Array.isArray(v);
  const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // structured 24h "HH:MM" (R2 time picker)
  const cleanTimeValue = v => (typeof v==='string' && TIME_RE.test(v)) ? v : null;
  const EPOCH_KEY = '0000-00-00'; // sorts before every real date key

  function cleanTask(t){
    if(!isObj(t) || typeof t.id!=='string' || !t.id) return null;
    return {
      id: t.id,
      title: typeof t.title==='string' ? t.title : String(t.title ?? ''),
      time: typeof t.time==='string' ? t.time : '',
      timeValue: cleanTimeValue(t.timeValue),
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
        r[k] = { title: v.title, time: typeof v.time==='string' ? v.time : '', timeValue: cleanTimeValue(v.timeValue), period: PERIOD_MAP[v.period] ? v.period : null };
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
      dayTimezone: typeof p.dayTimezone==='string' ? p.dayTimezone : '',
    };
    // Recurrence engine state (dormant until R2 activation): carried through so nothing is lost on
    // load/import/export/round-trip. cleanRoutines mirrors js/routines-model.js.
    const routines = (window.AyyamRoutines ? window.AyyamRoutines.cleanRoutines(src.routines) : {});
    const migrationDate = DATE_KEY_RE.test(src.migrationDate) ? src.migrationDate : '';
    return {template, logs, prefs, tplArchive, routines, migrationDate};
  }

  // The v2 conflict engine lives in js/sync-model.js (LWW registers + tombstones + epoch). The old
  // v1 three-way object merge was removed here when the CAS engine replaced it.

  function withTimeout(p, ms){
    let t;
    return Promise.race([p, new Promise((_, rej)=>{ t = setTimeout(()=>rej(new Error('timeout')), ms); })])
      .finally(()=> clearTimeout(t));
  }
  const clone = o => JSON.parse(JSON.stringify(o));
  function currentBundle(){ return {template, logs, prefs, tplArchive, routines, migrationDate}; }
  function setState(s){ template = s.template; logs = s.logs; prefs = s.prefs; tplArchive = s.tplArchive; routines = s.routines || {}; migrationDate = s.migrationDate || ''; }

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
    scheduleNotifPlan();
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
  // Non-sensitive key-entry diagnostics (NEVER the key itself): lengths + whether cleaning changed it +
  // the last pull outcome for the key path. Surfaced in the diagnostics screen to explain a re-prompt.
  let keyDiag = { rawLen: 0, cleanLen: 0, changed: false, pull: '—' };
  // Remove bidi / zero-width / format-control characters that String.trim() does NOT strip. Android soft
  // keyboards and clipboard (especially in an RTL context) can inject these around a pasted key, so the
  // CORRECT key would be sent WITH invisible characters and rejected by the server as unauthorized — an
  // endless re-prompt. Desktop-web paste was clean, which is why this only bit the Android build.
  function sanitizeKey(raw){
    if(typeof raw !== 'string') return '';
    return raw.replace(/[​-‏؜‪-‮⁦-⁩﻿ ]/g, '').trim();
  }
  // Single entry point for submitting a device key: sanitize → validate length → store (setDeviceKey
  // updates the in-memory cache synchronously). Returns true iff accepted. Never logs the key value.
  function submitDeviceKey(raw){
    const key = sanitizeKey(raw);
    keyDiag.rawLen = (typeof raw === 'string' ? raw.length : 0);
    keyDiag.cleanLen = key.length;
    keyDiag.changed = (typeof raw === 'string' && raw !== key);
    if(store) store.logDiag({ type:'key-entry', rawLen: keyDiag.rawLen, cleanLen: keyDiag.cleanLen, changed: keyDiag.changed }); // no key value, ever
    if(key.length < 16){ alert('المفتاح قصير جدًا. انسخه كما هو من جهازك الآخر.'); return false; }
    setDeviceKey(key);
    needsKey = false;
    return true;
  }
  // Entered once per device, kept only on this device (Keystore on Android, localStorage on web). Never shown/logged.
  function promptForKey(){
    const k = window.prompt('مفتاح المزامنة (يُدخل مرة واحدة على هذا الجهاز لحماية بياناتك):', '');
    if(k === null) return;
    if(submitDeviceKey(k)) syncNow();
  }

  async function rpc(fn, args){
    if(!sb) throw new Error('supabase unavailable');
    const { data, error } = await withTimeout(sb.rpc(fn, args), SYNC_TIMEOUT_MS);
    if(error) throw error;
    return data;
  }

  // ---------- account / session (P2) ----------
  // accountMode=false → the shipped legacy path (device key, id='main', ayyam_pull/commit) UNCHANGED.
  // accountMode=true  → an authenticated session syncs its OWN per-user row via the authenticated *_v2 RPCs.
  const AC = () => globalThis.AyyamAccount;
  let accountMode = false, accountUid = null, sessionExpired = false;
  const LS_MIG_OP = 'ayyam_migration_opid_v1';   // stable op id → resume-safe migration commit
  function resolveSyncBackend(){
    if(!AC() || !sb) return null;
    if(accountMode) return AC().v2Backend(sb);
    const key = getDeviceKey();
    return key ? AC().legacyBackend(sb, key) : null;   // legacy needs the device key
  }
  // A sync got 'unauthorized': in account mode the JWT expired (re-auth, stay usable offline); in legacy
  // mode the device key was wrong (re-prompt). Never deletes local data.
  function handleAuthReject(){
    if(accountMode){ sessionExpired = true; syncState = 'need-auth'; }
    else { needsKey = true; syncState = 'need-key'; setDeviceKey(''); }
  }
  function migrationOpId(){
    try{ let v = localStorage.getItem(LS_MIG_OP); if(!v){ v = newId(); localStorage.setItem(LS_MIG_OP, v); } return v; }
    catch(e){ return newId(); }
  }
  // Migrate this legacy install's data into the signed-in account, ONCE. Recovery snapshot → claim (if a
  // device key exists) → deterministic merge with local+pending → CAS commit → verify → mark complete.
  // Idempotent/resumable (stable op id). Returns { status }.
  async function runAccountMigration(){
    if(!(accountMode && AC() && sb && M)) return { status:'unavailable' };
    const backend = AC().v2Backend(sb);
    const key = getDeviceKey();
    if(store){ try{ await store.saveRecovery({ reason:'pre-account-migration', data: M.materialize(enriched) }); }catch(e){} }
    const opId = migrationOpId();
    try{
      if(key){
        return await AC().migrate(backend, { localEnriched: enriched, migrationOpId: opId, now: Date.now(), deviceKey: key });
      }
      // keyless local-only install: nothing to claim — adopt local data into the fresh account row.
      await backend.begin();
      const p = await backend.pull();
      const acctEn = p && p.exists ? M.toEnriched(p.data, 1) : M.empty(0);
      const merged = M.pruneTombstones(M.merge(M.empty(0), enriched, acctEn).merged, Date.now());
      const c = await backend.commit(p && p.exists ? p.revision : 0, merged, opId, 'import');
      if(c && (c.status==='ok' || c.status==='duplicate')){ await backend.complete(); return { status:'ok' }; }
      return { status:(c && c.status) || 'error' };
    }catch(e){ return { status:'error', message:String(e && e.message || e) }; }
  }
  // Auth transitions switch the DB context, so we do it with a controlled reload (a fresh boot opens the
  // right per-user DB and pulls that account's data). Sign-in from legacy runs the one-time migration first;
  // sign-out/switch flushes the outbox first. The initial replay event is ignored (boot already handled it).
  let authReady = false, authBusy = false;
  async function onAuthChanged(session, event){
    // A password-reset link established a short recovery session → prompt for a new password (no reload).
    if(event === 'PASSWORD_RECOVERY'){ try{ openAuth('reset', { dismissible:false }); }catch(e){} return; }
    if(!authReady || authBusy) return;
    const newUid = AC() ? AC().userIdOf(session) : null;
    if(newUid === accountUid) return;   // token refresh / no context change
    authBusy = true;
    try{
      if(newUid && !accountMode){
        accountMode = true; accountUid = newUid;         // target the account for migration + v2 sync
        // Show a clear, honest progress screen while we link this device's data into the account. Data is
        // never lost (a recovery snapshot is written first); the reload afterwards lands in the account DB.
        const AU = globalThis.AyyamAuthUI;
        const hasLegacyData = (function(){ try{ return !enrichedIsEmpty(); }catch(e){ return false; } })() || !!getDeviceKey();
        try{ if(AU) AU.migrating({ title: hasLegacyData ? 'جارٍ ربط بياناتك بحسابك…' : 'جارٍ تجهيز حسابك…', sub:'لا تُغلق التطبيق — نحفظ كل بياناتك بأمان.' }); }catch(e){}
        try{ await runAccountMigration(); }catch(e){}    // idempotent; reload pulls the account data either way
      } else {
        try{ if(navigator.onLine!==false && isPending()) await syncNow('sync'); }catch(e){} // flush before switching
      }
    }finally{ try{ location.reload(); }catch(e){} }
  }
  // Minimal auth actions (wired to the Settings "الحساب" section).
  async function doSignIn(email, password){
    if(!(AC() && sb)) return { error:{ message:'unavailable' } };
    const r = await AC().signIn(sb, email, password);
    return r;
  }
  async function doSignUp(email, password, name){
    if(!(AC() && sb)) return { error:{ message:'unavailable' } };
    return AC().signUp(sb, email, password, name, NATIVE ? NATIVE_VERIFY_REDIRECT : undefined);
  }
  async function doSignOut(){
    if(!(AC() && sb)) return;
    if(isPending() && navigator.onLine!==false){ try{ await syncNow('sync'); }catch(e){} }
    if(isPending() && !confirm('لديك تغييرات لم تتم مزامنتها بعد. تسجيل الخروج لن يحذفها، وستُرفع عند دخولك مرة أخرى. متابعة؟')) return;
    // Account isolation on sign-out: clear the widget snapshot AND cancel this account's scheduled reminders,
    // so the next account never inherits account A's widget or notifications.
    try{ if(NATIVE) await AyyamNative.updateWidgetSnapshot(null); }catch(e){}
    try{ if(NATIVE) await AyyamNative.clearNotif(); }catch(e){}
    await AC().signOut(sb);
    // onAuthChanged(null) will flush + reload into the legacy DB.
  }
  // Native deep-link redirects (Android/Capacitor). The email link returns to the app; AndroidManifest already
  // catches every ayyam:// URL. On web we return to the app's own URL (supabase-js detectSessionInUrl handles it).
  const NATIVE_RESET_REDIRECT = 'ayyam://reset';
  const NATIVE_VERIFY_REDIRECT = 'ayyam://auth';
  async function doForgot(email){
    if(!(AC() && sb)) return { error:{ message:'unavailable' } };
    const redirect = NATIVE ? NATIVE_RESET_REDIRECT : ((location.origin || '') + (location.pathname || '/'));
    return AC().resetPassword(sb, email, redirect);
  }
  async function doReset(newPassword){
    if(!(AC() && sb)) return { error:{ message:'unavailable' } };
    return AC().updatePassword(sb, newPassword);
  }
  // Never surface a raw Supabase error. Maps every known failure — plus offline / rate-limit / server-down —
  // to a calm Arabic sentence. `ctx` is the action ('signin'|'signup'|'forgot'|'reset') for wording nuance.
  function authMessage(e, ctx){
    if(navigator.onLine === false) return 'لا يوجد اتصال بالإنترنت. تحقّق من الشبكة وحاول مجددًا.';
    const status = (e && (e.status || e.statusCode)) || 0;
    const m = String((e && e.message)||'').toLowerCase();
    if(status === 429 || m.includes('rate') || m.includes('too many')) return 'محاولات كثيرة خلال وقت قصير. انتظر قليلًا ثم أعد المحاولة.';
    if(status >= 500 || m.includes('unavailable') || m.includes('gateway') || m.includes('timeout') || m.includes('network') || m.includes('failed to fetch')) return 'الخدمة غير متاحة مؤقتًا. حاول بعد قليل.';
    if(m.includes('not confirmed') || m.includes('not verified') || m.includes('confirm')) return 'لم يتم تأكيد بريدك بعد. افتح رسالة التأكيد في بريدك أولًا.';
    if(m.includes('invalid login') || m.includes('invalid credential') || (m.includes('invalid') && ctx==='signin')) return 'البريد أو كلمة المرور غير صحيحة.';
    if(m.includes('registered') || m.includes('exists') || m.includes('already')) return 'هذا البريد مسجّل بالفعل. جرّب تسجيل الدخول.';
    if(m.includes('password') && m.includes('should')) return 'كلمة المرور قصيرة (٨ أحرف على الأقل).';
    if(m.includes('password')) return 'كلمة المرور غير مقبولة (٨ أحرف على الأقل).';
    if(m.includes('email') && (m.includes('invalid') || m.includes('valid'))) return 'البريد الإلكتروني غير صالح.';
    return 'تعذّر إتمام العملية. حاول مرة أخرى.';
  }
  const authErr = (e)=> authMessage(e, 'signin'); // back-compat

  // Open the premium full-screen auth experience. `o.showEscapes` (first-run gate only) offers "continue
  // without an account" + a tucked-away legacy sync-key path; a genuinely new user never sees the key concept.
  function openAuth(mode, o){
    o = o || {};
    const AU = globalThis.AyyamAuthUI; if(!AU){ return; }
    AU.init({
      onSubmit: async (m, v)=>{
        AU.message('', '');
        if(m==='signup'){
          const nm = (v.name||'').trim();
          if(nm.length < 2 || nm.length > 60){ AU.message('أدخل اسمك (حرفان على الأقل).', 'error'); return; }
          if(!v.email){ AU.message('أدخل بريدك الإلكتروني.', 'error'); return; }
          if((v.password||'').length < 8){ AU.message('كلمة المرور ٨ أحرف على الأقل.', 'error'); return; }
          AU.busy(true); AU.message('جارٍ إنشاء حسابك…', 'info');
          const r = await doSignUp(v.email, v.password, nm);
          if(r && r.error){ AU.busy(false); AU.message(authMessage(r.error,'signup'), 'error'); return; }
          const hasSession = r && r.data && r.data.session;
          if(!hasSession){ // project requires email confirmation → no session yet
            AU.busy(false); AU.setMode('signin');
            AU.message('أنشأنا حسابك. افتح رسالة التأكيد في بريدك ثم سجّل الدخول.', 'success');
            return;
          }
          // session established → onAuthChanged handles migration + reload
          sessionActive = true; track('signup_completed', v.name || v.email);
          AU.message('تم — جارٍ تجهيز حسابك…', 'success');
          if(o.reloadOnSuccess) setTimeout(()=>{ try{ location.reload(); }catch(e){} }, 700);
        } else if(m==='signin'){
          if(!v.email || !v.password){ AU.message('أدخل البريد وكلمة المرور.', 'error'); return; }
          AU.busy(true); AU.message('جارٍ تسجيل الدخول…', 'info');
          const r = await doSignIn(v.email, v.password);
          if(r && r.error){ AU.busy(false); AU.message(authMessage(r.error,'signin'), 'error'); return; }
          sessionActive = true; track('login_success');
          AU.message('تم — جارٍ فتح حسابك…', 'success');
          if(o.reloadOnSuccess) setTimeout(()=>{ try{ location.reload(); }catch(e){} }, 700);
        } else if(m==='forgot'){
          if(!v.email){ AU.message('أدخل بريدك الإلكتروني.', 'error'); return; }
          AU.busy(true); AU.message('جارٍ الإرسال…', 'info');
          const r = await doForgot(v.email);
          AU.busy(false);
          if(r && r.error){ AU.message(authMessage(r.error,'forgot'), 'error'); return; }
          AU.message('إن كان لديك حساب بهذا البريد، فستصلك رسالة بها رابط لإعادة التعيين.', 'success');
        } else if(m==='reset'){
          if((v.password||'').length < 8){ AU.message('كلمة المرور ٨ أحرف على الأقل.', 'error'); return; }
          AU.busy(true); AU.message('جارٍ الحفظ…', 'info');
          const r = await doReset(v.password);
          if(r && r.error){ AU.busy(false); AU.message(authMessage(r.error,'reset'), 'error'); return; }
          AU.message('تم تحديث كلمة المرور. جارٍ الدخول…', 'success');
          setTimeout(()=>{ try{ location.reload(); }catch(e){} }, 900);
        }
      },
      onClose: ()=>{ AU.close(); if(typeof o.onClose==='function') o.onClose(); },
      onOffline: async ()=>{ AU.close(); if(typeof o.onOffline==='function') await o.onOffline(); },
    });
    AU.open(mode||'signin', { dismissible: o.dismissible !== false, showEscapes: !!o.showEscapes });
  }

  function displayNameOf(sess){ try{ const su = sess && sess.user; return (su && su.user_metadata && su.user_metadata.display_name) || ''; }catch(e){ return ''; } }
  // Personalised greeting on Today — reuses the existing quote line (NO extra height, so the fixed FAB never
  // floats over a task). Falls back to the email local-part for a legacy account without a stored name.
  function updateGreeting(){
    try{
      if(!accountMode || !accountDisplayName) return;
      const q = document.querySelector('.hero .quote');
      if(q) q.textContent = 'أهلًا، ' + accountDisplayName;
    }catch(e){}
  }
  async function setupAccountUI(){
    const box = $('accountBox'); if(!box || !AC() || !sb) return;
    let sess=null; try{ sess = await AC().getSession(sb); }catch(e){}
    const uid = AC().userIdOf(sess);
    const email = (sess && sess.user && sess.user.email) || '';
    const name = displayNameOf(sess) || (email ? email.split('@')[0] : '');
    if(uid){
      box.innerHTML = `<div class="acct-row"><span class="acct-you">${name?escapeHtml(name):'مسجّل الدخول'}</span></div>
        ${email?`<p class="acct-hint" style="direction:ltr;text-align:start;margin-top:0;">${escapeHtml(email)}</p>`:''}
        <p class="acct-hint">بياناتك تُزامَن بأمان مع حسابك على كل أجهزتك.</p>
        <button class="btn ghost" id="acctSignOut">تسجيل الخروج</button>`;
      const so=$('acctSignOut'); if(so) so.addEventListener('click', doSignOut);
    } else {
      box.innerHTML = `<p class="acct-hint">أنشئ حسابًا لمزامنة بياناتك بأمان بين أجهزتك — بدون أي مفتاح.</p>
        <button class="btn primary acct-open" id="acctOpenAuth">تسجيل الدخول أو إنشاء حساب</button>`;
      const ob=$('acctOpenAuth'); if(ob) ob.addEventListener('click', ()=> openAuth('signin', { dismissible:true }));
    }
  }

  // ---------- product analytics (P4): privacy-conscious events. NEVER any content — only an event name from
  // a fixed whitelist + platform + app version + the user's own display name. Fire-and-forget; account-only.
  const PLATFORM = NATIVE ? 'android' : 'web';
  let sessionActive = false, accountDisplayName = null;
  async function track(name, displayName){
    try{
      if(!sb || !sessionActive) return;
      await withTimeout(sb.rpc('ayyam_track', { p_name:name, p_platform:PLATFORM, p_app_version:APP_VERSION,
        p_display_name: displayName || accountDisplayName || null }), SYNC_TIMEOUT_MS);
    }catch(e){}
  }
  // ---------- first-time onboarding (P5): a calm spotlight tour with REAL server-side completion. Shown only
  // for a first account (server onboarding_completed_at is null); resumable (server step); skip/replay safe.
  const ONBOARDING_STEPS = [
    { icon:'🌙', title:'أهلًا بك في أيام', body:'رفيقك اليومي لتنظيم صلواتك وأورادك ومهامك، ومتابعة أيامك بثبات.' },
    { target:'.hero', title:'صفحة اليوم', body:'هنا جدول يومك بحسب مواقيت الصلاة — تابع ما أنجزته وما تبقّى بلمحة.' },
    { target:'#fabAdd', title:'إضافة مهمة', body:'من هذا الزر تضيف مهمة أو وردًا جديدًا في أي وقت.' },
    { icon:'🔁', title:'التكرار', body:'لكل مهمة اختر تكرارها: اليوم فقط، أو يوميًا، أو أسبوعيًا، أو أيامًا محددة.' },
    { icon:'🌿', title:'المرونة', body:'يومك ليس دائمًا واحدًا: علّم المهمة «معذور» بلا تقصير، أو «استبدلها» بأخرى.' },
    { target:'#openCalendar', title:'التقويم', body:'اعرض شهرك كاملًا وتابع اتساقك يومًا بيوم.' },
    { target:'#openReports', title:'تحليل الأداء', body:'رؤى هادئة عن أنماطك ومواطن قوّتك، دون أحكام.' },
    { icon:'✨', title:'ابدأ يومك', body:'كل يوم فرصة جديدة. لنبدأ أولى خطواتك في أيام.', cta:'ابدأ يومك' },
  ];
  // Suggested starter items — added as daily routines ONLY when the user explicitly ticks them.
  const STARTER_SUGGESTIONS = [
    { id:'st-fajr-sunnah',    title:'ركعتا الفجر',   period:'fajr' },
    { id:'st-morning-adhkar', title:'أذكار الصباح',  period:'fajr' },
    { id:'st-quran-wird',     title:'ورد القرآن',    period:'dhuhr' },
    { id:'st-evening-adhkar', title:'أذكار المساء',  period:'maghrib' },
    { id:'st-witr',           title:'الوتر',         period:'isha' },
    { id:'st-exercise',       title:'رياضة',         period:'asr' },
  ];
  let onboardingActive = false;
  async function checkOnboarding(){
    try{
      if(!(sb && accountMode && globalThis.AyyamOnboarding)) return;
      const { data, error } = await withTimeout(sb.rpc('ayyam_onboarding_get'), SYNC_TIMEOUT_MS);
      if(error || !data || data.status!=='ok' || data.completed) return; // already onboarded (server truth)
      startOnboarding(Number(data.step)||0);
    }catch(e){}
  }
  function startOnboarding(startStep){
    if(onboardingActive) return; onboardingActive = true;
    try{ $('mainView').classList.remove('hidden'); $('reportsView').classList.add('hidden'); $('calendarView') && $('calendarView').classList.add('hidden'); $('settingsView').classList.add('hidden'); }catch(e){}
    globalThis.AyyamOnboarding.startTour({
      steps: ONBOARDING_STEPS,
      startStep: startStep,
      onProgress: (i)=>{ try{ sb.rpc('ayyam_onboarding_progress', { p_step:i, p_done:false }); }catch(e){} },
      onDone: async (via)=>{
        onboardingActive = false;
        try{ await withTimeout(sb.rpc('ayyam_onboarding_progress', { p_step:ONBOARDING_STEPS.length-1, p_done:true, p_via:via }), SYNC_TIMEOUT_MS); }catch(e){}
        // Offer the optional starter ONLY on a genuine finish of a still-empty account (never on skip/replay).
        if(via==='finished' && enrichedIsEmpty() && !onboardingReplay){ openStarterSetup(); }
        onboardingReplay = false;
      },
    });
  }
  let onboardingReplay = false;
  function replayOnboarding(){ onboardingReplay = true; startOnboarding(0); }
  function openStarterSetup(){
    if(!globalThis.AyyamOnboarding) return;
    globalThis.AyyamOnboarding.startStarter({
      suggestions: STARTER_SUGGESTIONS,
      onApply: async (ids)=>{ await applyStarter(ids); },
      onSkip: ()=>{ render(); },
    });
  }
  // Add ONLY the explicitly-selected suggestions, as daily routines from today forward. Never automatic.
  async function applyStarter(ids){
    try{
      if(!ids || !ids.length){ render(); return; }
      await ensureRoutinesActive(); // new empty account: turn the recurrence engine on so daily routines show
      const from = todayKey();
      ids.forEach((id)=>{
        const sug = STARTER_SUGGESTIONS.find(s=>s.id===id); if(!sug) return;
        const rec = { freq:'daily', days:[], from, to:null };
        const nidv = nid();
        routines[nidv] = { id:nidv, seriesId:nidv, title:sug.title, time:'', timeValue:'', period:sug.period, order:Object.keys(routines).length, rec };
      });
      await saveBundle('sync'); render();
    }catch(e){ render(); }
  }

  // ---------- admin access (P4): revealed ONLY when is_admin() is true. Authority is 100% backend-side —
  // the admin RPCs return 'forbidden' to everyone else, so this is a reveal, not a gate.
  let adminEnabled = false;
  function openAdmin(){ try{ if(globalThis.AyyamAdmin) globalThis.AyyamAdmin.open(); }catch(e){} }
  function hashAdminMaybe(){
    if(adminEnabled && location.hash === '#admin' && globalThis.AyyamAdmin && !globalThis.AyyamAdmin.isOpen()) openAdmin();
  }
  function enableAdmin(){
    if(adminEnabled) return; adminEnabled = true;
    try{ if(globalThis.AyyamAdmin) globalThis.AyyamAdmin.init({ call: (fn,args)=> rpc(fn,args) }); }catch(e){}
    const slot = $('adminEntry');
    if(slot){ slot.innerHTML = '<button class="btn ghost acct-open" id="openAdmin" style="margin-top:10px;">لوحة التحكم</button>';
      const b=$('openAdmin'); if(b) b.addEventListener('click', openAdmin); }
    window.addEventListener('hashchange', hashAdminMaybe);
    hashAdminMaybe();
  }
  async function checkAdmin(){
    try{
      if(!(sb && accountMode)) return;
      const { data, error } = await withTimeout(sb.rpc('is_admin'), SYNC_TIMEOUT_MS);
      if(!error && data === true) enableAdmin();
    }catch(e){}
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
    const backend = resolveSyncBackend();   // account (v2) OR legacy (device key) — legacy path unchanged
    const hadPending = isPending();
    if(hadPending){ syncState = 'syncing'; updateSyncBadge(); }
    try{
      if(!M) throw new Error('model unavailable');
      if(!backend){ if(hadPending){ needsKey = true; syncState = 'need-key'; } return; } // legacy: no device key yet
      const op = store ? await store.pendingOp() : null;
      const opId = op ? op.op_id : newId();
      const commitReason = (op && op.reason) || reason || 'sync'; // reason from the durable outbox (survives races)

      for(let attempt=0; attempt<MAX_ATTEMPTS; attempt++){
        const pull = await backend.pull();
        if(pull.status === 'unauthorized'){ handleAuthReject(); return; }
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
        const commit = await backend.commit(serverRev, merged, opId, commitReason);
        if(commit.status === 'unauthorized'){ handleAuthReject(); return; }
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
    if(reason === 'reset' || reason === 'import' || reason === 'routines-migrate') enriched = M.bumpEpoch(enriched, currentBundle(), now, DEVICE_ID);
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

  // ---------- R2: one-time recurrence activation (migration) ----------
  // Runs once on load over real data: recovery snapshot → AyyamRoutines.migrate() → persist as a new
  // epoch generation (compatibility fence so a pre-R2 device can't destructively re-write the new state).
  // Idempotent, fail-safe (on any error the old state is kept and the app stays on the legacy path), and
  // self-healing (a stray "migrated but routines missing" state is rebuilt from the retained template).
  let routinesActivated = false;
  function hasTemplateTasks(tpl){ return isObj(tpl) && DAY_CODES.some(c=> Array.isArray(tpl[c]) && tpl[c].length); }
  async function activateRoutinesIfNeeded(){
    if(routinesActivated) return;
    if(typeof AyyamRoutines==='undefined' || typeof AyyamTime==='undefined' || !M) return; // engine missing → legacy
    const b = currentBundle();
    const migrated = !!b.migrationDate && b.routines && Object.keys(b.routines).length>0;
    const corrupt  = !!b.migrationDate && (!b.routines || Object.keys(b.routines).length===0) && hasTemplateTasks(b.template);
    if(migrated && !corrupt){ routinesActivated = true; return; } // already migrated → no-op (idempotent)
    // Nothing to migrate on a truly empty device (before first-load seeds/pulls); the seed/pull path re-invokes this.
    if(enrichedIsEmpty() && !hasTemplateTasks(b.template) && !(b.logs && Object.keys(b.logs).length)) return;
    try{
      const tz = dayTz();
      const today = AyyamTime.todayKey(tz);
      if(store){ try{ await store.saveRecovery({ reason:'pre-routines-migration', bundle: clone(b) }); }catch(_){} }
      const out = AyyamRoutines.migrate(b, today, tz);
      if(!out.migrationDate || (hasTemplateTasks(b.template) && Object.keys(out.routines||{}).length===0)){
        throw new Error('invalid migration output'); // rollback-safe: do not activate on a bad result
      }
      setState(sanitizeBundle(out));
      routinesActivated = true;
      await saveBundle('routines-migrate'); // new epoch generation + durable persist + sync
      if(store) store.logDiag({ type:'routines-migrated', migrationDate: out.migrationDate, count: Object.keys(out.routines).length });
    }catch(e){
      if(store) store.logDiag({ type:'routines-migrate-fail', message: String(e && e.message || e) });
      // fail-safe: keep old state untouched; migrationDate stays '' → tasksForDate uses the legacy path.
    }
  }

  // Force the recurrence engine ON even for an empty account. A new account is no longer auto-seeded (P5),
  // so activateRoutinesIfNeeded() no-ops on an empty bundle and migrationDate stays '' → tasksForDate would
  // use the legacy template path and never show routines. Call this before the FIRST add on such an account.
  async function ensureRoutinesActive(){
    if(migrationDate) return true;
    if(typeof AyyamRoutines==='undefined' || typeof AyyamTime==='undefined' || !M) return false;
    try{
      const b = currentBundle(); const tz = dayTz(); const today = AyyamTime.todayKey(tz);
      const out = AyyamRoutines.migrate(b, today, tz);
      if(!out.migrationDate) return false;
      setState(sanitizeBundle(out)); routinesActivated = true;
      return true;
    }catch(e){ return false; }
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
  // Recurrence engine state — DORMANT in R1 (empty => runtime behaves byte-identically to today).
  // R2 will run AyyamRoutines.migrate() on load and route tasksForDate through the routines engine.
  let routines = {};
  let migrationDate = '';

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

  // Canonical Ayyam-day helpers (R2): the day identity uses prefs.dayTimezone via AyyamTime, NOT the raw
  // device clock — so two devices in different timezones agree on "today". dayCode of a date KEY is
  // timezone-independent, so day-navigation still uses local Date math mapped through keys.
  function dayTz(){ return (typeof AyyamTime!=='undefined') ? AyyamTime.resolveDayTimezone(prefs)
    : (prefs.dayTimezone || (prefs.location && prefs.location.tz) || 'Africa/Cairo'); }
  function todayKey(){ return (typeof AyyamTime!=='undefined') ? AyyamTime.todayKey(dayTz()) : dateKey(new Date()); }

  function ensureLog(key){
    if(!logs[key]) logs[key] = {done:{}, extra:[], hidden:{}, overrides:{}, excused:{}, replacements:{}};
    if(!logs[key].done) logs[key].done = {};
    if(!logs[key].extra) logs[key].extra = [];
    if(!logs[key].hidden) logs[key].hidden = {};
    if(!logs[key].overrides) logs[key].overrides = {};
    if(!logs[key].excused) logs[key].excused = {};
    if(!logs[key].replacements) logs[key].replacements = {};
    return logs[key];
  }
  // Read-only access for rendering: never creates entries (only real edits should add to the data).
  function readLog(key){ return logs[key] || {done:{}, extra:[], hidden:{}, overrides:{}}; }

  function parseKey(k){ const [y,m,d] = k.split('-').map(Number); return new Date(y, m-1, d); } // local midnight

  // First day the app was actually used (earliest day with any recorded activity), capped at today.
  // Stats and reports ignore earlier days instead of counting them as failures.
  function firstActiveKey(){
    const today = todayKey();
    let first = today;
    Object.keys(logs).forEach(k=>{ if(k < first && logHasActivity(logs[k])) first = k; });
    return first;
  }

  // R2: materialization runs through the recurrence engine. For dates >= migrationDate it resolves the
  // routine segments; before migrationDate it falls back to the legacy template/tplArchive path (verbatim
  // semantics), so past days stay logically identical. Per-day done/hidden/overrides/extra are applied
  // identically in both regimes. Falls back to the inline legacy path only if the engine failed to load.
  function tasksForDate(d){
    const key = (typeof d==='string') ? d : dateKey(d);
    if(typeof AyyamRoutines!=='undefined'){
      return AyyamRoutines.tasksForDate(currentBundle(), key);
    }
    const code = JSDAY_TO_CODE[parseKey(key).getDay()];
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

  // Structured-time display: internal storage is 24h "HH:MM"; show Arabic 12h (٣:٣٠ م). Legacy free-text
  // `time` is shown verbatim when there is no structured timeValue.
  function fmtTimeValue(v){
    if(!TIME_RE.test(v||'')) return '';
    let [h,m] = v.split(':').map(Number);
    const ap = h>=12 ? 'م' : 'ص';
    let h12 = h%12; if(h12===0) h12=12;
    return toArabicNum(h12)+':'+toArabicNum(String(m).padStart(2,'0'))+' '+ap;
  }
  function displayTime(t){ return t.timeValue ? fmtTimeValue(t.timeValue) : (t.time||''); }

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
      const key = todayKey();
      const today = parseKey(key);
      const tasks = tasksForDate(key).map(t=>({ id:t.id, title:t.title, time:displayTime(t), period:t.period, done:t.done }));
      const snap = AyyamWidget.buildSnapshot({ date: key, dayLabel: todayWidgetLabel(today), tasks, now: Date.now(), privacy: widgetPrivacy() });
      AyyamNative.updateWidgetSnapshot(snap).then(r=>{ if(store && r && !r.ok && !r.skipped) store.logDiag({ type:'widget-bridge-fail' }); }).catch(()=>{});
    }catch(e){ if(store) store.logDiag({ type:'widget-build-fail' }); }
  }
  function scheduleWidgetPush(){ if(!NATIVE) return; clearTimeout(widgetTimer); widgetTimer = setTimeout(pushWidgetSnapshotNow, 500); }

  // ---------- native local notifications (Android only; no server) ----------
  // Build the reminder PLAN from the current local state (prayer times + open tasks) and hand it to
  // the native scheduler. Runs AFTER the durable save, debounced, failure-isolated: a scheduling
  // failure only logs a diagnostic and never blocks a task edit. Native fires with a stale-date guard.
  let notifTimer = null;
  function pushNotifPlanNow(){
    if(!NATIVE || typeof AyyamNotif==='undefined' || !(AyyamNative.notifConfigured && AyyamNative.notifConfigured())) return;
    try{
      const plan = AyyamNotif.buildPlan(currentBundle(), { now: Date.now(), days: 3 });
      AyyamNative.setNotifPlan(plan).then(r=>{ if(store && r && !r.ok && !r.skipped) store.logDiag({ type:'notif-plan-fail' }); }).catch(()=>{});
    }catch(e){ if(store) store.logDiag({ type:'notif-plan-build-fail' }); }
  }
  function scheduleNotifPlan(){ if(!NATIVE) return; clearTimeout(notifTimer); notifTimer = setTimeout(pushNotifPlanNow, 600); }
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
  // A recovery / email-verification deep link (Android). Establishes the session from the link, then opens the
  // reset screen (recovery) or reloads into the account (verification). Never shows a black/broken web page.
  async function handleAuthDeepLink(rawUrl, host){
    if(!(sb && AC())) return;
    try{ hideStartupState(); if(loadingEl) loadingEl.classList.add('hidden'); }catch(e){}
    let res = null; try{ res = await AC().setSessionFromUrl(sb, rawUrl); }catch(e){}
    if(!res || !res.ok){
      try{ openAuth('signin', { dismissible:false }); if(globalThis.AyyamAuthUI) globalThis.AyyamAuthUI.message('انتهت صلاحية الرابط أو أنه غير صالح. اطلب رابطًا جديدًا.', 'error'); }catch(e){}
      return;
    }
    if(host === 'reset' || (res.type && String(res.type).indexOf('recovery')===0)){
      try{ openAuth('reset', { dismissible:false }); }catch(e){}
    } else {
      // email verified / signed in → boot into the account (onAuthChanged also fires; reload is idempotent)
      try{ location.reload(); }catch(e){}
    }
  }
  function handleDeepLink(url){
    try{
      if(typeof url!=='string' || url.indexOf('ayyam://')!==0) return; // validate scheme
      const u = new URL(url);
      if(u.hostname === 'reset' || u.hostname === 'auth'){ handleAuthDeepLink(url, u.hostname); return; } // password reset / email verify
      if(u.hostname !== 'today') return;                                // only the Today host
      selectedDate = parseKey(todayKey());
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
      // Top-most full-screen flows first (onboarding z-250 > auth z-240 > admin z-230) — never exit mid-flow.
      if(globalThis.AyyamOnboarding && globalThis.AyyamOnboarding.isOpen()){ globalThis.AyyamOnboarding.back(); return; } // onboarding: prev/exit
      if(globalThis.AyyamAuthUI && globalThis.AyyamAuthUI.isOpen()){ globalThis.AyyamAuthUI.handleBack(); return; }        // auth: sub-screen→back / gate consumes
      if(globalThis.AyyamAdmin && globalThis.AyyamAdmin.isOpen()){ globalThis.AyyamAdmin.close(); return; }               // admin dashboard
      const upd = $('updateOverlay');
      if(upd && upd.classList.contains('show')){ closeUpdateSheet(); return; }      // 0. update sheet
      const exc = $('excuseOverlay');
      if(exc && exc.classList.contains('show')){ closeExcuseSheet(); return; }      // 0b. excuse sheet
      const tac = $('taskActionOverlay');
      if(tac && tac.classList.contains('show')){ closeTaskActions(); return; }      // 0c. task action menu
      const add = $('addOverlay');
      if(add && add.classList.contains('show')){ closeAddSheet(); return; }        // 1. open sheet
      const dayOv = $('dayOverlay');
      if(dayOv && dayOv.classList.contains('show')){ closeDayOverview(); return; } // 2. daily overview
      if($('settingsView') && !$('settingsView').classList.contains('hidden')){ closeSettings(); return; } // 3. settings
      if($('reportsView') && !$('reportsView').classList.contains('hidden')){ closeReports(); return; }     // 4. reports
      if($('calendarView') && !$('calendarView').classList.contains('hidden')){ closeCalendar(); return; }  // 5. calendar
      AyyamNative.exitApp();                                                        // 6. nothing → exit
    }catch(e){ try{ AyyamNative.exitApp(); }catch(_){} }
  }
  // Native Android reminders: user-initiated (🔔). Request POST_NOTIFICATIONS (13+) then schedule the
  // plan. Purely local — no server, no token. No-op on web.
  async function enableLocalNotifs(){
    try{
      const r = await AyyamNative.requestNotifPermission();
      if(!r || r.permission!=='granted'){ alert('لتصلك تذكيرات مهامك مع كل صلاة، فعّل إذن الإشعارات من إعدادات التطبيق ثم اضغط 🔔 مرة أخرى.'); return; }
      pushNotifPlanNow(); // schedule now that notifications can be shown
      const b=$('notifyBtn'); if(b){ b.textContent='🔔✓'; b.setAttribute('aria-label','التذكيرات مفعّلة'); }
      if(store) store.logDiag({ type:'local-notifs-enabled' });
    }catch(e){ alert('تعذّر تفعيل التذكيرات. حاول لاحقًا.'); }
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
    scheduleNotifPlan();  // native-only; re-plan local reminders when today's tasks change
  }

  // OVERDUE card (top of Today). Shows ONLY tasks whose PERIOD has already ended and are still not done
  // (fajr→dhuhr→asr→maghrib→isha; a period is overdue once the next prayer has begun). It is a TODAY-only
  // helper — hidden on any other day, and hidden when nothing is overdue (cleaner screen). Widget/calendar/
  // analytics are unaffected. Source of truth: AyyamOverdue.overdueForNow (pure, prayer-boundary based).
  function overdueCountNoun(n){
    if(n===1) return 'مهمة متأخرة عليك';
    if(n===2) return 'مهمتان متأخرتان عليك';
    if(n<=10) return toArabicNum(n)+' مهام متأخرة عليك';
    return toArabicNum(n)+' مهمة متأخرة عليك';
  }
  function renderMissingBanner(){
    const el = $('missingBanner');
    if(!el) return;
    el.classList.remove('ok');
    const isToday = dateKey(selectedDate)===todayKey();
    if(!isToday){ el.classList.add('hidden'); return; }        // "overdue" only makes sense for today
    let res = null;
    try{ res = AyyamOverdue.overdueForNow(currentBundle(), { now: Date.now(), today: todayKey() }); }catch(e){}
    if(!res || !res.available || res.count===0){ el.classList.add('hidden'); return; } // nothing late → hide
    el.classList.remove('hidden');
    const MAX = 6;
    const shown = res.tasks.slice(0, MAX);
    const rest = res.count - shown.length;
    el.innerHTML = `
      <div class="missing-head">⏳ ${overdueCountNoun(res.count)}</div>
      <div class="missing-list">
        ${shown.map(t=>`<span class="missing-chip">${escapeHtml(t.title)}</span>`).join('')}
        ${rest>0 ? `<span class="missing-chip more">+ ${toArabicNum(rest)} أخرى</span>` : ''}
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
    $('statTodayLbl').textContent = dateKey(selectedDate)===todayKey() ? 'اليوم' : DAY_LABELS[code];

    // week pct
    const wStart = startOfWeek(selectedDate);
    const firstDay = parseKey(firstActiveKey());
    let weekTasks = [];
    for(let i=0;i<7;i++){
      const d = new Date(wStart); d.setDate(wStart.getDate()+i);
      if(dateKey(d) > todayKey()) continue; // don't count future days in week avg
      if(d < firstDay) continue;   // nor days before the app was used
      weekTasks = weekTasks.concat(tasksForDate(d));
    }
    $('statWeek').textContent = toArabicNum(pct(weekTasks))+'٪';

    // streak: consecutive 100% days. Today counts once it's complete; while it's still
    // in progress the streak is counted up to yesterday instead of dropping to zero.
    let streak = 0;
    let cursor = parseKey(todayKey());
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
    const today = todayKey();
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
      groupsEl.innerHTML =
        '<div class="empty-state" id="emptyToday">'
        + '<div class="empty-emoji">🌱</div>'
        + '<h3 class="empty-title">يومك يبدأ من هنا</h3>'
        + '<p class="empty-sub">أضف أول مهمة تريد المحافظة عليها.</p>'
        + '<button class="btn primary" id="emptyAddTask" style="max-width:220px;">إضافة أول مهمة</button>'
        + '</div>';
      const b = $('emptyAddTask'); if(b) b.addEventListener('click', ()=> openAddSheet());
      return;
    }

    // A "replaced" original is represented by its replacement occurrence (shown with a "بدلًا من" note),
    // so we don't render the original too. The header count is over ACTIONABLE tasks (excused excluded).
    const groupCount = (list)=>{ const act = list.filter(t=>t.status!=='excused'); return `${toArabicNum(act.filter(t=>t.done).length)}/${toArabicNum(act.length)}`; };
    PERIODS.forEach(p=>{
      const list = tasks.filter(t=>t.period===p.key && t.status!=='replaced');
      if(list.length===0) return;
      const section = document.createElement('div');
      const head = document.createElement('div');
      head.className='group-head';
      head.innerHTML = `<span class="dot-sm" style="background:${p.color}"></span>
        <span class="group-title">${p.label}</span>
        <span class="group-count">${groupCount(list)}</span>`;
      section.appendChild(head);
      list.forEach(t=> section.appendChild(taskRow(t)));
      groupsEl.appendChild(section);
    });

    const free = tasks.filter(t=>!t.period && t.status!=='replaced');
    if(free.length){
      const section = document.createElement('div');
      const head = document.createElement('div');
      head.className='group-head';
      head.innerHTML = `<span class="dot-sm" style="background:var(--text-dim)"></span>
        <span class="group-title">مهام حرة</span>
        <span class="group-count">${groupCount(free)}</span>`;
      section.appendChild(head);
      free.forEach(t=> section.appendChild(taskRow(t)));
      groupsEl.appendChild(section);
    }
  }

  function taskRow(t){
    const excused = t.status==='excused';
    const row = document.createElement('div');
    row.className = 'task' + (t.done?' done':'') + (excused?' excused':'') + (t.isReplacement?' replacement':'');
    if(t.id) row.dataset.taskId = t.id; // deep-link focus target (harmless on web)

    if(excused){
      // Excused: no checkbox (it is not "done"); a calm "معذور" marker instead.
      const badge = document.createElement('span');
      badge.className='excused-mark'; badge.textContent='⊘';
      badge.setAttribute('aria-label','معذور');
      row.appendChild(badge);
    } else {
      const check = document.createElement('button');
      check.className = 'check' + (t.done?' checked':'');
      check.textContent = t.done ? '✓' : '';
      check.setAttribute('aria-label', t.done ? 'إلغاء الإتمام' : 'تمّ');
      check.addEventListener('click', ()=> toggleTask(t));
      row.appendChild(check);
    }

    const mid = document.createElement('div');
    mid.className = 'task-main';
    mid.setAttribute('role','button');
    mid.tabIndex = 0; // reachable and editable from the keyboard too
    mid.setAttribute('aria-label', 'تعديل: ' + t.title);
    let sub = '';
    if(excused) sub = '<div class="task-sub excused">معذور</div>';
    else if(t.isReplacement && t.replacesTitle) sub = `<div class="task-sub">بدلًا من: ${escapeHtml(t.replacesTitle)}</div>`;
    mid.innerHTML = `<div class="task-title">${escapeHtml(t.title)}</div>${sub}`;
    mid.addEventListener('click', ()=> openEditSheet(t));
    mid.addEventListener('keydown', (e)=>{
      if(e.key==='Enter' || e.key===' '){ e.preventDefault(); openEditSheet(t); }
    });
    row.appendChild(mid);

    const disp = displayTime(t);
    if(disp){
      const time = document.createElement('span');
      time.className='task-time';
      time.textContent = disp;
      row.appendChild(time);
    }

    // ⋮ opens the per-occurrence action menu (edit / replace / excuse / undo).
    const menu = document.createElement('button');
    menu.className='task-menu';
    menu.textContent='⋮';
    menu.setAttribute('aria-label','خيارات المهمة');
    menu.addEventListener('click', (e)=>{ e.stopPropagation(); openTaskActions(t); });
    row.appendChild(menu);

    // ✕ quick delete stays (a replacement's ✕ clears the replacement, restoring the original).
    const del = document.createElement('button');
    del.className='task-del';
    del.textContent='✕';
    del.setAttribute('aria-label','حذف المهمة');
    del.addEventListener('click', (e)=>{ e.stopPropagation(); if(t.isReplacement) unreplace(t); else deleteTask(t); });
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

  // Delete a task. A one-off extra is removed. A pre-migration (legacy) occurrence is hidden for this
  // date only. A recurring routine occurrence asks scope: "this day only" (hidden exception) or "this
  // and future" (end the segment at the previous day — never a hard delete of a segment with history).
  async function deleteTask(t){
    const selKey = dateKey(selectedDate);
    const rt = (t.fromTemplate && routines && routines[t.origId]) ? routines[t.origId] : null;
    if(rt){
      const scope = await askScope('delete');
      if(!scope) return;
      if(scope==='today'){
        const log = ensureLog(selKey);
        log.hidden[t.origId]=true; delete log.done[t.origId]; delete log.overrides[t.origId];
      } else {
        routines = AyyamRoutines.endRoutine(routines, t.origId, selKey).routines;
      }
    } else if(t.fromTemplate){
      const log = ensureLog(selKey);
      log.hidden[t.origId]=true; delete log.done[t.origId]; delete log.overrides[t.origId];
    } else {
      const log = ensureLog(selKey);
      log.extra = log.extra.filter(x=>x.id!==t.id); delete log.done[t.id];
    }
    await saveBundle('sync'); render();
  }

  // ---------- per-occurrence action menu: edit / replace / excuse / delete / undo ----------
  let taskActionTarget = null;
  function openTaskActions(t){
    taskActionTarget = t;
    const list = $('taskActionList'); if(!list) return;
    $('taskActionTitle').textContent = t.title || 'المهمة';
    list.innerHTML = '';
    const add = (label, cls, fn)=>{
      const b = document.createElement('button');
      b.className = 'action-item' + (cls?(' '+cls):'');
      b.textContent = label;
      b.addEventListener('click', ()=>{ closeTaskActions(); fn(); });
      list.appendChild(b);
    };
    if(t.isReplacement){
      add('تعديل البديلة', '', ()=> openReplaceEditor({ origId: t.replacesId, period: t.period, timeValue: t.timeValue, fromTemplate: !!(routines && routines[t.replacesId]) }, { title: t.title, period: t.period, timeValue: t.timeValue }, true));
      add('إلغاء الاستبدال', 'danger', ()=> unreplace(t));
    } else if(t.status==='excused'){
      add('إلغاء العذر', '', ()=> unexcuse(t));
      add('تعديل', '', ()=> openEditSheet(t));
      add('حذف', 'danger', ()=> deleteTask(t));
    } else {
      add('تعديل', '', ()=> openEditSheet(t));
      add('استبدال المهمة', '', ()=> openReplaceEditor(t, null, false));
      add('عندي عذر', '', ()=> openExcuseSheet(t));
      add('حذف', 'danger', ()=> deleteTask(t));
    }
    $('taskActionOverlay').classList.add('show');
  }
  function closeTaskActions(){ $('taskActionOverlay').classList.remove('show'); taskActionTarget=null; }

  // «عندي عذر» — mark an occurrence excused for the viewed date (optional reason + note; never required).
  let excuseTarget = null, pendingExcuseReason = '';
  const EXCUSE_REASONS = [['emergency','ظرف طارئ'],['illness','مرض'],['travel','سفر'],['commitment','التزام آخر'],['other','أخرى']];
  function openExcuseSheet(t){
    excuseTarget = t; pendingExcuseReason = '';
    const pick = $('excuseReasonPick'); pick.innerHTML='';
    EXCUSE_REASONS.forEach(([key,label])=>{
      const chip = document.createElement('button');
      chip.className='rec-chip'; chip.textContent=label; chip.setAttribute('aria-pressed','false');
      chip.addEventListener('click', ()=>{
        pendingExcuseReason = (pendingExcuseReason===key) ? '' : key; // toggle
        Array.from(pick.children).forEach(c=>{ c.classList.remove('active'); c.setAttribute('aria-pressed','false'); });
        if(pendingExcuseReason===key){ chip.classList.add('active'); chip.setAttribute('aria-pressed','true'); }
      });
      pick.appendChild(chip);
    });
    $('excuseNote').value='';
    $('excuseTaskTitle').textContent = t.title || '';
    $('excuseOverlay').classList.add('show');
  }
  function closeExcuseSheet(){ $('excuseOverlay').classList.remove('show'); excuseTarget=null; }
  async function saveExcuse(){
    const t = excuseTarget; if(!t) return;
    const selKey = dateKey(selectedDate);
    const note = ($('excuseNote').value||'').trim().slice(0,500);
    logs = AyyamRoutines.setExcused(logs, selKey, t.origId||t.id, { reason: pendingExcuseReason, note });
    await saveBundle('sync'); closeExcuseSheet(); render();
  }
  async function unexcuse(t){
    const selKey = dateKey(selectedDate);
    logs = AyyamRoutines.clearExcused(logs, selKey, t.origId||t.id);
    await saveBundle('sync'); render();
  }

  // «استبدال المهمة» — reuses the add/edit sheet in replace mode. today-only ⇒ logs.replacements; a
  // recurring original with scope "this and future" ⇒ recurrence split (same seriesId, new title/time).
  let replacingOccurrence = null, replaceForceToday = false;
  function openReplaceEditor(orig, prefill, forceToday){
    editingTask = null; isEditingRoutine = false; editingRoutineId = null; editingContext = 'day';
    replacingOccurrence = orig; replaceForceToday = !!forceToday;
    $('sheetTitle').textContent = 'استبدال المهمة';
    $('saveAdd').textContent = 'حفظ البديلة';
    $('taskTitle').value = (prefill && prefill.title) ? prefill.title : '';
    pendingPeriod = (prefill && 'period' in prefill) ? prefill.period : (orig.period || null);
    pendingTimeValue = (prefill && 'timeValue' in prefill) ? prefill.timeValue : (orig.timeValue || null);
    setTimeUI(pendingTimeValue);
    renderPeriodPick();
    showRecurrenceField(false); // the replacement is a single task; recurrence scope is handled by the modal
    showSheet();
  }
  async function unreplace(t){
    const selKey = dateKey(selectedDate);
    if(t.done && !confirm('البديلة منجزة. إلغاء الاستبدال سيحذفها ويعيد المهمة الأصلية. أتريد المتابعة؟')) return;
    logs = AyyamRoutines.clearReplacement(logs, selKey, t.replacesId);
    await saveBundle('sync'); render();
  }

  // ---------- add / edit task sheet (recurrence-aware, R2) ----------
  let editingTask = null;        // null = adding, otherwise the task object being edited
  let editingContext = 'day';    // 'day' (main view) | 'template' (recurrence management screen)
  let isEditingRoutine = false;  // true when the edited occurrence maps to a routine segment
  let editingRoutineId = null;
  let pendingRec = { freq: 'once', days: [] }; // UI recurrence: once | weekly | daily | selected
  let pendingTimeValue = null;
  const REC_OPTS = [
    { key:'once',     label:'هذا الأسبوع فقط' },
    { key:'weekly',   label:'كل أسبوع' },
    { key:'daily',    label:'كل يوم' },
    { key:'selected', label:'أيام محددة' },
  ];

  function renderPeriodPick(){
    const pick = $('periodPick'); pick.innerHTML='';
    pick.appendChild(makeChip('حرة', null, 'var(--surface)'));
    PERIODS.forEach(p=> pick.appendChild(makeChip(p.label, p.key, p.color)));
  }
  function defaultDay(){ return editingContext==='template' ? settingsDay : (typeof AyyamTime!=='undefined' ? AyyamTime.dayCode(dateKey(selectedDate)) : dayCodeFor(selectedDate)); }
  function renderRecPick(){
    const pick = $('recPick'); if(!pick) return; pick.innerHTML='';
    REC_OPTS.forEach(o=>{
      const chip = document.createElement('button'); chip.type='button';
      chip.className='rec-chip'+(pendingRec.freq===o.key?' active':'');
      chip.textContent=o.label; chip.dataset.rec=o.key;
      chip.setAttribute('aria-pressed', String(pendingRec.freq===o.key));
      chip.addEventListener('click', ()=>{
        pendingRec.freq=o.key;
        if(o.key==='weekly') pendingRec.days=[defaultDay()];
        else if(o.key==='selected'){ if(!pendingRec.days.length) pendingRec.days=[defaultDay()]; }
        else pendingRec.days=[];
        renderRecPick(); renderWeekdayPick();
      });
      pick.appendChild(chip);
    });
  }
  function renderWeekdayPick(){
    const wp=$('weekdayPick'); if(!wp) return;
    const show = pendingRec.freq==='selected';
    wp.classList.toggle('hidden', !show);
    wp.innerHTML='';
    if(!show) return;
    DAY_CODES.forEach(code=>{
      const b=document.createElement('button'); b.type='button';
      b.className='wd-chip'+(pendingRec.days.includes(code)?' active':'');
      b.textContent=DAY_LABELS_SHORT[code]; b.setAttribute('aria-label', DAY_LABELS[code]);
      b.setAttribute('aria-pressed', String(pendingRec.days.includes(code)));
      b.addEventListener('click', ()=>{
        const i=pendingRec.days.indexOf(code);
        if(i>=0) pendingRec.days.splice(i,1); else pendingRec.days.push(code);
        renderWeekdayPick();
      });
      wp.appendChild(b);
    });
  }
  function setTimeUI(tv){
    const inp=$('taskTimeValue'), no=$('taskNoTime');
    if(tv){ inp.value=tv; no.checked=false; inp.disabled=false; }
    else { inp.value=''; no.checked=true; inp.disabled=true; }
  }
  function readTimeUI(){
    if($('taskNoTime').checked) return null;
    const v=$('taskTimeValue').value; return TIME_RE.test(v) ? v : null;
  }
  function showRecurrenceField(show){ const f=$('recurrenceField'); if(f) f.classList.toggle('hidden', !show); }
  // Build a routine rec object from the current UI selection, effective from `fromKey`.
  function recFromPending(fromKey){
    const f=pendingRec.freq;
    if(f==='daily') return { freq:'daily', days:[], from:fromKey, to:null };
    if(f==='once')  return { freq:'once', on:fromKey, from:fromKey, to:null };
    let days = (pendingRec.days && pendingRec.days.length) ? pendingRec.days.slice()
      : [ (typeof AyyamTime!=='undefined' ? AyyamTime.dayCode(fromKey) : defaultDay()) ];
    return { freq:'weekly', days, from:fromKey, to:null };
  }
  function recSummary(r){
    const rec=r.rec||{};
    if(rec.freq==='daily') return 'كل يوم';
    if(rec.freq==='once') return 'مرة واحدة';
    const days=rec.days||[];
    if(days.length<=1) return 'كل ' + (DAY_LABELS[days[0]]||'أسبوع');
    return days.map(d=>DAY_LABELS_SHORT[d]).join('، ');
  }

  function openAddSheet(opts){
    opts = (opts && typeof opts==='object' && !opts.type) ? opts : {}; // ignore DOM events passed as arg
    editingTask = null; isEditingRoutine=false; editingRoutineId=null; replacingOccurrence=null; replaceForceToday=false;
    editingContext = opts.mode==='template' ? 'template' : 'day';
    $('sheetTitle').textContent = editingContext==='template' ? 'روتين جديد' : 'مهمة جديدة';
    $('saveAdd').textContent = 'إضافة';
    $('taskTitle').value='';
    pendingPeriod = null;
    pendingTimeValue = null; setTimeUI(null);
    if(editingContext==='template') pendingRec = { freq:'weekly', days:[ opts.day || settingsDay ] };
    else pendingRec = { freq:'once', days:[] }; // day add defaults to "this week only" (no assumption of weekly)
    renderPeriodPick(); renderRecPick(); renderWeekdayPick(); showRecurrenceField(true);
    showSheet();
  }

  function openEditSheet(t){
    editingTask = t; editingContext='day'; replacingOccurrence=null; replaceForceToday=false;
    const rt = (t.fromTemplate && routines && routines[t.origId]) ? routines[t.origId] : null;
    isEditingRoutine = !!rt; editingRoutineId = rt ? rt.id : null;
    $('sheetTitle').textContent = 'تعديل المهمة';
    $('saveAdd').textContent = 'حفظ التعديل';
    $('taskTitle').value = t.title;
    pendingPeriod = t.period || null;
    pendingTimeValue = t.timeValue || null; setTimeUI(pendingTimeValue);
    renderPeriodPick();
    if(rt){ setPendingRecFromRoutine(rt); renderRecPick(); renderWeekdayPick(); showRecurrenceField(true); }
    else { showRecurrenceField(false); } // one-off extra or pre-migration occurrence: no recurrence editing
    showSheet();
  }

  // Open the editor for a routine from the recurrence-management screen (edits apply from today forward).
  function openRoutineEditor(r){
    editingTask = { id:r.id, origId:r.id, title:r.title, period:r.period, timeValue:r.timeValue, time:r.time, fromTemplate:true };
    editingContext='template'; isEditingRoutine=true; editingRoutineId=r.id;
    $('sheetTitle').textContent='تعديل الروتين';
    $('saveAdd').textContent='حفظ';
    $('taskTitle').value=r.title;
    pendingPeriod=r.period||null;
    pendingTimeValue=r.timeValue||null; setTimeUI(pendingTimeValue);
    renderPeriodPick(); setPendingRecFromRoutine(r); renderRecPick(); renderWeekdayPick(); showRecurrenceField(true);
    showSheet();
  }
  function setPendingRecFromRoutine(r){
    const rec=r.rec||{};
    if(rec.freq==='daily') pendingRec={freq:'daily',days:[]};
    else if(rec.freq==='once') pendingRec={freq:'once',days:[]};
    else { const days=(rec.days||[]).slice(); pendingRec = (days.length>1) ? {freq:'selected',days} : {freq:'weekly',days}; }
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
    editingTask=null; replacingOccurrence=null; replaceForceToday=false;
    // return focus to where the user was (if that element still exists after re-render)
    if(sheetReturnFocus && document.contains(sheetReturnFocus)) sheetReturnFocus.focus();
    sheetReturnFocus = null;
  }
  // Keyboard: Enter saves, Escape cancels, Tab stays inside the open sheet.
  $('addOverlay').addEventListener('keydown', (e)=>{
    if(e.key==='Escape'){ e.preventDefault(); closeAddSheet(); return; }
    if(e.key==='Enter' && e.target.id==='taskTitle'){ e.preventDefault(); saveTask(); return; }
    if(e.key==='Tab'){
      const f = Array.from($('addOverlay').querySelectorAll('input, button'));
      const first = f[0], last = f[f.length-1];
      if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); }
    }
  });

  // Scope chooser for editing/deleting a recurring routine (resolves 'today' | 'future' | null).
  let scopeResolver = null;
  function askScope(kind){
    return new Promise((resolve)=>{
      scopeResolver = resolve;
      $('scopeMsg').textContent = kind==='delete' ? 'حذف هذه المهمة المتكررة من:' : kind==='replace' ? 'تطبيق الاستبدال على:' : 'تطبيق التعديل على:';
      $('scopeOverlay').classList.add('show');
    });
  }
  function resolveScope(v){
    $('scopeOverlay').classList.remove('show');
    const r = scopeResolver; scopeResolver = null;
    if(r) r(v);
  }

  async function saveTask(){
    const title = $('taskTitle').value.trim();
    if(!title){ $('taskTitle').focus(); return; }
    const timeValue = readTimeUI();
    const period = pendingPeriod;
    const selKey = dateKey(selectedDate);

    // REPLACE mode: today-only ⇒ logs.replacements (original becomes `replaced`); a recurring original
    // with scope "this and future" ⇒ recurrence split (same seriesId, new title/period/time from today).
    if(replacingOccurrence){
      const orig = replacingOccurrence; const origId = orig.origId || orig.id;
      const rt = (orig.fromTemplate && routines && routines[origId]) ? routines[origId] : null;
      if(rt && !replaceForceToday){
        const scope = await askScope('replace');
        if(!scope) return; // cancelled → keep editing
        if(scope==='future'){
          routines = AyyamRoutines.splitRoutine(routines, origId, selKey, { title, period, timeValue, rec: rt.rec });
        } else {
          logs = AyyamRoutines.setReplacement(logs, selKey, origId, { title, period, timeValue });
        }
      } else {
        logs = AyyamRoutines.setReplacement(logs, selKey, origId, { title, period, timeValue });
      }
      await saveBundle('sync'); replacingOccurrence=null; replaceForceToday=false; closeAddSheet(); render(); return;
    }

    // Recurrence-management screen: add/edit a routine, effective from today forward (past immutable).
    if(editingContext==='template'){ await saveTemplateRoutine(title, period, timeValue); return; }

    if(!editingTask){
      // ADD from the day view
      await ensureRoutinesActive(); // empty account: ensure the recurrence engine is on before the first add
      if(pendingRec.freq==='once'){
        const log = ensureLog(selKey);
        log.extra.push({ id:nid(), title, time:'', timeValue, period }); // one-off on this date
      } else {
        const from = (selKey < todayKey()) ? todayKey() : selKey; // recurring never starts in the past
        const rec = recFromPending(from);
        const id = nid();
        routines[id] = { id, seriesId:id, title, time:'', timeValue, period, order:Object.keys(routines).length, rec };
      }
      await saveBundle('sync'); closeAddSheet(); render(); track('task_created'); return;
    }

    // EDIT an existing occurrence
    const t = editingTask;
    if(isEditingRoutine){
      const scope = await askScope('edit');
      if(!scope) return; // cancelled → keep editing
      if(scope==='today'){
        ensureLog(selKey).overrides[t.origId] = { title, time:'', timeValue, period };
      } else {
        routines = AyyamRoutines.splitRoutine(routines, t.origId, selKey, { title, period, timeValue, rec: recFromPending(selKey) });
      }
    } else if(t.fromTemplate){
      // pre-migration (legacy) occurrence → today-only override
      ensureLog(selKey).overrides[t.origId] = { title, time:'', timeValue, period };
    } else {
      const item = ensureLog(selKey).extra.find(x=>x.id===t.id);
      if(item){ item.title=title; item.period=period; item.timeValue=timeValue; item.time=''; }
    }
    await saveBundle('sync'); closeAddSheet(); render();
  }

  async function saveTemplateRoutine(title, period, timeValue){
    const tk = todayKey();
    if(editingTask && isEditingRoutine){
      routines = AyyamRoutines.splitRoutine(routines, editingRoutineId, tk, { title, period, timeValue, rec: recFromPending(tk) });
    } else {
      const id = nid();
      routines[id] = { id, seriesId:id, title, time:'', timeValue, period, order:Object.keys(routines).length, rec: recFromPending(tk) };
    }
    await saveBundle('sync'); closeAddSheet(); renderTplDays(); renderTplTasks(); render();
  }

  function clearWholeDay(){
    const ok = confirm('هل تريد مسح كل مهام هذا اليوم؟ يمكنك دائمًا إضافة مهام جديدة بعدها.');
    if(!ok) return;
    const key = dateKey(selectedDate);
    const log = ensureLog(key);
    tasksForDate(key).forEach(t=>{
      if(t.fromTemplate){ log.hidden[t.origId] = true; delete log.done[t.origId]; delete log.overrides[t.origId]; }
    });
    log.extra = [];
    saveBundle('sync');
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
    const m = { idle:'خامل', syncing:'يتزامن الآن', saved:'تمّت المزامنة', error:'خطأ مؤقت', offline:'غير متصل', 'need-key':'يحتاج تسجيل الدخول', 'need-auth':'يحتاج تسجيل الدخول' };
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
        const ns = await AyyamNative.notifStatus();
        if(ns){
          nativeLines.push('التذكيرات المحلية: ' + (ns.permission==='granted' ? 'مفعّلة' : 'غير مفعّلة') + (typeof ns.count==='number' ? ' · مجدولة ' + toArabicNum(ns.count) : ''));
          if(ns.generatedAt) nativeLines.push('آخر جدولة تذكيرات: ' + relTime(Date.parse(ns.generatedAt)));
        }
        // Location diagnostics — non-sensitive ONLY (permission / precise / services / last update / source).
        // Never the coordinates themselves.
        if(AyyamNative.hasNativeLocation && AyyamNative.hasNativeLocation()){
          const ls = await AyyamNative.location.checkStatus();
          if(ls && ls.permission!=='unsupported'){
            nativeLines.push('إذن الموقع: ' + (ls.permission==='granted' ? 'مسموح' : 'غير مسموح') + (ls.permission==='granted' ? ' · ' + (ls.precise ? 'دقيق' : 'تقريبي') : ''));
            nativeLines.push('خدمة الموقع (GPS): ' + (ls.servicesEnabled ? 'مفعّلة' : 'مغلقة'));
          }
          if(locDiag.at) nativeLines.push('آخر تحديث موقع: ' + relTime(Date.parse(locDiag.at)) + (locDiag.source ? ' · ' + (locDiag.source==='native'?'أصلي':'ويب') : ''));
        }
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
      'الحساب: ' + (accountMode ? 'مسجّل الدخول' : 'غير مسجّل'),
      ...(keyDiag.pull ? ['تشخيص الجلب: ' + keyDiag.pull] : []),
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

  // ---------- performance insights (I1) — pure render over AyyamAnalytics; NO analytics logic here ----------
  const INS_RANGE = { days: 30 };
  const insCard = (title, inner)=> `<div class="report-card"><h3>${title}</h3>${inner}</div>`;
  const periodLbl = (k)=> (PERIOD_MAP[k] ? PERIOD_MAP[k].label : k);

  function renderReports(){
    const A = window.AyyamAnalytics;
    const el = $('insBody'); if(!el) return;
    const opts = Object.assign({ today: todayKey() }, INS_RANGE);
    const bundle = currentBundle();
    const ov = A.overview(bundle, opts);
    if(ov.recordedDays < 5){ el.innerHTML = insSparse(ov.recordedDays); return; } // sparse state
    const rep = A.report(bundle, opts);
    const recs = A.recommendations(rep, ov);
    el.innerHTML =
      insSummary(rep.trend, ov) +
      insPeriods(rep) +
      insConsistent(rep.consistent) +
      insStruggling(rep.struggling) +
      insWeekday(rep) +
      insHourly(A.hourlyStats(bundle, opts)) +
      insRecs(recs) +
      insUnrecordedNote(ov);
  }

  function insSparse(recorded){
    const w = Math.min(100, Math.round(recorded/5*100));
    return `<div class="report-card ins-sparse"><h3>لسه بنكوّن صورتك</h3>
      <p>كلما سجّلت أيامًا أكثر، ستتعرّف «أيام» على أنماط أدائك بشكل أدق.</p>
      <div class="ins-progress"><span>${toArabicNum(recorded)} / ٥ أيام</span>
        <div class="day-progress-bar"><div class="day-progress-fill" style="width:${w}%"></div></div></div></div>`;
  }
  function insSummary(trend, ov){
    const bigPct = trend.status==='ok' ? trend.currentRatePct : ov.overallRatePct;
    const bigLbl = trend.status==='ok' ? 'أداء هذا الأسبوع' : 'متوسط آخر ٣٠ يومًا';
    let tl;
    if(trend.status==='ok'){
      const up = trend.deltaPct>=0;
      tl = `<div class="ins-trend ${up?'up':'down'}">${up?'↑':'↓'} ${toArabicNum(Math.abs(trend.deltaPct))}٪ <span>${up?'أداء أفضل من الأسبوع السابق':'أداء أقل من الأسبوع السابق'}</span></div>`;
    } else {
      tl = `<div class="ins-trend muted">نحتاج بيانات أكثر للمقارنة بالأسبوع السابق</div>`;
    }
    return `<div class="report-card ins-summary">
      <div class="ins-row">
        <div class="ins-big-wrap"><div class="ins-big">${bigPct==null?'—':toArabicNum(bigPct)+'٪'}</div><div class="ins-lbl">${bigLbl}</div></div>
        <div class="ins-mini"><div class="ins-mini-n">${toArabicNum(ov.recordedDays)}</div><div class="ins-lbl">أيام مسجلة</div></div>
        <div class="ins-mini"><div class="ins-mini-n">${ov.overallRatePct==null?'—':toArabicNum(ov.overallRatePct)+'٪'}</div><div class="ins-lbl">آخر ٣٠ يومًا</div></div>
      </div>${tl}</div>`;
  }
  function insPeriods(rep){
    if(rep.periodStatus!=='ok') return insCard('أوقات أدائك', `<p class="ins-empty">نحتاج أيامًا أكثر لاكتشاف أفضل أوقات أدائك</p>`);
    const b = rep.bestPeriod, w = rep.weakestPeriod;
    let bars = '';
    PERIODS.forEach(p=>{
      const st = rep.periods[p.key]; if(!st || st.expected===0) return;
      const faint = st.sampleSize < 5;
      bars += `<div class="ins-bar-row${faint?' faint':''}"><span class="ins-bar-lbl">${p.label}</span>`
        + `<span class="ins-bar-track"><span class="ins-bar-fill" style="width:${st.ratePct||0}%;background:${p.color}"></span></span>`
        + `<span class="ins-bar-pct">${toArabicNum(st.ratePct)}٪${faint?' <em>بيانات قليلة</em>':''}</span></div>`;
    });
    const bw = `<div class="ins-bw">
      <div class="ins-bw-item best"><div class="ins-bw-t">أفضل فترة</div><div class="ins-bw-v">${periodLbl(b.period)}</div><div class="ins-bw-s">أنجزت ${toArabicNum(b.completed)} من ${toArabicNum(b.expected)} · ${toArabicNum(b.ratePct)}٪</div></div>
      <div class="ins-bw-item weak"><div class="ins-bw-t">أضعف فترة</div><div class="ins-bw-v">${periodLbl(w.period)}</div><div class="ins-bw-s">أنجزت ${toArabicNum(w.completed)} من ${toArabicNum(w.expected)} · ${toArabicNum(w.ratePct)}٪</div></div></div>`;
    return insCard('أوقات أدائك', bw + '<div class="ins-bars">'+bars+'</div>');
  }
  function insConsistent(list){
    if(!list.length) return insCard('مهام راسخة', `<p class="ins-empty">لم تتكوّن مهام راسخة بعد</p>`);
    const rows = list.slice(0,5).map(r=>`<div class="ins-task-row"><span class="t">${escapeHtml(r.title)}</span><span class="s">${toArabicNum(r.completed)} / ${toArabicNum(r.expected)} · ${toArabicNum(r.ratePct)}٪</span></div>`).join('');
    return insCard('مهام راسخة', rows);
  }
  function insStruggling(list){
    if(!list.length) return insCard('مهام تحتاج مراجعة', `<p class="ins-empty">لا مهام تحتاج مراجعة حاليًا</p>`);
    const rows = list.slice(0,5).map(r=>`<div class="ins-task-row struggle"><span class="t">${escapeHtml(r.title)}</span><span class="s">أنجزت ${toArabicNum(r.completed)} من ${toArabicNum(r.expected)} · فاتتك ${toArabicNum(r.missed)} ${r.missed===1?'مرة':'مرات'}</span></div>`).join('');
    return insCard('مهام تحتاج مراجعة', rows);
  }
  function insWeekday(rep){
    if(rep.weekdayStatus!=='ok') return insCard('نمط الأسبوع', `<p class="ins-empty">نحتاج أيامًا أكثر لاكتشاف نمط أسبوعك</p>`);
    const b = rep.bestWeekday, w = rep.weakestWeekday;
    return insCard('نمط الأسبوع', `<div class="ins-bw">
      <div class="ins-bw-item best"><div class="ins-bw-t">أفضل يوم</div><div class="ins-bw-v">${DAY_LABELS[b.code]}</div><div class="ins-bw-s">${toArabicNum(b.ratePct)}٪</div></div>
      <div class="ins-bw-item weak"><div class="ins-bw-t">أضعف يوم</div><div class="ins-bw-v">${DAY_LABELS[w.code]}</div><div class="ins-bw-s">${toArabicNum(w.ratePct)}٪</div></div></div>`);
  }
  function insHourly(hourly){
    const strong = (hourly||[]).filter(h=>h.expected>=5).sort((a,b)=>b.rate-a.rate).slice(0,3);
    if(!strong.length) return '';
    const rows = strong.map(h=>`<div class="ins-task-row"><span class="t">${toArabicNum(h.hour)}:٠٠</span><span class="s">${toArabicNum(h.ratePct)}٪ · ${toArabicNum(h.completed)}/${toArabicNum(h.expected)}</span></div>`).join('');
    return insCard('أفضل ساعات إنجازك', rows);
  }
  function insRecs(recs){
    const txt = recs.map(r=>{
      if(r.kind==='struggling') return `مهمة «${escapeHtml(r.title)}» يصعب الالتزام بها حاليًا — أنجزتها ${toArabicNum(r.completed)} من ${toArabicNum(r.expected)} مرات. جرّب مراجعة توقيتها أو تكرارها.`;
      if(r.kind==='period_gap') return `أداؤك في ${periodLbl(r.bestPeriod)} أعلى بوضوح من ${periodLbl(r.weakPeriod)}. قد يناسبك وضع المهام التي تحتاج مجهودًا أكبر في الفترة الأقوى.`;
      return 'استمر في التسجيل عدة أيام أخرى حتى تظهر توصيات أدق.';
    });
    return insCard('توصية', txt.map(t=>`<p class="ins-rec">${t}</p>`).join(''));
  }
  function insUnrecordedNote(ov){
    if(ov.unrecordedDays >= 3 && ov.unrecordedDays >= ov.recordedDays)
      return `<p class="ins-note">بعض الأيام لم تُسجّل، لذلك التحليل يعتمد على الأيام التي تابعتها فقط.</p>`;
    return '';
  }

  function openReports(){
    $('mainView').classList.add('hidden');
    $('reportsView').classList.remove('hidden');
    $('fabAdd').classList.add('hidden');
    renderReports();
    track('insights_opened');
  }
  function closeReports(){
    $('reportsView').classList.add('hidden');
    $('mainView').classList.remove('hidden');
    $('fabAdd').classList.remove('hidden');
  }

  // ---------- calendar month view (C1) — pure render over AyyamAnalytics; NO analytics logic here ----------
  const MONTH_NAMES = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const monthName = (m)=> MONTH_NAMES[m-1] || '';
  let calYear = 2026, calMonth = 1, dayOverviewKey = null;
  const AN = ()=> window.AyyamAnalytics;

  function openCalendar(){
    const tk = todayKey(); calYear = Number(tk.slice(0,4)); calMonth = Number(tk.slice(5,7));
    $('mainView').classList.add('hidden');
    $('calendarView').classList.remove('hidden');
    $('fabAdd').classList.add('hidden');
    renderCalWeekdays(); renderCalLegend(); renderCalendar();
    track('calendar_opened');
  }
  function closeCalendar(){
    $('calendarView').classList.add('hidden');
    $('mainView').classList.remove('hidden');
    $('fabAdd').classList.remove('hidden');
  }
  function calShift(delta){
    let m = calMonth + delta, y = calYear;
    while(m < 1){ m += 12; y--; } while(m > 12){ m -= 12; y++; }
    calMonth = m; calYear = y; renderCalendar();
  }
  function renderCalWeekdays(){
    const el = $('calWeekdays'); el.innerHTML = '';
    DAY_CODES.forEach(c=>{ const s = document.createElement('span'); s.textContent = DAY_LABELS_SHORT[c]; el.appendChild(s); });
  }
  function renderCalLegend(){
    const el = $('calLegend'); el.innerHTML = '';
    [['high','مرتفع'],['medium','متوسط'],['low','منخفض'],['unrecorded','بدون تسجيل']].forEach(([k,l])=>{
      const d = document.createElement('div'); d.className = 'lg'; d.innerHTML = `<span class="cal-dot ${k}"></span>${l}`; el.appendChild(d);
    });
  }
  function calCellAria(s, dnum, isToday, isFuture){
    const dstr = toArabicNum(dnum)+' '+monthName(calMonth);
    if(isFuture) return dstr+' — يوم قادم';
    if(s.state==='no_expected') return dstr+' — لا مهام';
    if(s.state==='unrecorded') return dstr+' — بدون تسجيل';
    const counts = ` — ${toArabicNum(s.completed)} من ${toArabicNum(s.expected)}`;
    if(isToday) return dstr+' — اليوم'+counts;
    const cls = AN().classify(s);
    const label = cls==='high'?'التزام مرتفع':cls==='medium'?'التزام متوسط':'التزام منخفض';
    return dstr+' — '+label+counts;
  }
  function renderCalendar(){
    const A = AN(); const tk = todayKey();
    const m = A.monthSummary(currentBundle(), calYear, calMonth, { today: tk });
    $('calTitle').textContent = monthName(calMonth)+' '+toArabicNum(calYear);
    $('calToday').classList.toggle('hidden', calYear===Number(tk.slice(0,4)) && calMonth===Number(tk.slice(5,7)));

    const grid = $('calGrid'); grid.innerHTML = '';
    const firstKey = `${calYear}-${String(calMonth).padStart(2,'0')}-01`;
    const offset = DAY_CODES.indexOf(AyyamTime.dayCode(firstKey));
    for(let i=0;i<offset;i++){ const c = document.createElement('div'); c.className = 'cal-cell empty'; grid.appendChild(c); }
    m.daySummaries.forEach(s=>{
      const dnum = Number(s.date.slice(-2));
      const isToday = s.date===tk, isFuture = s.date>tk;
      const btn = document.createElement('button');
      btn.className = 'cal-cell' + (isToday?' today':'') + (isFuture?' future':'');
      let dot = '', live = false;
      if(!isFuture){
        if(s.state==='no_expected') dot = 'no_expected';
        else if(s.state==='unrecorded') dot = 'unrecorded';
        else if(isToday){ const lc = A.liveClass(s); if(lc){ dot = lc; live = true; } } // live progress, not a verdict
        else if(s.state==='recorded') dot = A.classify(s) || '';
      }
      btn.innerHTML = `<span class="cal-num">${toArabicNum(dnum)}</span><span class="cal-dot ${dot}${live?' live':''}"></span>`;
      btn.setAttribute('aria-label', calCellAria(s, dnum, isToday, isFuture));
      btn.setAttribute('role','gridcell');
      btn.addEventListener('click', ()=> openDayOverview(s.date));
      grid.appendChild(btn);
    });
    renderCalSummary(m);
  }
  function renderCalSummary(m){
    const el = $('calSummary');
    const items = [
      ['أيام مسجلة', m.recordedDays], ['قوية', m.highDays], ['متوسطة', m.mediumDays],
      ['منخفضة', m.lowDays], ['بدون تسجيل', m.unrecordedDays],
      // "أداء الأيام المسجلة" (NOT "نسبة الشهر"): the % is computed ONLY over the days you actually tracked
      // — unrecorded and future days are excluded entirely, so a single 80% day reads 80%, never diluted.
      ['أداء الأيام المسجلة', m.overallRatePct==null ? '—' : toArabicNum(m.overallRatePct)+'٪'],
    ];
    let html = '<h3>ملخّص الشهر</h3><div class="cal-sum-grid">';
    items.forEach(([l,n])=> html += `<div class="cal-sum-item"><div class="n">${typeof n==='number'?toArabicNum(n):n}</div><div class="l">${l}</div></div>`);
    html += '</div>';
    // Honest scope line: say exactly how many days the percentage is based on, so it can't be misread as
    // a whole-month figure. (Excludes the in-progress today from the "finished recorded" wording.)
    if(m.overallRatePct!=null){
      const rd = m.recordedDays;
      const daysTxt = rd===1 ? 'يوم واحد' : rd===2 ? 'يومين' : (rd<=10 ? toArabicNum(rd)+' أيام' : toArabicNum(rd)+' يومًا');
      html += `<div class="cal-sum-note">النسبة محسوبة على ${daysTxt} سجّلت فيها من هذا الشهر — الأيام غير المسجّلة لا تُحتسب.</div>`;
    }
    // best day only when there is enough data; worst day intentionally omitted (can mislead with little data)
    if(m.recordedDays>=3 && m.bestDay){ html += `<div class="cal-sum-note">أفضل يوم: ${toArabicNum(Number(m.bestDay.date.slice(-2)))} ${monthName(calMonth)} (${toArabicNum(m.bestDay.ratePct)}٪)</div>`; }
    if(m.recordedDays===0){ html += '<div class="cal-sum-note">كلما سجّلت أيامًا أكثر ستظهر لك أنماط أوضح.</div>'; }
    el.innerHTML = html;
  }

  function openDayOverview(dateKey){
    dayOverviewKey = dateKey;
    const A = AN(); const tk = todayKey();
    const s = A.daySummary(currentBundle(), dateKey, { today: tk });
    const m = A.monthSummary(currentBundle(), Number(dateKey.slice(0,4)), Number(dateKey.slice(5,7)), { today: tk });
    const code = dayCodeFor(parseKey(dateKey));
    $('daySheetTitle').textContent = DAY_LABELS[code]+' '+toArabicNum(Number(dateKey.slice(-2)))+' '+monthName(Number(dateKey.slice(5,7)));
    renderDayBody(s, m);
    $('dayOverlay').classList.add('show');
  }
  function closeDayOverview(){ $('dayOverlay').classList.remove('show'); dayOverviewKey = null; }
  function renderDayBody(s, m){
    const el = $('dayBody'); const A = AN();
    if(s.state==='no_expected'){ el.innerHTML = '<div class="day-empty-msg">لا توجد مهام متوقعة في هذا اليوم.</div>'; return; }
    const cls = (s.state==='recorded' && !s.isInProgress) ? (A.classify(s) || 'low') : s.state;
    const stateLabel = s.state==='unrecorded' ? 'بدون تسجيل'
      : s.isInProgress ? 'قيد اليوم'
      : cls==='high' ? 'يوم قوي' : cls==='medium' ? 'يوم متوسط' : 'يوم منخفض';
    let html = `<div><span class="day-state-pill ${cls}">${stateLabel}</span></div>`;
    if(s.state==='unrecorded'){
      html += `<div class="day-empty-msg">لم يتم تسجيل متابعة هذا اليوم. المتوقّع ${toArabicNum(s.expected)} مهمة.</div>`;
      el.innerHTML = html; return;
    }
    const pctv = s.ratePct==null ? 0 : s.ratePct;
    html += `<div class="day-sec"><div style="display:flex;justify-content:space-between;font-size:14px;"><span>${toArabicNum(s.completed)} / ${toArabicNum(s.expected)}</span><span>${toArabicNum(pctv)}٪</span></div>`;
    html += `<div class="day-progress-bar"><div class="day-progress-fill" style="width:${pctv}%"></div></div></div>`;
    // Status-aware sections: actionable (done/not) + excused + replaced are surfaced separately, never hidden.
    const actionable = s.tasks.filter(t=>t.status!=='excused' && t.status!=='replaced');
    const done = actionable.filter(t=>t.done), miss = actionable.filter(t=>!t.done);
    const excused = s.tasks.filter(t=>t.status==='excused');
    const replaced = s.tasks.filter(t=>t.status==='replaced').map(o=>{ const rep = s.tasks.find(x=>x.isReplacement && x.replacesId===o.id); return { from:o.title, to: rep ? rep.title : '' }; });
    if(excused.length || replaced.length){
      let note = `${toArabicNum(s.completed)} من ${toArabicNum(s.actionable)} مهمة قابلة للتنفيذ`;
      if(excused.length) note += ` · ${toArabicNum(excused.length)} بعذر`;
      if(replaced.length) note += ` · ${toArabicNum(replaced.length)} مستبدلة`;
      html += `<div class="cal-sum-note">${note}</div>`;
    }
    if(done.length) html += '<div class="day-sec"><h4>أنجزت</h4>'+done.map(t=>`<div class="day-task done"><span class="mk">✓</span><span>${escapeHtml(t.title)}</span></div>`).join('')+'</div>';
    if(miss.length){ const lbl = s.isInProgress ? 'متبقٍّ' : 'لم تُنجز'; html += `<div class="day-sec"><h4>${lbl}</h4>`+miss.map(t=>`<div class="day-task miss"><span class="mk">○</span><span>${escapeHtml(t.title)}</span></div>`).join('')+'</div>'; }
    if(excused.length) html += '<div class="day-sec"><h4>بعذر</h4>'+excused.map(t=>`<div class="day-task excused"><span class="mk">⊘</span><span>${escapeHtml(t.title)}</span></div>`).join('')+'</div>';
    if(replaced.length) html += '<div class="day-sec"><h4>استُبدلت</h4>'+replaced.map(r=>`<div class="day-task replaced"><span class="mk">↺</span><span>${escapeHtml(r.from)}${r.to?' ← '+escapeHtml(r.to):''}</span></div>`).join('')+'</div>';
    const periods = PERIODS.filter(p=> s.byPeriod[p.key]);
    if(periods.length){
      html += '<div class="day-sec"><h4>حسب الفترة</h4>';
      periods.forEach(p=>{ const b = s.byPeriod[p.key]; const bp = b.ratePct==null?0:b.ratePct; html += `<div class="day-period-row"><span class="pl">${p.label}</span><span class="pt"><span class="pf" style="width:${bp}%;background:${p.color}"></span></span><span>${toArabicNum(b.completed)}/${toArabicNum(b.expected)}</span></div>`; });
      html += '</div>';
    }
    if(s.state==='recorded' && !s.isInProgress && s.rate!=null && m.recordedDays>=5 && m.overallRate!=null){
      const delta = Math.round((s.rate - m.overallRate)*100);
      if(delta!==0){ html += `<div class="cal-sum-note">${delta>0?'أفضل من':'أقل من'} متوسط الشهر بـ${toArabicNum(Math.abs(delta))}٪</div>`; }
    }
    el.innerHTML = html;
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
  // Routines whose CURRENT (not-yet-ended) segment applies to a weekday — the recurrence-management list.
  function routinesForDay(code){
    const tk = todayKey();
    return Object.keys(routines).map(id=>routines[id]).filter(r=>{
      if(!r || !r.rec) return false;
      if(r.rec.to && r.rec.to < tk) return false;        // ended in the past
      if(r.rec.freq==='daily') return true;
      if(r.rec.freq==='weekly') return (r.rec.days||[]).includes(code);
      return false;                                       // 'once' is not part of weekly management
    }).sort((a,b)=>(a.order-b.order)||(a.id<b.id?-1:1));
  }
  async function deleteRoutineFromTemplate(r){
    if(!confirm(`حذف «${r.title}» من الروتين من اليوم فصاعدًا؟ الأيام السابقة لا تتأثر.`)) return;
    routines = AyyamRoutines.endRoutine(routines, r.id, todayKey()).routines;
    await saveBundle('sync');
    renderTplTasks(); render();
  }
  function renderTplTasks(){
    const el = $('tplTasks');
    el.innerHTML='';
    const list = routinesForDay(settingsDay);
    if(!list.length){ el.innerHTML='<p class="empty" style="padding:10px 0;">لا روتين لهذا اليوم بعد. اضغط بالأسفل لإضافة روتين.</p>'; return; }
    list.forEach(r=>{
      const row = document.createElement('div');
      row.className='tpl-task-row';
      const main = document.createElement('button');
      main.className='tpl-routine-main';
      main.style.cssText='flex:1;text-align:start;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 12px;color:var(--text);font-family:inherit;cursor:pointer;';
      main.style.borderInlineStart = '4px solid ' + (r.period ? PERIOD_MAP[r.period].color : 'var(--line)');
      const disp = displayTime(r);
      main.innerHTML = `<div>${escapeHtml(r.title)}</div><div class="rec-summary">${escapeHtml(recSummary(r))}${disp?(' · '+escapeHtml(disp)):''}</div>`;
      main.setAttribute('aria-label','تعديل الروتين: '+r.title);
      main.addEventListener('click', ()=> openRoutineEditor(r));
      row.appendChild(main);

      const del = document.createElement('button');
      del.className='task-del';
      del.style.flex='none';
      del.textContent='✕';
      del.setAttribute('aria-label','حذف الروتين');
      del.addEventListener('click', ()=> deleteRoutineFromTemplate(r));
      row.appendChild(del);

      el.appendChild(row);
    });
  }

  // ---------- wiring ----------
  $('syncBadge').addEventListener('click', ()=>{ if(syncState==='need-key' || syncState==='need-auth') openAuth('signin', { dismissible:true }); });
  $('prevDay').addEventListener('click', ()=>{ selectedDate = new Date(selectedDate); selectedDate.setDate(selectedDate.getDate()-1); render(); });
  $('nextDay').addEventListener('click', ()=>{ selectedDate = new Date(selectedDate); selectedDate.setDate(selectedDate.getDate()+1); render(); });

  $('fabAdd').addEventListener('click', ()=> openAddSheet());
  $('cancelAdd').addEventListener('click', closeAddSheet);
  $('saveAdd').addEventListener('click', saveTask);
  $('addOverlay').addEventListener('click', (e)=>{ if(e.target.id==='addOverlay') closeAddSheet(); });
  // Time picker: "بدون وقت محدد" clears/disables the time input.
  $('taskNoTime').addEventListener('change', ()=>{ const inp=$('taskTimeValue'); if($('taskNoTime').checked){ inp.value=''; inp.disabled=true; } else { inp.disabled=false; setTimeout(()=>{ try{ inp.focus(); }catch(e){} }, 0); } });
  $('taskTimeValue').addEventListener('input', ()=>{ if($('taskTimeValue').value) $('taskNoTime').checked=false; });
  // Recurring edit/delete scope chooser
  $('scopeToday').addEventListener('click', ()=> resolveScope('today'));
  $('scopeFuture').addEventListener('click', ()=> resolveScope('future'));
  $('scopeCancel').addEventListener('click', ()=> resolveScope(null));
  $('scopeOverlay').addEventListener('click', (e)=>{ if(e.target.id==='scopeOverlay') resolveScope(null); });
  $('taskActionClose').addEventListener('click', closeTaskActions);
  $('taskActionOverlay').addEventListener('click', (e)=>{ if(e.target.id==='taskActionOverlay') closeTaskActions(); });
  $('excuseSave').addEventListener('click', saveExcuse);
  $('excuseCancel').addEventListener('click', closeExcuseSheet);
  $('excuseOverlay').addEventListener('click', (e)=>{ if(e.target.id==='excuseOverlay') closeExcuseSheet(); });

  $('clearDayBtn').addEventListener('click', clearWholeDay);
  $('restoreDayBtn').addEventListener('click', restoreDayToTemplate);

  $('openSettings').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('tplAddTask').addEventListener('click', ()=> openAddSheet({ mode:'template', day: settingsDay }));

  // reports
  $('openReports').addEventListener('click', openReports);
  $('closeReports').addEventListener('click', closeReports);

  // calendar
  $('openCalendar').addEventListener('click', openCalendar);
  $('closeCalendar').addEventListener('click', closeCalendar);
  $('calPrev').addEventListener('click', ()=> calShift(-1));
  $('calNext').addEventListener('click', ()=> calShift(1));
  $('calToday').addEventListener('click', ()=>{ const tk=todayKey(); calYear=Number(tk.slice(0,4)); calMonth=Number(tk.slice(5,7)); renderCalendar(); });
  $('dayPrev').addEventListener('click', ()=>{ if(dayOverviewKey) openDayOverview(AyyamTime.addDays(dayOverviewKey,-1)); });
  $('dayNext').addEventListener('click', ()=>{ if(dayOverviewKey) openDayOverview(AyyamTime.addDays(dayOverviewKey,1)); });
  $('dayClose').addEventListener('click', closeDayOverview);
  $('dayOverlay').addEventListener('click', (e)=>{ if(e.target.id==='dayOverlay') closeDayOverview(); });
  { const cd = $('copyDiag'); if(cd) cd.addEventListener('click', copyDiag); }

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
  let locDiag = { source: null, precise: null, at: null }; // non-sensitive; never stores lat/lng
  // Persist a coordinate into prefs.location (+timezone). Silent auto-refresh only saves on real movement.
  function saveLocationFromCoords(lat, lng, interactive, source, precise){
    const next = { lat: r3(lat), lng: r3(lng), tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Cairo' };
    const cur = prefs.location;
    locDiag = { source: source||null, precise: (precise===undefined?null:!!precise), at: new Date().toISOString() };
    if(!interactive && cur && cur.tz===next.tz && kmBetween(cur, next) < 1) return false; // hasn't moved
    prefs.location = next;
    savePrefs(prefs);
    applyPrefs();
    return true;
  }
  // Native Android path: real runtime permission + one-shot fix via LocationBridge, with state-specific
  // messages (granted / denied / denied-permanently → settings / GPS off). NEVER prompts on auto-refresh.
  async function refreshLocationNative(interactive){
    const L = AyyamNative.location;
    let st; try{ st = await L.checkStatus(); }catch(e){ st = { permission:'unknown' }; }
    if(st.permission !== 'granted'){
      if(!interactive) return;                                   // auto-refresh must stay silent
      let req; try{ req = await L.requestPermission(); }catch(e){ req = { permission:'unknown' }; }
      if(req.permission === 'denied_permanently'){
        if(confirm('التطبيق لا يملك إذن الوصول للموقع، ولن يظهر طلب الإذن مرة أخرى. هل تفتح إعدادات التطبيق للسماح بالموقع؟')){ try{ await L.openSettings(); }catch(e){} }
        return;
      }
      if(req.permission !== 'granted'){ alert('لم يتم السماح بالوصول للموقع. يمكنك المحاولة مرة أخرى عند الحاجة.'); return; }
    }
    try{
      const pos = await L.getCurrent();
      const changed = saveLocationFromCoords(pos.lat, pos.lng, interactive, 'native', pos.precise);
      if(interactive) alert(changed ? 'تم تحديث موقعك، وستُحسب مواعيد الصلاة بدقة أكبر.' : 'موقعك محدَّث بالفعل.');
    }catch(e){
      const reason = (e && e.message) || 'error';
      if(!interactive) return;
      if(reason === 'services') alert('الموقع مسموح به، لكن خدمة تحديد المواقع (GPS) مغلقة. فعّلها من إعدادات الهاتف ثم حاول مرة أخرى.');
      else if(reason === 'permission') alert('لم يتم السماح بالوصول للموقع. يمكنك المحاولة مرة أخرى.');
      else alert('تعذّر تحديد موقعك الآن. تأكد من تفعيل خدمة الموقع وحاول مرة أخرى بعد قليل.');
    }
  }
  function refreshLocation(interactive){
    // Native Android → reliable native location (permission is declared + requested here, so the app now
    // appears under App info → Permissions → Location). Web/PWA keeps the browser geolocation flow.
    if(NATIVE && AyyamNative.hasNativeLocation && AyyamNative.hasNativeLocation()){ refreshLocationNative(interactive); return; }
    if(!navigator.geolocation){ if(interactive) alert('تحديد الموقع غير مدعوم في هذا المتصفح.'); return; }
    navigator.geolocation.getCurrentPosition((pos)=>{
      saveLocationFromCoords(pos.coords.latitude, pos.coords.longitude, interactive, 'web', pos.coords.accuracy!=null && pos.coords.accuracy<=100);
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
    routines = {};
    migrationDate = '';
    saveBundle('reset'); // new generation: a stale offline device can't bring the old data back
    renderTplDays();
    renderTplTasks();
    closeSettings();
  });

  // ---------- Android direct-APK updater (native only) ----------
  // Shows the SAME compact "#updateBanner" pill the web SW-update flow uses. On Android the pill opens an
  // update sheet (notes + progress); the actual download/verify/install is done by the native UpdaterBridge
  // (SHA-256 verified, same-signature enforced by the OS, user confirms on the system installer screen).
  let pendingUpdate = null, updateProgressWired = false;
  function showUpdatePill(onClick){
    const banner = $('updateBanner'); if(!banner) return;
    banner.classList.remove('hidden');
    const btn = $('updateNow'); if(btn){ btn.disabled=false; btn.onclick = onClick; }
  }
  function showUpdateProgress(pct){
    const wrap=$('updateProgress'); if(wrap) wrap.classList.remove('hidden');
    const fill=$('updateProgressFill'); if(fill) fill.style.width=Math.max(0,Math.min(100,pct))+'%';
    const lbl=$('updateProgressPct'); if(lbl) lbl.textContent=toArabicNum(Math.round(pct))+'٪';
  }
  function hideUpdateProgress(){ const wrap=$('updateProgress'); if(wrap) wrap.classList.add('hidden'); }
  function openUpdateSheet(){
    const m = pendingUpdate; if(!m) return;
    const ov=$('updateOverlay'); if(!ov) return;
    const v=$('updateSheetVersion'); if(v) v.textContent = m.versionName ? ('الإصدار '+m.versionName) : 'إصدار جديد';
    const n=$('updateSheetNotes'); if(n) n.textContent = m.notes || 'تحسينات وإصلاحات.';
    hideUpdateProgress();
    const btn=$('updateInstall'); if(btn) btn.disabled=false;
    ov.classList.add('show');
  }
  function closeUpdateSheet(){ const ov=$('updateOverlay'); if(ov) ov.classList.remove('show'); }
  async function runAndroidUpdate(){
    const m = pendingUpdate; if(!m || !(NATIVE && AyyamNative.updaterConfigured && AyyamNative.updaterConfigured())) return;
    const btn=$('updateInstall'); if(btn) btn.disabled=true;
    // Update-safety: flush the outbox first; if it can't (offline), let the user choose to proceed.
    try{ if(isPending()) await syncNow('pre-update'); }catch(e){}
    if(isPending() && !confirm('لديك تغييرات لم تتم مزامنتها بعد. يمكنك التحديث الآن وستُرفع لاحقًا عند الاتصال، أو الانتظار. أتريد المتابعة؟')){ if(btn) btn.disabled=false; return; }
    // Ensure the OS allows installing from this app (API 26+); otherwise send the user to enable it once.
    let ci = { canInstall:true }; try{ ci = await AyyamNative.updater.canInstall(); }catch(e){}
    if(!ci.canInstall){
      alert('للتحديث المباشر، فعّل «السماح بتثبيت التطبيقات من هذا المصدر» لأيام. سيفتح النظام هذا الإعداد الآن، ثم اضغط «تحديث الآن» مرة أخرى.');
      try{ await AyyamNative.updater.openInstallSettings(); }catch(e){}
      if(btn) btn.disabled=false; return;
    }
    showUpdateProgress(0);
    try{
      const res = await AyyamNative.updater.download(m.apkUrl, m.sha256); // verifies SHA-256 natively
      showUpdateProgress(100);
      await AyyamNative.updater.install(res.path); // hands to system installer; user confirms the upgrade
      // The system installer now owns the flow; the app data (IndexedDB/device key/outbox/widget) survives
      // an in-place upgrade because the package + signing cert are unchanged.
    }catch(e){
      const reason=(e&&e.message)||'error';
      hideUpdateProgress();
      if(reason==='sha_mismatch') alert('تعذّر تثبيت التحديث: فشل التحقق من سلامة الملف — لم يُثبَّت شيء.');
      else if(reason==='bad_url'||reason==='bad_sha') alert('تعذّر التحديث: بيانات التحديث غير صالحة.');
      else alert('تعذّر تنزيل التحديث الآن. تأكد من اتصالك بالإنترنت وحاول مرة أخرى.');
      if(btn) btn.disabled=false;
    }
  }
  async function checkNativeUpdate(){
    if(!(NATIVE && AyyamNative.updaterConfigured && AyyamNative.updaterConfigured())) return;
    if(!navigator.onLine) return;
    let last=0; try{ last=parseInt(localStorage.getItem(LS_UPDATE_CHECK)||'0',10)||0; }catch(e){}
    if(!AyyamUpdate.shouldCheck(last, Date.now())) return;
    let txt=null;
    try{ const res=await fetch(UPDATE_MANIFEST_URL,{cache:'no-store'}); if(!res.ok) return; txt=await res.text(); }catch(e){ return; }
    try{ localStorage.setItem(LS_UPDATE_CHECK, String(Date.now())); }catch(e){}
    const manifest = AyyamUpdate.parseManifest(txt); if(!manifest) return;
    let installed=null; try{ const info=await AyyamNative.appInfo(); installed=info&&info.build; }catch(e){}
    if(!AyyamUpdate.isUpdateAvailable(manifest, installed)) return; // up-to-date → no badge
    pendingUpdate = manifest;
    if(!updateProgressWired){ updateProgressWired=true; try{ AyyamNative.updater.onProgress((ev)=> showUpdateProgress((ev&&ev.percent)||0)); }catch(e){} }
    showUpdatePill(openUpdateSheet);
  }
  function setupUpdateSheet(){
    const inst=$('updateInstall'); if(inst) inst.addEventListener('click', runAndroidUpdate);
    const cl=$('updateClose'); if(cl) cl.addEventListener('click', closeUpdateSheet);
  }

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
      // Account users register through the authenticated RPC (register_push_v2, identity from the session —
      // no key). A signed-out web user is asked to create an account (the device-key concept is retired).
      let saved = false, unauthorized = false;
      if(sb){
        try{
          let data, error;
          if(accountMode){
            ({ data, error } = await withTimeout(sb.rpc('register_push_v2', {
              p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth }), SYNC_TIMEOUT_MS));
          } else {
            const key = getDeviceKey();
            if(!key){ openAuth('signin', { dismissible:true }); if(globalThis.AyyamAuthUI) AyyamAuthUI.message('أنشئ حسابًا أو سجّل الدخول لتفعيل الإشعارات.', 'info'); return; }
            ({ data, error } = await withTimeout(sb.rpc('register_push', {
              p_key: key, p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth }), SYNC_TIMEOUT_MS));
          }
          if(!error && data && data.status === 'ok') saved = true;
          else if(data && data.status === 'unauthorized') unauthorized = true;
        }catch(e){ saved = false; }
      }
      if(unauthorized){
        if(accountMode){ alert('انتهت جلستك. سجّل الدخول مرة أخرى ثم فعّل الإشعارات.'); }
        else { openAuth('signin', { dismissible:true }); }
        return;
      }
      if(!saved){
        alert('تعذّر تسجيل الإشعارات على الخادم. تأكد من الاتصال وحاول مرة أخرى.');
        return;
      }
      $('notifyBtn').textContent = '🔔✓';
      $('notifyBtn').setAttribute('aria-label','الإشعارات مفعّلة');
      autoRefreshLocation();
    }

    async function setupNotifyButton(){
      // Native Android: Web Push is unavailable in the WebView → the 🔔 enables LOCAL reminders (FCM-free).
      if(NATIVE){
        if(AyyamNative.notifConfigured && AyyamNative.notifConfigured()){
          $('notifyBtn').classList.remove('hidden');
          try{ const st = await AyyamNative.checkNotifPermission(); if(st && st.permission==='granted'){ $('notifyBtn').textContent='🔔✓'; $('notifyBtn').setAttribute('aria-label','التذكيرات مفعّلة'); } }catch(e){}
          $('notifyBtn').addEventListener('click', enableLocalNotifs);
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
    const backend = resolveSyncBackend();
    if(!backend) return accountMode ? 'need-auth' : 'need-key';
    if(!M || !sb) return 'unreachable';
    try{
      const pull = await backend.pull();
      if(pull.status === 'unauthorized'){ if(accountMode){ sessionExpired=true; return 'need-auth'; } keyDiag.pull='unauthorized'; setDeviceKey(''); return 'need-key'; }
      // Account backend reachable but its schema/RPCs aren't deployed here (e.g. the app points at a backend
      // without the P1→P8 migrations). Honest, safe message — never a generic "check your connection".
      if(pull.status === 'error'){
        keyDiag.pull = 'v2-'+(pull.reason||'error');   // safe: a reason code, never a token
        if(accountMode && pull.reason === 'schema_missing') return 'backend-missing';
        if(accountMode && pull.reason === 'unauthorized'){ sessionExpired=true; return 'need-auth'; }
        return 'unreachable';
      }
      keyDiag.pull = 'ready';
      if(pull.exists){
        const serverEn = M.toEnriched(pull.data, 1);
        await adoptEnriched(serverEn, true);
        await persistBaseV2(serverEn, pull.revision);
        setPending(false);
        return 'ready';
      }
      return 'empty';
    }catch(e){ keyDiag.pull='network'; return 'unreachable'; }
  }

  // The first-load overlay: distinct, honest states (never defaults-as-data on an uncertain server).
  function hideStartupState(){ const el=$('startupState'); if(el) el.classList.add('hidden'); }
  function showStartupState(kind){
    if(loadingEl) loadingEl.classList.add('hidden');
    const el = $('startupState'); if(!el) return;
    el.classList.remove('hidden');
    const msg=$('startupMsg'), icon=$('startupIcon');
    const retry=$('startupRetry'), off=$('startupOffline');
    [retry,off].forEach(b=>{ if(b) b.classList.add('hidden'); });
    if(kind==='backend-missing'){
      // Account schema/RPCs not deployed on this backend yet (safe, accurate — no token/secret surfaced).
      icon.textContent='🛠️';
      msg.textContent='خدمة الحسابات غير مهيأة على الخادم بعد. يمكنك المتابعة دون حساب الآن، والمزامنة لاحقًا.';
      if(retry) retry.classList.remove('hidden');
      if(off) off.classList.remove('hidden');
    } else { // load-failed
      icon.textContent='☁️';
      msg.textContent='تعذّر تحميل بياناتك من السحابة. تحقّق من الاتصال وأعد المحاولة.';
      if(retry) retry.classList.remove('hidden');
      if(off) off.classList.remove('hidden');
    }
  }
  // Continue as a local-only device (baseline-stamped, so a later reconnect merges rather than overwrites).
  async function continueOffline(){
    hideStartupState();
    try{ if(globalThis.AyyamAuthUI) globalThis.AyyamAuthUI.close(); }catch(e){}
    await seedDefault(true);
    await activateRoutinesIfNeeded();
    if(loadingEl) loadingEl.classList.add('hidden');
    render();
  }
  async function runFirstLoad(){
    const r = await firstLoadPull();
    if(r==='ready'){ hideStartupState(); await activateRoutinesIfNeeded(); if(loadingEl) loadingEl.classList.add('hidden'); render(); }
    else if(r==='empty'){
      hideStartupState();
      // Account mode: a NEW account starts EMPTY — the onboarding + optional starter let the user choose what
      // to keep. We never auto-add worship/habits (P5). Legacy/offline devices keep the shipped starter schedule.
      if(!accountMode){ await seedDefault(false); }
      await activateRoutinesIfNeeded(); if(loadingEl) loadingEl.classList.add('hidden'); render();
    }
    else if(r==='need-auth'){
      // An account session that can't be confirmed (expired/offline) → ask to sign in; stay usable offline.
      if(loadingEl) loadingEl.classList.add('hidden');
      openAuth('signin', { dismissible:false, reloadOnSuccess:true, onOffline: continueOffline });
    }
    else if(r==='need-key'){
      // A signed-out device with no local data → the premium account gate. The device-key concept is fully
      // retired from the public UI; the only escape is "continue offline".
      if(loadingEl) loadingEl.classList.add('hidden');
      openAuth('signup', { dismissible:false, showEscapes:true, onOffline: continueOffline });
    }
    else if(r==='backend-missing'){ if(loadingEl) loadingEl.classList.add('hidden'); showStartupState('backend-missing'); } // account schema not deployed
    else { showStartupState('load-failed'); } // unreachable
  }
  $('startupRetry').addEventListener('click', ()=>{ if(loadingEl) loadingEl.classList.remove('hidden'); hideStartupState(); runFirstLoad(); });
  $('startupOffline').addEventListener('click', continueOffline);

  // Native: load the secure device key into memory before anything reads it, and sync on app resume.
  if(NATIVE){ try{ await AyyamNative.hydrate(); }catch(e){} try{ AyyamNative.onResume(()=>{ scheduleSync(); scheduleWidgetPush(); scheduleNotifPlan(); checkNativeUpdate(); }); }catch(e){} }

  // P2: detect an authenticated session BEFORE opening storage, so account mode picks the per-user DB.
  // No session → legacy mode (byte-identical to the shipped app). Auth changes trigger a controlled reload.
  try{
    const sess = (sb && AC()) ? await AC().getSession(sb) : null;
    accountUid = AC() ? AC().userIdOf(sess) : null;
    accountMode = !!accountUid;
    sessionActive = accountMode;
    const su = sess && sess.user;
    accountDisplayName = (su && ((su.user_metadata && su.user_metadata.display_name) || su.email)) || null;
  }catch(e){ accountMode=false; accountUid=null; }
  try{ if(sb && AC()) AC().onAuthChange(sb, (s, ev)=> onAuthChanged(s, ev)); }catch(e){}

  const init = await initStorage();          // open IndexedDB (per-user in account mode), migrate once, load
  if(init.state) setState(init.state);
  applyPrefs(); // cached prefs applied immediately so the theme doesn't flash
  selectedDate = parseKey(todayKey()); // canonical "today" once prefs (dayTimezone) are loaded
  if(init.state && !enrichedIsEmpty()){
    // existing device: activate routines once (safe migration), then show local data; sync in background
    await activateRoutinesIfNeeded();
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
  authReady = true;   // from now on, real auth transitions (sign-in/out/switch) trigger a controlled reload
  try{ setupAccountUI(); }catch(e){}
  if(accountMode){ track('app_open'); checkAdmin(); checkOnboarding(); updateGreeting(); } // P4 analytics + admin reveal + P5 onboarding + greeting
  // Settings → "إعادة الجولة التعريفية" (account users; the tour is client-side, completion stays server-side).
  if(accountMode && globalThis.AyyamOnboarding){
    const oe = $('onbEntry');
    if(oe){ oe.innerHTML = '<button class="btn ghost acct-open" id="replayOnb" style="margin-top:10px;">إعادة الجولة التعريفية</button>';
      const rb=$('replayOnb'); if(rb) rb.addEventListener('click', ()=>{ try{ $('settingsView').classList.add('hidden'); $('mainView').classList.remove('hidden'); }catch(e){} replayOnboarding(); }); }
  }
  // P8 settings meta: app version, hide the legacy sync-key card for account users (never expose it), native update check.
  try{
    const av = $('appVersionInfo'); if(av) av.textContent = 'أيام · الإصدار ' + APP_VERSION + (NATIVE ? ' — أندرويد' : ' — ويب');
    if(NATIVE){ const ur=$('appUpdateRow'); if(ur) ur.classList.remove('hidden');
      const cb=$('checkUpdateBtn'); if(cb) cb.addEventListener('click', ()=>{ try{ checkNativeUpdate(); }catch(e){} }); }
  }catch(e){}
  scheduleWidgetPush(); // seed the widget snapshot once startup state is settled
  scheduleNotifPlan();  // seed the local reminder plan
  if(NATIVE){
    try{ AyyamNative.onDeepLink(handleDeepLink); const lu = await AyyamNative.getLaunchUrl(); if(lu) handleDeepLink(lu); }catch(e){}
    try{ AyyamNative.onBack(handleBack); }catch(e){}
    try{ setupWidgetPrivacyToggle(); }catch(e){}
    try{ setupUpdateSheet(); setTimeout(()=>checkNativeUpdate(), 4000); }catch(e){} // check once app is settled
  }
  autoRefreshLocation();
})();

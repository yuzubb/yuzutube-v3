/* =========================================================
   YuzuTube 共通コア（同一オリジンAPI・依存なし）
   ========================================================= */

/* ---------- 基本ヘルパー ---------- */
const esc = s => (s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const qs = (name) => new URLSearchParams(location.search).get(name);

function fmtViews(n){
  if(n==null) return '';
  if(n>=1e8) return (n/1e8).toFixed(1)+'億回視聴';
  if(n>=1e4) return (n/1e4).toFixed(1)+'万回視聴';
  return n.toLocaleString()+'回視聴';
}
function fmtNum(n){
  if(n==null) return '0';
  if(n>=1e8) return (n/1e8).toFixed(1)+'億';
  if(n>=1e4) return (n/1e4).toFixed(1)+'万';
  return n.toLocaleString();
}
function fmtDur(s){
  if(s==null) return '';
  s=Math.floor(s); const h=Math.floor(s/3600),m=Math.floor(s%3600/60),c=s%60;
  const p=x=>String(x).padStart(2,'0');
  return h? `${h}:${p(m)}:${p(c)}` : `${m}:${p(c)}`;
}
function fmtDate(d){
  if(!d||d.length<8) return '';
  return `${d.slice(0,4)}/${d.slice(4,6)}/${d.slice(6,8)}`;
}
function linkify(t){
  return esc(t).replace(/(https?:\/\/[^\s]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>');
}
const durText = v => v.durationText || fmtDur(v.duration);
const viewText = v => v.viewsText || (v.views!=null ? fmtViews(v.views) : '');
const subText = v => [viewText(v), v.publishedText].filter(Boolean).join(' · ');

/* ---------- 接続先の解決（自動接続 / 手動上書き） ----------
   優先順位:
   1) 手動上書き（localStorage yuzu_api）… 主にTermux運営者の検証用
   2) 直近の自動取得キャッシュ（10分）
   3) Gistから公開URLを取得（Termux側だけが更新できる）
*/
let API_BASE = null;
const _clean = u => (u || '').replace(/\/+$/, '');

async function _fetchPublishedBase(){
  const cfg = window.YUZU_CONFIG || {};
  if(!cfg.gistId) return null;
  try{
    const r = await fetch(`https://api.github.com/gists/${cfg.gistId}?t=` + Date.now());
    if(!r.ok) return null;
    const j = await r.json();
    const f = j.files && j.files[cfg.fileName || 'yuzu_server.json'];
    if(!f || !f.content) return null;
    const data = JSON.parse(f.content);
    return _clean(data.url);
  }catch(e){ return null; }
}
function _readBaseCache(){
  try{ return JSON.parse(localStorage.getItem('yuzu_base_cache') || 'null'); }catch(e){ return null; }
}
function _writeBaseCache(base){
  try{ localStorage.setItem('yuzu_base_cache', JSON.stringify({base, ts: Date.now()})); }catch(e){}
}
function _clearBaseCache(){ try{ localStorage.removeItem('yuzu_base_cache'); }catch(e){} }
function _manual(){ try{ return _clean(localStorage.getItem('yuzu_api') || ''); }catch(e){ return ''; } }

async function resolveBase(force){
  const m = _manual();
  if(m) return m;
  if(!force){
    const c = _readBaseCache();
    if(c && c.base && Date.now() - c.ts < 600000) return c.base;
  }
  const pub = await _fetchPublishedBase();
  if(pub){ _writeBaseCache(pub); return pub; }
  const c = _readBaseCache();          // 取得失敗時は古い値でも使う
  return c && c.base ? c.base : null;
}

async function _healthy(base){
  if(!base) return false;
  try{
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 4500);
    const r = await fetch(base + '/api/health', {signal: ctl.signal});
    clearTimeout(to);
    return r.ok;
  }catch(e){ return false; }
}

/* ---------- APIクライアント（API_BASE を前置） ---------- */
const api = (() => {
  const cache = new Map();
  const url = p => (API_BASE || '') + p;
  async function raw(path){
    const r = await fetch(url(path));
    if(!r.ok){ const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }
  async function cached(path){
    if(cache.has(path)) return cache.get(path);
    const data = await raw(path);
    cache.set(path, data);
    return data;
  }
  return {
    _url: url,
    trending:(cont)=> cached('/api/trending'+(cont?`?continuation=${encodeURIComponent(cont)}`:'')),
    search:(q,cont)=> cached('/api/search?q='+encodeURIComponent(q||'')+(cont?`&continuation=${encodeURIComponent(cont)}`:'')),
    suggest:(q)=> API_BASE ? raw('/api/suggest?q='+encodeURIComponent(q)) : Promise.resolve({suggestions:[]}),
    video:(id)=> cached('/api/video/'+id),
    related:(id)=> cached('/api/related/'+id),
    comments:(id)=> cached('/api/comments/'+id),
    channel:(id)=> cached('/api/channel/'+encodeURIComponent(id)),
    playlist:(id)=> cached('/api/playlist/'+encodeURIComponent(id)),
  };
})();
// 動画ストリーム等、絶対URLが必要な場面用
const streamSrc = (id, itag) => (API_BASE||'') + '/api/stream/' + id + (itag ? ('?itag='+itag) : '');

/* ---------- ローカル保存（履歴・登録チャンネル） ---------- */
const store = (() => {
  const read = (k, def) => { try{ return JSON.parse(localStorage.getItem(k)) ?? def; }catch(e){ return def; } };
  const write = (k, v) => { try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} };
  return {
    addHistory(v){
      if(!v || !v.id) return;
      let h = read('yz_history', []).filter(x => x.id !== v.id);
      h.unshift({id:v.id, title:v.title, thumbnail:v.thumbnail, channel:v.channel, ts:Date.now()});
      write('yz_history', h.slice(0, 40));
    },
    history(){ return read('yz_history', []); },
    subs(){ return read('yz_subs', []); },
    isSubbed(id){ return read('yz_subs', []).some(s => s.id === id); },
    toggleSub(ch){
      let s = read('yz_subs', []);
      if(s.some(x => x.id === ch.id)) s = s.filter(x => x.id !== ch.id);
      else s.unshift({id:ch.id, name:ch.name, thumbnail:ch.thumbnail});
      write('yz_subs', s);
      return s.some(x => x.id === ch.id);
    },
  };
})();

/* ---------- コンポーネント ---------- */
function videoCardHTML(v){
  const d = durText(v);
  return `<a class="card" href="/watch?v=${v.id}">
    <div class="thumb"><img loading="lazy" src="${v.thumbnail||''}" alt="">
      ${d?`<span class="dur">${d}</span>`:''}</div>
    <h3>${esc(v.title||'')}</h3>
    <div class="meta">${esc(v.channel||'')}<br>${subText(v)}</div>
  </a>`;
}
function gridHTML(list){ return `<div class="grid">${list.map(videoCardHTML).join('')}</div>`; }

function commentHTML(c){
  const badges = (c.pinned?'<span class="badge">固定</span>':'') + (c.hearted?'<span class="badge">ハート</span>':'');
  return `<div class="comment">
    <img class="avatar" src="${c.authorThumbnail||''}" alt="">
    <div class="body"><div class="who">${esc(c.author||'')}<span>${esc(c.time||'')}</span>${badges}</div>
    <div class="txt">${linkify(c.text||'')}</div>
    <div class="cl">高評価 ${fmtNum(c.likes)}</div></div></div>`;
}

function skeletonGrid(n=12){
  const one = `<div><div class="thumb sk"></div><div class="sk line" style="width:90%"></div><div class="sk line" style="width:55%"></div></div>`;
  return `<div class="grid">${Array(n).fill(one).join('')}</div>`;
}
function spinner(msg){ return `<div class="state"><div class="spinner"></div>${msg||'読み込み中…'}</div>`; }
function errorState(retryFn){
  const id = 'r'+Math.random().toString(36).slice(2);
  setTimeout(()=>{ const b=document.getElementById(id); if(b&&retryFn) b.onclick=retryFn; },0);
  return `<div class="state"><div class="big">読み込めませんでした</div>
    時間をおくか、サーバー側のyt-dlp更新をお試しください。
    ${retryFn?`<div><button class="linkbtn retry" id="${id}">再試行</button></div>`:''}</div>`;
}

/* ヘッダ（検索サジェスト付き）を #header に描画 */
function mountHeader(){
  const host = document.getElementById('header');
  if(!host) return;
  const val = qs('search_query') || '';
  host.outerHTML = `<header>
    <a class="brand" href="/"><span class="slice"></span><span>Yuzu<b>Tube</b></span></a>
    <div class="searchwrap">
      <form class="search" action="/results" method="get" autocomplete="off">
        <input id="q" name="search_query" placeholder="検索" value="${esc(val)}">
        <button type="submit" aria-label="検索">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        </button>
      </form>
      <div class="suggest" id="suggest"></div>
    </div>
    <button class="gear" id="gear" title="接続設定" aria-label="接続設定">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>
    </button>
  </header>`;
  setupSuggest();
  const gear = document.getElementById('gear');
  if(gear) gear.onclick = openSettings;
}

function setupSuggest(){
  const input = document.getElementById('q');
  const box = document.getElementById('suggest');
  if(!input || !box) return;
  let items = [], active = -1, timer = null;

  const go = (text) => { location.href = '/results?search_query=' + encodeURIComponent(text); };
  const render = () => {
    if(!items.length){ box.classList.remove('show'); box.innerHTML=''; return; }
    const icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`;
    box.innerHTML = items.map((s,i)=>`<div data-i="${i}" class="${i===active?'active':''}">${icon}<span>${esc(s)}</span></div>`).join('');
    box.classList.add('show');
    box.querySelectorAll('div').forEach(d=>{
      d.onmousedown = (e)=>{ e.preventDefault(); go(items[+d.dataset.i]); };
    });
  };
  input.addEventListener('input', ()=>{
    const q = input.value.trim();
    active = -1;
    clearTimeout(timer);
    if(!q){ items=[]; render(); return; }
    timer = setTimeout(async ()=>{
      try{ const {suggestions} = await api.suggest(q); items = suggestions.slice(0,10); render(); }
      catch(e){ items=[]; render(); }
    }, 120);
  });
  input.addEventListener('keydown', (e)=>{
    if(!items.length) return;
    if(e.key==='ArrowDown'){ e.preventDefault(); active=(active+1)%items.length; render(); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); active=(active-1+items.length)%items.length; render(); }
    else if(e.key==='Enter' && active>=0){ e.preventDefault(); go(items[active]); }
    else if(e.key==='Escape'){ items=[]; render(); }
  });
  document.addEventListener('click', (e)=>{ if(!e.target.closest('.searchwrap')){ items=[]; render(); } });
}

/* 無限スクロール: loadMore() が false を返すか continuation が尽きたら停止 */
function infiniteScroll(container, loadMore){
  const sentinel = el('<div id="sentinel"></div>');
  container.after(sentinel);
  let busy = false, done = false;
  const io = new IntersectionObserver(async (entries)=>{
    if(done || busy || !entries[0].isIntersecting) return;
    busy = true;
    try{ const more = await loadMore(); if(more===false){ done=true; io.disconnect(); sentinel.remove(); } }
    catch(e){ done=true; io.disconnect(); }
    busy = false;
  }, {rootMargin:'600px'});
  io.observe(sentinel);
  return { stop(){ done=true; io.disconnect(); sentinel.remove(); } };
}

/* ---------- 接続設定モーダル（手動上書き・主に運営者用） ---------- */
function openSettings(){
  let modal = document.getElementById('yz-modal');
  if(!modal){
    modal = el(`<div class="modal" id="yz-modal"><div class="box">
      <h2>接続設定</h2>
      <p>通常は自動接続です（Termux側が現在URLを公開します）。<br>
         手動で特定サーバーに繋ぎたいときだけURLを入れてください。</p>
      <label>サーバーURL（手動上書き）</label>
      <input id="yz-api" placeholder="https://xxxx.trycloudflare.com">
      <button class="save" id="yz-save">保存して接続</button>
      <button class="ghost" id="yz-auto">自動接続に戻す</button>
      <div class="status" id="yz-status"></div>
    </div></div>`);
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if(e.target.id === 'yz-modal') modal.classList.remove('show'); });
    document.getElementById('yz-save').onclick = async () => {
      const v = _clean(document.getElementById('yz-api').value.trim());
      const s = document.getElementById('yz-status');
      if(!v){ s.textContent = 'URLを入力してください'; return; }
      s.textContent = '接続中…';
      try{ localStorage.setItem('yuzu_api', v); }catch(e){}
      if(await _healthy(v)){ s.textContent = '接続OK。再読み込みします'; setTimeout(()=>location.reload(), 600); }
      else s.textContent = 'つながりません。URLとサーバー起動を確認してください';
    };
    document.getElementById('yz-auto').onclick = () => {
      try{ localStorage.removeItem('yuzu_api'); }catch(e){}
      _clearBaseCache();
      location.reload();
    };
  }
  document.getElementById('yz-api').value = _manual();
  document.getElementById('yz-status').textContent = '';
  modal.classList.add('show');
}

/* ---------- 接続待ち画面（自動でリトライ） ---------- */
function renderWaiting(run){
  const app = document.getElementById('app');
  const hasGist = !!(window.YUZU_CONFIG && window.YUZU_CONFIG.gistId);
  app.innerHTML = `<div class="state">
    <div class="spinner"></div>
    <div class="big">サーバーに接続待ち</div>
    ${hasGist
      ? 'Termux側のサーバーが起動すると自動でつながります。<br>起動して数十秒お待ちください。'
      : '自動接続が未設定です。右上の設定からサーバーURLを入力してください。'}
    <div class="retry"><button class="linkbtn" id="yz-retry">今すぐ再確認</button></div>
  </div>`;
  const retry = document.getElementById('yz-retry');
  if(retry) retry.onclick = () => bootstrap(run);
  clearTimeout(renderWaiting._t);
  renderWaiting._t = setTimeout(() => bootstrap(run, true), 6000);  // 自動リトライ
}

/* ---------- 自動接続ブートストラップ ---------- */
async function bootstrap(run, silent){
  clearTimeout(renderWaiting._t);
  API_BASE = await resolveBase(false);
  if(await _healthy(API_BASE)){ run(); return; }
  // 失効の可能性 → Gistを取り直して再解決
  _clearBaseCache();
  API_BASE = await resolveBase(true);
  if(await _healthy(API_BASE)){ run(); return; }
  renderWaiting(run);
}

document.addEventListener('DOMContentLoaded', mountHeader);
// 同一オリジンで動かす（Gist/config不要）
API_BASE = location.origin; bootstrap = function(run){ run(); };

// ═══════════════════════════════════════════════════════
// WareFlow — frontend JS
// ───────────────────────────────────────────────────────
// SEZIONI:
//   DATI & STATE     — variabili globali, D, currentUser
//   API              — apiFetch, load
//   ROUTING          — goTo, renderPage, applyRuolo
//   DARK MODE        — initDark
//   CLOCK & POLLING  — orologio, pollUpdate
//   UNDO STACK       — pushUndo, undoLast, updateUndoBtn
//   SPOSTAMENTO      — renderSpos, salvaSpostamento
//   CARICO/SCARICO   — renderCaricaScarica, salvaCarico
//   CREA             — renderCrea, salvaArticoloDaCarico
//   MAGAZZINI        — renderMag, editMag, salvaMag
//   ARTICOLI         — renderArticoli, editArt, salvaArt
//   CATEGORIE        — renderCat, salvaCat
//   CESTINO           — renderNonAssegnati
//   STORICO          — renderStorico, undoStorico
//   STOCK            — renderStock, delArtNoStock
//   ADMIN            — renderAdmin
//   MODALS           — openModal, closeModal
//   STAMPA           — stampaMagDetail
//   UTILS            — codiceBadge, catPill, fmtDt, nowRoma
// ═══════════════════════════════════════════════════════

const API = window.location.origin + '/api';
const COLORS = [
  '#2563eb','#1d4ed8','#0ea5e9','#0891b2','#06b6d4',
  '#7c3aed','#9333ea','#a855f7','#db2777','#ec4899',
  '#dc2626','#b91c1c','#ea580c','#d97706','#f59e0b',
  '#16a34a','#15803d','#22c55e','#10b981','#14b8a6',
  '#475569','#64748b','#8a6b8d','#1a1814','#374151'
];
let selColor = COLORS[0];
let selColorMag = COLORS[0];
let D = { magazzini:[], categorie:[], articoli:[], stock:[], spostamenti:[], bauli:[], flightcase:[] };

// ─── API ───
function _csrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)_csrf=([^;]+)/);
  return m ? m[1] : '';
}
async function apiFetch(method, url, body) {
  try { return await localFetch(method, API + url, body); }
  catch(e) { toast(e.message, true); throw e; }
}

async function load() {
  const [mag,cat,art,stock,spoData,liste,bauli,flightcase,modelli,flck] = await Promise.all([
    apiFetch('GET','/magazzini'), apiFetch('GET','/categorie'),
    apiFetch('GET','/articoli'),  apiFetch('GET','/stock'),
    apiFetch('GET','/spostamenti'), apiFetch('GET','/liste'),
    apiFetch('GET','/bauli'), apiFetch('GET','/flightcase'), apiFetch('GET','/modelli'), apiFetch('GET','/flck')
  ]);
  D = { magazzini:mag, categorie:cat, articoli:art, stock, spostamenti:spoData.rows||spoData, liste, bauli, flightcase, modelli, flck };
  D._spostamentiTotal = spoData.total || D.spostamenti.length;
  _rebuildMaps();
  aggiornaNavBadge();
}

function _rebuildMaps() {
  D._stockMap = {};
  for (const s of D.stock) {
    if (!D._stockMap[s.art_id]) D._stockMap[s.art_id] = {};
    D._stockMap[s.art_id][s.mag_id] = s.qty;
  }
  D._artMap = Object.fromEntries(D.articoli.map(a => [a.id, a]));
  D._magMap = Object.fromEntries(D.magazzini.map(m => [m.id, m]));
  D._catMap = Object.fromEntries(D.categorie.map(c => [c.id, c]));
  D._spCat = new Set(D.categorie.filter(c => ['BAU','FLC','FLCK'].includes(c.prefisso)).map(c => c.id));
  // contenuto dei case: _contMap[artId][magId] = { tot, case:[{id,nome,codice,qty,tipo}] }
  D._contMap = {};
  const addC = (artId, k, tipo, each) => {
    for (const [mid, cq] of Object.entries(D._stockMap[k.id] || {})) {
      if (!(cq > 0)) continue;
      const e = ((D._contMap[artId] ??= {})[mid] ??= { tot: 0, case: [] });
      e.tot += each * cq; e.case.push({ id: k.id, nome: k.nome, codice: k.codice, qty: each * cq, tipo });
    }
  };
  for (const fc of D.flightcase || []) if (fc.art_id_contenuto && fc.qty_caricata > 0) addC(fc.art_id_contenuto, fc, 'FLC', fc.qty_caricata);
  for (const k of D.flck || []) for (const v of k.voci) if (v.qty_caricata > 0) addC(v.art_id, k, 'FLCK', v.qty_caricata);
}

// Ricarica solo i dati che cambiano con l'operazione specificata
async function loadPartial(tipo) {
  const reload = {
    stock:        ['/stock', '/flightcase', '/flck'],
    spostamenti:  ['/stock', '/spostamenti', '/flightcase', '/flck'],
    articoli:     ['/articoli', '/stock', '/modelli', '/flightcase', '/flck'],
    magazzini:    ['/magazzini', '/stock', '/articoli', '/modelli', '/flightcase', '/flck'],
    categorie:    ['/categorie', '/articoli'],
    all:          null
  }[tipo] || null;
  if (!reload) { await load(); return; }
  const fetches = reload.map(path => apiFetch('GET', path));
  const results = await Promise.all(fetches);
  reload.forEach((path, i) => {
    const key = path.slice(1);
    D[key] = results[i]?.rows !== undefined ? results[i].rows : results[i];
    if (key === 'spostamenti' && results[i]?.total !== undefined) D._spostamentiTotal = results[i].total;
  });
  _rebuildMaps();
  aggiornaNavBadge();
}

// ─── HELPERS ───
const getMag     = id => D._magMap?.[id] ?? D.magazzini.find(m => m.id == id);
const getCat     = id => D._catMap?.[id] ?? D.categorie.find(c => c.id == id);
const getArt     = id => D._artMap?.[id] ?? D.articoli.find(a => a.id == id);
const getMagVirt = ()  => D.magazzini.find(m => m.virtuale == 1);
const getStock   = (artId, magId) => D._stockMap?.[artId]?.[magId] || 0;
// Totali: contano gli articoli liberi + quelli dentro i case (FLC/FLCK) che si trovano nel magazzino.
// Bauli, flight case e flightcase K sono contenitori e non contano come pezzi.
const totalMag   = magId  => {
  let t = 0; const sp = D._spCat;
  for (const [aid, mm] of Object.entries(D._stockMap || {})) { if (sp && sp.has(D._artMap?.[aid]?.cat_id)) continue; t += mm[magId] || 0; }
  for (const mm of Object.values(D._contMap || {})) t += mm[magId]?.tot || 0;
  return t;
};
const getTot = (artId, magId) => getStock(artId, magId) + (D._contMap?.[artId]?.[magId]?.tot || 0);
const totalArtReale = artId => {
  let t = D.stock.filter(s => s.art_id==artId && !getMag(s.mag_id)?.virtuale).reduce((n,s)=>n+s.qty,0);
  for (const [mid, c] of Object.entries(D._contMap?.[artId] || {})) if (!getMag(+mid)?.virtuale) t += c.tot;
  return t;
};
const totalArtAny = artId => D.stock.filter(s => s.art_id==artId).reduce((n,s)=>n+s.qty,0)
  + Object.values(D._contMap?.[artId] || {}).reduce((n,c)=>n+c.tot,0);
function righeMagConContenuti(magId) {        // righe stock del magazzino, con il contenuto dei case sommato
  const out = [], seen = new Set();
  for (const s of D.stock) if (s.mag_id == magId && s.qty > 0) {
    seen.add(s.art_id);
    const c = D._contMap?.[s.art_id]?.[magId];
    out.push(c ? { ...s, qty: s.qty + c.tot, _lib: s.qty, _case: c.case } : s);
  }
  for (const [aid, mm] of Object.entries(D._contMap || {})) {
    const c = mm[magId];
    if (c && !seen.has(+aid)) out.push({ art_id: +aid, mag_id: magId, qty: c.tot, _lib: 0, _case: c.case });
  }
  return out;
}
const caseTot = cs => cs.reduce((n, e) => n + e.qty, 0);
function caseChips(lib, cs) {
  return (lib > 0 ? ` <span class="var-chip">${lib} liberi</span>` : '') + ` <span class="var-chip">${caseTot(cs)} nei case</span>`;
}
function caseBreakdown(lib, cs) {
  const righe = (lib > 0 ? [`<div>${lib} liberi nel magazzino</div>`] : [])
    .concat(cs.map(e => `<div>${e.qty} in <strong>${h(e.nome)}</strong> <span style="color:var(--ink3);font-family:'DM Mono',monospace;font-size:11px">${h(e.codice)}</span></div>`));
  return `<div style="font-size:12px;line-height:1.7;padding:2px 4px">${righe.join('')}</div>`;
}
function caseLines(artId) {                   // pagina Articoli: dove sono i pezzi nei case
  const rows = [];
  for (const [mid, c] of Object.entries(D._contMap?.[artId] || {}))
    for (const e of c.case) rows.push(`<span class="var-chip">${e.qty} in ${h(e.nome)} (${h(getMag(+mid)?.nome || '—')})</span>`);
  return rows.length ? `<div style="margin-top:6px;font-size:11px;color:var(--ink3)">Nei case: ${rows.join(' ')}</div>` : '';
}

// ─── UTILS ───
// Helper getElementById shorthand
function $id(id) { return document.getElementById(id); }
function $set(id, html) { const el = $id(id); if(el) el.innerHTML = html; }
function getMagReali() { return D.magazzini.filter(m => !m.virtuale); }
function isBauleArt(artId) {
  const catBAU = D.categorie.find(c => c.prefisso === 'BAU');
  return !!(catBAU && getArt(artId)?.cat_id === catBAU.id);
}
function isFlightcaseArt(artId) {
  const catFLC = D.categorie.find(c => c.prefisso === 'FLC');
  return !!(catFLC && getArt(artId)?.cat_id === catFLC.id);
}
function isFlckArt(artId) {
  const catK = D.categorie.find(c => c.prefisso === 'FLCK');
  return !!(catK && getArt(artId)?.cat_id === catK.id);
}
function isSpecialArt(artId) { return isBauleArt(artId) || isFlightcaseArt(artId) || isFlckArt(artId); }
function isSpecialCat(catId) { const c = getCat(catId); return c && (c.prefisso === 'BAU' || c.prefisso === 'FLC' || c.prefisso === 'FLCK'); }
function getCatNormali() { return D.categorie.filter(c => c.prefisso !== 'BAU' && c.prefisso !== 'FLC' && c.prefisso !== 'FLCK'); }
function getArtNormali() { return D.articoli.filter(a => !isSpecialArt(a.id)); }
function getFlightcaseDef(artId) { return D.flightcase.find(fc => fc.id === artId); }
function getFlightcasePerArticolo(artId) { return D.flightcase.filter(fc => fc.art_id_contenuto === artId); }
function sortBauliFirst(arr, artIdFn) {
  return [...arr].sort((a,b) => {
    const ba = isSpecialArt(artIdFn ? artIdFn(a) : a.id) ? 0 : 1;
    const bb = isSpecialArt(artIdFn ? artIdFn(b) : b.id) ? 0 : 1;
    return ba - bb;
  });
}
// Helper DELETE con conferma e toast
async function deleteConfirm(url, msg, successMsg, reloadFn) {
  if (!await askConfirm(msg, { ok: 'Elimina', danger: true })) return;
  try { await apiFetch('DELETE', url); if(reloadFn) await reloadFn(); toast(successMsg); }
  catch(e) { toast(e.message||'Errore', true); }
}
// Contrasto automatico: testo chiaro o scuro in base al colore della categoria
const _HEX6 = /^#[0-9a-fA-F]{6}$/;
function _lum(hex) {
  const f = c => { c /= 255; return c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4); };
  return .2126 * f(parseInt(hex.slice(1,3),16)) + .7152 * f(parseInt(hex.slice(3,5),16)) + .0722 * f(parseInt(hex.slice(5,7),16));
}
function _cr(a, b) { const x = _lum(a), y = _lum(b); return (Math.max(x,y) + .05) / (Math.min(x,y) + .05); }
function _mixHex(a, b, t) {
  const c = i => Math.round(parseInt(a.slice(i,i+2),16) * (1-t) + parseInt(b.slice(i,i+2),16) * t).toString(16).padStart(2,'0');
  return '#' + c(1) + c(3) + c(5);
}
function inkOn(bg) {            // testo per uno sfondo pieno
  if (!_HEX6.test(bg || '')) return '#f4f1eb';
  return _cr(bg, '#ffffff') >= _cr(bg, '#1a1814') ? '#ffffff' : '#1a1814';
}
function catInk(col) {          // testo del colore categoria, scurito se serve, su sfondo chiaro
  if (!_HEX6.test(col || '')) return col;
  for (let t = 0; t <= .9; t += .1) { const c = _mixHex(col, '#1a1814', t); if (_cr(c, '#ffffff') >= 5.6) return c; }
  return '#1a1814';
}
function codiceBadge(codice, colore) {
  if (!codice) return '<span class="badge-codice">—</span>';
  const bg = colore || 'var(--ink)';
  return `<span class="badge-codice" style="background:${bg};color:${inkOn(colore)}">${h(codice)}</span>`;
}

function nowRoma() {
  // Data/ora corrente nel fuso di Roma (Europe/Rome)
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Rome',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(now);
  // fmt produce "YYYY-MM-DD HH:MM:SS" → sostituiamo spazio con T e tagliamo secondi
  return fmt.replace(' ', 'T').slice(0, 16);
}

function aggiornaNavBadge() {
  const magVirt = getMagVirt();
  const badge = document.getElementById('navNonAssBadge');
  if (!magVirt) { badge.style.display='none'; return; }
  const n = D.stock.filter(s => s.mag_id==magVirt.id && s.qty>0).length;
  if (n > 0) { badge.textContent = n; badge.style.display = 'inline-block'; }
  else badge.style.display = 'none';
}

function fmtDt(str) {
  if (!str) return '—';
  const d = new Date(str.replace(' ','T'));
  return d.toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric'})
       + ' ' + d.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'});
}
function fmtDtS(str) {   // data compatta (anno a 2 cifre)
  if (!str) return '—';
  const d = new Date(str.replace(' ','T'));
  return d.toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'2-digit'})
       + ' ' + d.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'});
}
function toast(msg, err=false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show'+(err?' err':'');
  clearTimeout(t._t); t._t = setTimeout(()=>t.className='', 3500);
}
function catPill(cat) {
  if (!cat) return '<span class="badge badge-gray">—</span>';
  return `<span class="cat-pill" style="--cc:${cat.colore};background:${cat.colore}18;color:${catInk(cat.colore)};border:1px solid ${cat.colore}40">${h(cat.nome)}</span>`;
}

// ─── NAV ───
let curPage = 'dashboard';
let currentUser = null;
async function goTo(page, fromHist) {
  closeMobileNav();
  if (!fromHist && page !== curPage) { try { history.pushState({ p: page }, '', '#' + page); } catch (e) {} }
  curPage = page;
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b=>{ if(b.getAttribute('onclick')?.includes(page)) b.classList.add('active'); });
  aspettoScrollNav();
  await load();
  renderPage(page);
}
// Clic su una voce della sidebar: se la sezione è già aperta, chiude il dettaglio e torna all'elenco principale
function navTo(page) {
  if (page === curPage) {
    const aperto = id => { const el = document.getElementById(id); return el && el.style.display !== 'none'; };
    if (page === 'liste' && aperto('listaDettaglio')) chiudiDettaglioLista();
    else if (page === 'bauli') {
      if (aperto('bauleDettaglio')) chiudiBauleDettaglio();
      else if (aperto('flcDettaglio')) chiudiFlcDettaglio();
      else if (aperto('flckDettaglio')) chiudiFlckDettaglio();
    }
    else if (page === 'magazzini' && document.getElementById('modalMagDetail').classList.contains('open')) closeModal('modalMagDetail');
    window.scrollTo(0, 0);
  }
  goTo(page);
}
function renderPage(p) {
  ({ dashboard:renderDash, spostamento:renderSpos, caricoscarico:renderCaricaScarica, crea:renderCrea,
     magazzini:renderMag, articoli:renderArticoli, categorie:renderCat,
     nonassegnati:renderNonAssegnati, storico:renderStorico, stock:renderStock,
     liste:renderListe, bauli:renderBauli, admin:renderAdmin, guida:()=>{} })[p]?.();
}

// ─── EVENT DELEGATION ───
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id, artId } = btn.dataset;
  if      (action === 'editArt')        editArt(+id);
  else if (action === 'delArt')         await delArt(+id);
  else if (action === 'delArtDirect')   await delArtDirect(+id);
  else if (action === 'mandaNonAss')    await mandaANonAssegnati(+id);
  else if (action === 'eliminaDef')     await eliminaArtDefinitivo(+artId);
  else if (action === 'scaricaCest')    scaricaCestino(+artId);
  else if (action === 'openMagDetail')  openMagDetail(+id);
});

// ─── DASHBOARD ───
function renderDash() {
  const magReali = getMagReali().length;

  // Contatori
  document.getElementById('dashStats').innerHTML = `
    <div class="lk-count"><b>${magReali}</b><span>magazzini</span></div>
    <div class="lk-count"><b>${D.articoli.length}</b><span>articoli</span></div>
    <div class="lk-count"><b>${(D._spostamentiTotal||D.spostamenti.length).toLocaleString('it-IT')}</b><span>movimenti</span></div>
    <div class="lk-count"><b>${D.categorie.length}</b><span>categorie</span></div>`;

  // Tour attivi
  const tourMags = D.magazzini.filter(m=>m.classe==='tour'&&!m.virtuale);
  document.getElementById('dashTourN').textContent = tourMags.length;
  document.getElementById('dashTour').innerHTML = tourMags.length
    ? tourMags.map(m=>{
        const tot = totalMag(m.id);
        const nTipi = Object.values(D._stockMap||{}).filter(mm=>(mm[m.id]||0)>0).length;
        return `<div class="lk-card ds-row" onclick="openMagDetail(${m.id})">
          <div class="ds-tile">${m.icona||'🚛'}</div>
          <div class="lk-info"><div class="lk-nome">${h(m.nome)}</div><div class="lk-meta">${nTipi} tipi</div></div>
          <div class="ds-num"><b>${tot.toLocaleString('it-IT')}</b><span>pezzi</span></div>
        </div>`;
      }).join('')
    : '<div class="lk-empty">nessun magazzino tour</div>';

  // Liste in preparazione
  const listePrep = (D.liste||[]).filter(l=>l.stato_display==='in-preparazione');
  document.getElementById('dashListeN').textContent = listePrep.length;
  document.getElementById('dashListe').innerHTML = listePrep.length
    ? listePrep.slice(0,5).map(l=>{
        const tot = l.tot_richiesta || 0, pr = l.tot_pronti || 0;
        const pct = tot ? Math.min(100, Math.round(pr / tot * 100)) : 0;
        const src = (l.mag_src_nomi || '').split('|').filter(Boolean).join(' + ');
        const rotta = src ? `${src} → ${l.mag_dest_nome || '—'}` : (l.mag_dest_nome ? '→ ' + l.mag_dest_nome : 'Nessuna destinazione');
        return `<div class="lk-card" onclick="apriListaDaDash(${l.id})">
          <div class="lk-card-top">
            <div class="lk-ring" style="--p:${pct};--c:var(--amber)"><span>${pct}%</span></div>
            <div class="lk-info">
              <div class="lk-nome">${h(l.nome)}${l.tipo==='veloce'?' <span class="tipo-badge-prov">veloce</span>':''}</div>
              <div class="lk-rotta">${h(rotta)}</div>
              <div class="lk-meta">${l.n_righe} ${l.n_righe===1?'articolo':'articoli'} · ${pr} / ${tot} pz</div>
            </div>
          </div>
          <button class="lk-btn lk-prep" onclick="event.stopPropagation();apriListaDaDash(${l.id})">Continua</button>
        </div>`;
      }).join('')
    : '<div class="lk-empty">nessuna lista in preparazione</div>';

  // Ultimi movimenti
  document.getElementById('dashStorico').innerHTML = D.spostamenti.slice(0,6).map(s=>{
    const a=getArt(s.art_id), da=getMag(s.mag_from), a2=getMag(s.mag_to);
    return `<div class="lk-card ds-mov" style="cursor:default">
      <div class="ds-mov-t">${codiceBadge(a?.codice, a ? getCat(a.cat_id)?.colore : null)}<span class="ds-ora">${fmtDt(s.data)}</span><b>×${s.qty}</b></div>
      <div class="ds-rotta">${da?h(da.nome):'—'} → ${a2?h(a2.nome):'—'}</div>
    </div>`;
  }).join('') || '<div class="lk-empty">nessun movimento</div>';
}
// Dashboard → apre direttamente la lista (apre prima il dettaglio, poi cambia pagina)
async function apriListaDaDash(id) {
  await apriLista(id);
  goTo('liste');
}

// ─── SPOSTAMENTO ───
function renderSpos() {
  // Mostra card trasferisci tutto solo se ci sono magazzini Tour
  const tourMags = D.magazzini.filter(m=>m.classe==='tour'&&!m.virtuale);
  const card = document.getElementById('cardTrasferisciTutto');
  if(card) card.style.display = tourMags.length ? '' : 'none';
  // Utenti normali: la pagina contiene solo Trasferisci tutto
  const soloTour = currentUser?.ruolo !== 'admin';
  document.getElementById('sposSub').textContent = soloTour ? 'Svuota un magazzino Tour' : 'Sposta merce tra magazzini';
  document.getElementById('sposVuoto').style.display = soloTour && !tourMags.length ? '' : 'none';
  // Popola select Tour
  const ttDa = document.getElementById('ttMagDa');
  const ttA  = document.getElementById('ttMagA');
  if(ttDa) {
    ttDa.innerHTML = '<option value="">— seleziona —</option>' +
      tourMags.map(m=>`<option value="${m.id}">${m.icona||'🏭'} ${h(m.nome)}</option>`).join('');
  }
  const allDest = getMagReali();
  if(ttA) {
    ttA.innerHTML = '<option value="">— seleziona —</option>' +
      allDest.map(m=>`<option value="${m.id}">${m.icona||'🏭'} ${h(m.nome)}</option>`).join('');
  }
  if(!soloTour) spInit();
}

// Spostamento multiplo (solo admin): stato della schermata
const SP = { src:0, dst:0, cat:'', q:'', sel:0, qty:0, cart:[], busy:false };
const spMags   = () => D.magazzini.filter(m => currentUser?.ruolo==='admin' || !m.virtuale);
const spAvail  = id => getStock(id, SP.src) || 0;
const spInCart = id => SP.cart.find(c => c.id === id);
const spPcs    = () => SP.cart.reduce((n,c) => n + c.qty, 0);
const spMagLbl = m => m.virtuale ? '🗑 Cestino' : (m.citta || '');
function spLista() {
  const q = SP.q.trim().toLowerCase();
  return D.articoli.filter(a => spAvail(a.id) > 0
    && (!SP.cat || a.cat_id == SP.cat)
    && (!q || `${a.codice} ${a.nome} ${a.variante||''}`.toLowerCase().includes(q)));
}
function spInit() {
  const mags = spMags();
  if(!mags.some(m => m.id === SP.src)) SP.src = (getMagReali()[0] || mags[0] || {}).id || 0;
  if(SP.dst === SP.src || !mags.some(m => m.id === SP.dst)) SP.dst = 0;
  // categorie
  const catSel = document.getElementById('spCat');
  catSel.innerHTML = '<option value="">Tutte</option>' +
    D.categorie.map(c => `<option value="${c.id}"${c.id==SP.cat?' selected':''}>[${h(c.prefisso)}] ${h(c.nome)}</option>`).join('');
  if(SP.cat && !D.categorie.some(c => c.id == SP.cat)) { SP.cat = ''; catSel.value = ''; }
  document.getElementById('spQ').value = SP.q;
  // sorgente
  document.getElementById('spSrc').innerHTML = mags.map(m =>
    `<option value="${m.id}"${m.id===SP.src?' selected':''}>${m.virtuale?'🗑 ':''}${h(m.nome)}</option>`).join('');
  // il carrello segue lo stock aggiornato
  SP.cart = SP.cart.filter(c => spAvail(c.id) > 0);
  SP.cart.forEach(c => { c.qty = Math.min(c.qty, spAvail(c.id)); });
  if(SP.sel && spAvail(SP.sel) <= 0) { SP.sel = 0; SP.qty = 0; }
  if(SP.sel) SP.qty = Math.max(1, Math.min(spAvail(SP.sel), SP.qty || 1));
  spRenderAll();
}
function spRenderAll() { spRenderDst(); spRenderList(); spRenderSel(); spRenderCart(); }
function spRenderDst() {
  const dstMags = spMags().filter(m => m.id !== SP.src);
  document.getElementById('spDst').classList.toggle('sel', !!SP.dst);
  document.getElementById('spDst').innerHTML = dstMags.length ? dstMags.map(m =>
    `<div class="sp-dc${m.id===SP.dst?' on':''}" style="--mc:${m.colore||'var(--border2)'}" onclick="spSetDst(${m.id})">
       <b>${h(m.nome)}</b><small>${h(spMagLbl(m))||'&nbsp;'}</small></div>`).join('')
    : '<div class="sp-empty">Nessun altro magazzino</div>';
  const d = getMag(SP.dst);
  document.getElementById('spDstName').textContent = d ? d.nome : 'scegli';
  spRenderBar();
}
function spRenderList() {
  const L = spLista();
  document.getElementById('spList').innerHTML = L.length ? L.map(a => {
    const c = spInCart(a.id);
    const cat = getCat(a.cat_id);
    return `<div class="sp-ar${a.id===SP.sel?' on':''}${c?' in':''}" onclick="spPick(${a.id})">
      ${codiceBadge(a.codice, cat?.colore)}
      <span class="sp-nm"><strong>${h(a.nome)}</strong>${a.variante?' · '+h(a.variante):''}</span><span class="sp-cp">${catPill(cat)}</span>
      ${c?`<span class="sp-tag">×${c.qty}</span>`:''}
      <span class="sp-av">${spAvail(a.id)}<small>disp.</small></span></div>`;
  }).join('') : '<div class="sp-empty">Nessun articolo disponibile con questi filtri</div>';
}
const SP_MINUS = '<svg viewBox="0 0 12 12"><path d="M2 6h8"/></svg>';
const SP_PLUS  = '<svg viewBox="0 0 12 12"><path d="M2 6h8M6 2v8"/></svg>';
function spRenderSel() {
  const a = SP.sel ? getArt(SP.sel) : null;
  const d = a ? spAvail(a.id) : 0, c = a ? spInCart(a.id) : null;
  const chips = a ? spMags().filter(m => getStock(a.id, m.id) > 0).map(m =>
    `<span class="stock-pill${m.id===SP.src?' sp-me':''}"><strong>${getStock(a.id, m.id)}</strong> ${m.virtuale?'🗑 ':''}${h(m.nome)}</span>`).join('') : '';
  document.getElementById('spSel').innerHTML = `<div class="sp-sel">
    <div class="sp-code">${a ? codiceBadge(a.codice, getCat(a.cat_id)?.colore)+' '+catPill(getCat(a.cat_id)) : '—'}</div>
    <div class="sp-name${a?'':' ph'}">${a ? h(a.nome)+(a.variante?' · '+h(a.variante):'') : 'Nessun articolo selezionato'}</div>
    <div class="sp-chips">${a ? chips : '<span class="sp-hint">Scegli un articolo dall\'elenco</span>'}</div>
    <label class="sp-lab">Quantità${a?` (max ${d}${a.um&&a.um!=='pz'?' '+h(a.um):''})`:''}</label>
    <div class="sp-qrow">
      <div class="sp-step${a?'':' off'}"><button type="button" aria-label="Meno" onclick="spAdj(-1)">${SP_MINUS}</button><input id="spQty" ${a?'':'disabled'} value="${a?SP.qty:''}" placeholder="0" inputmode="numeric" onchange="spSetQty(this.value)"><button type="button" aria-label="Più" onclick="spAdj(1)">${SP_PLUS}</button></div>
      <button class="btn btn-green btn-sm" ${a?'':'disabled'} onclick="spMax()">MAX</button>
      <button class="btn btn-primary btn-sm" ${a?'':'disabled'} onclick="spAdd()">${c?'Aggiorna':'＋ Aggiungi'}</button>
    </div></div>`;
}
function spRenderCart() {
  const n = SP.cart.length;
  document.getElementById('spCartCnt').textContent = n ? `${n} articol${n===1?'o':'i'} · ${spPcs()} pz` : '';
  document.getElementById('spCart').innerHTML = n ? `<div class="tbl-uni"><table class="sp-tbl"><thead><tr><th>Articolo</th><th>Disp.</th><th>Quantità</th><th></th></tr></thead><tbody>${
    SP.cart.map(c => { const a = getArt(c.id); return `<tr>
      <td>${codiceBadge(a.codice, getCat(a.cat_id)?.colore)} <strong>${h(a.nome)}</strong>${a.variante?' · '+h(a.variante):''}</td>
      <td class="sp-hint">${spAvail(c.id)}</td>
      <td><div class="sp-step"><button type="button" aria-label="Meno" onclick="spCq(${c.id},-1)">${SP_MINUS}</button><input value="${c.qty}" inputmode="numeric" onchange="spCset(${c.id},this.value)"><button type="button" aria-label="Più" onclick="spCq(${c.id},1)">${SP_PLUS}</button></div></td>
      <td><button type="button" class="sp-x" aria-label="Togli" onclick="spRm(${c.id})">✕</button></td></tr>`; }).join('')
  }</tbody></table></div>` : '<div class="sp-empty">Nessun articolo selezionato</div>';
  spRenderBar();
}
function spRenderBar() {
  const n = SP.cart.length, d = getMag(SP.dst);
  document.getElementById('spSum').innerHTML =
    (n ? `<b>${n}</b> articol${n===1?'o':'i'} · <b>${spPcs()}</b> pezzi` : 'Nessun articolo') +
    (d ? ` → <b>${h(d.nome)}</b>` : ' · scegli la destinazione');
  document.getElementById('spReg').disabled = !(n && d) || SP.busy;
}
function spSetSrc(v) {
  SP.src = +v; SP.q = ''; SP.cart = []; SP.sel = 0; SP.qty = 0;
  if(SP.dst === SP.src) SP.dst = 0;
  document.getElementById('spQ').value = '';
  spRenderAll();
}
function spSetCat(v) { SP.cat = v; SP.q = ''; document.getElementById('spQ').value = ''; spRenderList(); }
function spSetQ(v)   { SP.q = v; spRenderList(); }
function spSetDst(id){ SP.dst = id; spRenderDst(); }
function spPick(id) {
  SP.sel = id; const c = spInCart(id);
  SP.qty = c ? c.qty : 1;
  spRenderList(); spRenderSel();
}
function spClampQty(v) { return Math.max(1, Math.min(spAvail(SP.sel), parseInt(v) || 1)); }
function spAdj(d)      { if(!SP.sel) return; SP.qty = spClampQty(SP.qty + d); spRenderSel(); }
function spSetQty(v)   { if(!SP.sel) return; SP.qty = spClampQty(v); spRenderSel(); }
function spMax()       { if(!SP.sel) return; SP.qty = spAvail(SP.sel); spRenderSel(); }
function spAdd() {
  const id = SP.sel; if(!id) return;
  const q = spClampQty(SP.qty), c = spInCart(id);
  if(c) c.qty = q; else SP.cart.push({id, qty:q});
  SP.sel = 0; SP.qty = 0;
  spRenderList(); spRenderSel(); spRenderCart();
}
function spCset(id, v) {
  v = Math.max(0, Math.min(spAvail(id), parseInt(v) || 0));
  if(v === 0) SP.cart = SP.cart.filter(x => x.id !== id);
  else { const c = spInCart(id); if(c) c.qty = v; }
  spRenderList(); spRenderCart();
}
function spCq(id, d) { const c = spInCart(id); if(c) spCset(id, c.qty + d); }
function spRm(id)    { SP.cart = SP.cart.filter(x => x.id !== id); spRenderList(); spRenderCart(); }
async function spRegistra() {
  if(SP.busy) return;
  const mag_from = SP.src, mag_to = SP.dst;
  const note = document.getElementById('spNote').value.trim();
  if(!SP.cart.length)    { toast('Seleziona almeno un articolo', true); return; }
  if(!mag_to)            { toast('Seleziona il magazzino di destinazione', true); return; }
  if(mag_from === mag_to){ toast('I magazzini devono essere diversi', true); return; }
  SP.busy = true; spRenderBar();
  const fatte = [];
  let errore = null;
  try {
    for(const c of SP.cart) {
      try {
        await apiFetch('POST', '/spostamenti', {art_id:c.id, mag_from, mag_to, qty:c.qty, note, data:nowRoma()});
        fatte.push({art_id:c.id, qty:c.qty});
      } catch(e) { errore = e; break; }
    }
  } finally { SP.busy = false; }
  if(fatte.length) {
    SP.cart = SP.cart.filter(c => !fatte.some(f => f.art_id === c.id));
    // una sola voce di annullamento per l'intera operazione
    pushUndo({type:'spostamentoMulti', righe:fatte, mag_from, mag_to, note});
    playSpostamentoSound();
  }
  await loadPartial('spostamenti');
  if(errore) {
    toast(`${errore.message||'Errore imprevisto — riprova'}${fatte.length?` (registrati ${fatte.length} articoli, gli altri restano nell'elenco)`:''}`, true);
  } else {
    document.getElementById('spNote').value = '';
    SP.sel = 0; SP.qty = 0;
    toast(`Spostamento registrato ✓${fatte.length>1?` (${fatte.length} articoli)`:''}`);
  }
  spInit();
}

// ─── CARICA — stessa struttura di Spostamento: destinazione in alto, elenco articoli + scheda a destra, barra di conferma ───
const CA = { cat: '', q: '', solo: false, pending: null, noteFor: null, busy: false };
const ccSenzaStock = a => totalArtAny(a.id) === 0;
const ccPezziModello = m => D.articoli.filter(x => x.modello_id == m.id);
// voci dell'elenco: gli articoli con varianti (si caricano creando i pezzi) + gli articoli normali (e i pezzi rimasti senza stock)
function ccItems() {
  const q = CA.q.trim().toLowerCase(), out = [];
  const okCat = c => !CA.cat || c == CA.cat;
  const okQ = s => !q || s.toLowerCase().includes(q);
  for (const m of (D.modelli || [])) {
    if (!okCat(m.cat_id) || !okQ(`${m.codice || ''} ${m.nome}`)) continue;
    const pz = ccPezziModello(m), tot = pz.reduce((n, x) => n + totalArtAny(x.id), 0);
    if (CA.solo && pz.length) continue;
    out.push({ key: 'm' + m.id, mod: m, cat_id: m.cat_id, codice: m.codice || '—', nome: m.nome, tot, vuoto: !pz.length });
  }
  for (const a of D.articoli) {
    if (isSpecialArt(a.id) || !okCat(a.cat_id) || !okQ(`${a.codice} ${a.nome} ${a.variante || ''}`)) continue;
    const tot = totalArtAny(a.id);
    if (a.modello_id && tot > 0) continue;            // un pezzo con stock non si ricarica: si creano nuovi pezzi dal suo articolo
    if (CA.solo && tot > 0) continue;
    out.push({ key: String(a.id), art: a, cat_id: a.cat_id, codice: a.codice, nome: a.nome, variante: a.variante, tot, vuoto: tot === 0 });
  }
  return out;
}
function ccRenderList() {
  const L = ccItems(), sel = document.getElementById('cArticolo').value;
  document.getElementById('cList').innerHTML = L.length ? L.map(it => {
    const cat = getCat(it.cat_id);
    return `<div class="sp-ar${it.key === sel ? ' on' : ''}" data-key="${it.key}" onclick="ccPick('${it.key}')">
      ${codiceBadge(it.codice, cat?.colore)}
      <span class="sp-nm"><strong>${h(it.nome)}</strong>${it.mod ? ` <span class="var-chip">${it.mod.varianti.length} varianti</span>` : (it.variante ? ' · ' + h(it.variante) : '')}</span><span class="sp-cp">${catPill(cat)}</span>
      ${it.vuoto ? '<span class="cc-nos">senza stock</span>' : `<span class="sp-av">${it.tot}<small>${it.mod ? 'pezzi' : 'tot.'}</small></span>`}</div>`;
  }).join('') : `<div class="sp-empty">${CA.solo ? '✓ Nessun articolo senza stock con questi filtri' : 'Nessun articolo con questi filtri'}</div>`;
  const nSolo = (D.modelli || []).filter(m => !ccPezziModello(m).length).length + D.articoli.filter(a => !isSpecialArt(a.id) && !a.modello_id && ccSenzaStock(a)).length;
  document.getElementById('cSoloN').textContent = nSolo ? `(${nSolo})` : '';
}
function ccRenderDst() {
  const sel = +document.getElementById('cMag').value || 0;
  const box = document.getElementById('cMagList');
  box.classList.toggle('sel', !!sel);
  box.innerHTML = D.magazzini.map(m =>
    `<div class="sp-dc${m.id === sel ? ' on' : ''}" style="--mc:${m.colore || 'var(--border2)'}" onclick="selCaricoMag(${m.id})">
       <b>${m.virtuale ? '🗑 ' : ''}${h(m.nome)}</b><small>${h(spMagLbl(m)) || '&nbsp;'}</small></div>`).join('');
  const d = getMag(sel);
  document.getElementById('cMagSel').textContent = d ? d.nome : 'scegli';
}
function ccRenderSel() {
  const v = document.getElementById('cArticolo').value;
  const mod = cvModello(), a = mod ? null : (v ? getArt(+v) : null), it = mod || a;
  const head = document.getElementById('cSelHead'), body = document.getElementById('cSelBody');
  const dst = +document.getElementById('cMag').value || 0;
  if (!it) {
    head.innerHTML = `<div class="sp-code">—</div><div class="sp-name ph">Nessun articolo selezionato</div><div class="sp-chips"><span class="sp-hint">Scegli un articolo dall'elenco</span></div>`;
    body.style.display = 'none'; ccBar(); return;
  }
  body.style.display = '';
  const cat = getCat(it.cat_id);
  const pz = mod ? ccPezziModello(mod) : null;
  const chips = D.magazzini.map(m => {
    const n = mod ? pz.reduce((t, x) => t + getTot(x.id, m.id), 0) : getTot(a.id, m.id);
    return n > 0 ? `<span class="stock-pill${m.id === dst ? ' sp-me' : ''}"><strong>${n}</strong> ${m.virtuale ? '🗑 ' : ''}${h(m.nome)}</span>` : '';
  }).join('');
  head.innerHTML = `<div class="sp-code">${codiceBadge(mod ? (mod.codice || '—') : a.codice, cat?.colore)} ${catPill(cat)} <span>· ${mod ? 'pz' : h(a.um)}</span></div>
    <div class="sp-name">${h(it.nome)}${a?.variante ? ' · ' + h(a.variante) : ''}</div>
    <div class="sp-chips">${chips || '<span class="sp-chip">nessuno stock · primo carico</span>'}</div>`;
  document.getElementById('cUm').textContent = mod ? 'pezzi' : (a.um || '');
  if (CA.noteFor !== v) { document.getElementById('cNote').value = a?.note || ''; CA.noteFor = v; }
  cvRender();
}
function ccBar() {
  const reg = document.getElementById('cReg'); if (!reg) return;
  const v = document.getElementById('cArticolo').value, mod = cvModello(), a = mod ? null : (v ? getArt(+v) : null);
  const d = getMag(+document.getElementById('cMag').value);
  const q = mod ? cvSum() : (parseInt(document.getElementById('cQty').value) || 0);
  const okQ = mod ? (cvSum() === _cv.tot && cvSum() > 0) : q >= 1;
  document.getElementById('cSum').innerHTML =
    (mod || a ? `<b>${q}</b> ${mod ? (q === 1 ? 'pezzo' : 'pezzi') : h(a.um)} di <b>${h((mod || a).nome)}</b>` : 'Nessun articolo selezionato') +
    (d ? ` → <b>${h(d.nome)}</b>` : ' · scegli la destinazione');
  reg.disabled = !((mod || a) && d && okQ) || CA.busy;
}
function ccRenderAll() { ccRenderDst(); ccRenderList(); ccRenderSel(); }
function renderCaricaScarica() {
  const catSel = document.getElementById('cCategoria');
  if (CA.cat && !getCatNormali().some(c => c.id == CA.cat)) CA.cat = '';
  catSel.innerHTML = '<option value="">Tutte</option>' +
    getCatNormali().map(c => `<option value="${c.id}"${c.id == CA.cat ? ' selected' : ''}>[${h(c.prefisso)}] ${h(c.nome)}</option>`).join('');
  document.getElementById('cQ').value = CA.q;
  document.getElementById('cSolo').checked = CA.solo;
  document.getElementById('cSoloLbl').classList.toggle('on', CA.solo);
  const art = document.getElementById('cArticolo');
  if (CA.pending) { art.value = CA.pending; CA.pending = null; CA.noteFor = null; document.getElementById('cQty').value = 1; _cv = { tot: 1, q: {}, mid: cvModello()?.id }; CA.scroll = true; }
  else if (art.value && !(cvModello() || getArt(+art.value))) { art.value = ''; CA.noteFor = null; }
  if (!getMag(+document.getElementById('cMag').value)) document.getElementById('cMag').value = '';
  ccRenderAll();
  if (CA.scroll) { CA.scroll = false; document.querySelector('#cList .sp-ar.on')?.scrollIntoView({ block: 'nearest' }); }
}
function onCaricoCategoriaChange() { CA.cat = document.getElementById('cCategoria').value; ccRenderList(); }
function ccSetQ(v) { CA.q = v; ccRenderList(); }
function ccSetSolo(on) { CA.solo = !!on; document.getElementById('cSoloLbl').classList.toggle('on', CA.solo); ccRenderList(); }
function ccPick(key) {
  document.getElementById('cArticolo').value = key;
  onCaricoChange();
  const card = document.getElementById('cSelHead')?.closest('.card'), w = document.getElementById('ccCarica');
  if (card && w && w.clientWidth < 900) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });   // schermi stretti: la scheda sta sotto l'elenco
}
function onCaricoChange() {     // cambia l'articolo selezionato
  CA.noteFor = null;
  document.getElementById('cQty').value = 1;
  if (cvModello()?.id !== _cv.mid) { _cv = { tot: 1, q: {}, mid: cvModello()?.id }; }
  ccRenderList(); ccRenderDst(); ccRenderSel();
}
const ccClampQty = v => Math.max(1, Math.min(QTY_MAX_UI, parseInt(v) || 1));
const QTY_MAX_UI = 1000000;
function ccAdj(d) { const el = document.getElementById('cQty'); el.value = ccClampQty((parseInt(el.value) || 1) + d); ccBar(); }
function ccSetQty(v) { document.getElementById('cQty').value = ccClampQty(v); ccBar(); }
function selCaricoMag(magId) {
  document.getElementById('cMag').value = magId;
  ccRenderDst(); ccRenderSel();
}
// Apre Carica con l'articolo (o l'articolo con varianti 'm<id>') già selezionato
async function ccGoTo(key) {
  CA.cat = ''; CA.q = ''; CA.solo = false; CA.pending = key;
  await goTo('caricoscarico');
}
async function salvaCaricoModello(m) {
  const mag_id = +document.getElementById('cMag').value;
  if (!mag_id) { toast('Seleziona il magazzino destinazione', true); return; }
  const righe = m.varianti.filter(v => _cv.q[v] > 0).map(v => ({ variante: v, qty: _cv.q[v] }));
  if (cvSum() !== _cv.tot || !righe.length) { toast('Assegna tutti i pezzi a una variante', true); return; }
  CA.busy = true; ccBar();
  try {
    const r = await apiFetch('POST', `/modelli/${m.id}/carica`, { mag_id, righe, note: '' });
    document.getElementById('cMag').value = '';
    _cv = { tot: 1, q: {}, mid: m.id };
    await loadPartial('articoli');
    CA.busy = false; ccRenderAll();
    toast(`${r.pezzi.length} ${r.pezzi.length === 1 ? 'pezzo caricato' : 'pezzi caricati'} ✓`);
  } catch (e) { toast(e.message || 'Errore imprevisto — riprova', true); }
  finally { CA.busy = false; ccBar(); }
}
async function salvaCarico() {
  if (CA.busy) return;
  const mCar = cvModello();
  if (mCar) return salvaCaricoModello(mCar);
  const art_id = +document.getElementById('cArticolo').value;
  const mag_id = +document.getElementById('cMag').value;
  const qty    = Number(document.getElementById('cQty').value);
  const note   = document.getElementById('cNote').value.trim();
  if (!art_id)  { toast('Seleziona un articolo',true); return; }
  if (!mag_id)  { toast('Seleziona il magazzino destinazione',true); return; }
  if (!Number.isInteger(qty) || qty<1) { toast('Inserisci una quantità valida',true); return; }
  CA.busy = true; ccBar();
  try {
    // Aggiorna nota sull'articolo se modificata
    const a = getArt(art_id);
    if (a && note !== (a.note||'').trim()) {
      await apiFetch('PUT',`/articoli/${art_id}`,{...a, note});
    }
    await apiFetch('POST','/stock/carica',{art_id, mag_id, qty, note:''});
    document.getElementById('cQty').value = 1;
    document.getElementById('cMag').value='';
    await loadPartial('stock');
    if (a && note !== (a.note||'').trim()) await loadPartial('articoli');
    CA.busy = false; CA.noteFor = null; ccRenderAll();
    pushUndo({type:'carico',art_id,mag_id,qty});
    toast('Carico registrato ✓');
  } catch(e) { toast(e.message||'Errore imprevisto — riprova', true); }
  finally { CA.busy = false; ccBar(); }
}
// compatibilità con i vecchi punti d'ingresso
function caricaModello(mid) { return ccGoTo('m' + mid); }
function selArtDaNoStock(artId) { return ccGoTo(String(artId)); }

// ─── CREA — stessa struttura di Spostamento: categoria in alto, dati a sinistra, anteprima a destra, barra di conferma ───
const CR = { edited: false, tok: 0, busy: false, hl: 0 };
const crVarianti = () => document.getElementById('naArtVarList').value.split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
function crRenderCats() {
  const cur = document.getElementById('naArtCat').value;
  document.getElementById('naArtCats').innerHTML = getCatNormali().map(c =>
    `<div class="cc-cat${c.id == cur ? ' on' : ''}" style="--mc:${c.colore || 'var(--border2)'}" onclick="crSetCat(${c.id})"><b>${h(c.nome)}</b><small>${h(c.prefisso)}</small></div>`).join('')
    || '<div class="sp-empty">Nessuna categoria: creane una dalla sezione Categorie</div>';
}
async function crSetCat(id) {
  document.getElementById('naArtCat').value = id;
  CR.edited = false;
  crRenderCats();
  await onNaArtCatChange();
}
async function onNaArtCatChange() {
  const catId = document.getElementById('naArtCat').value;
  const cod = document.getElementById('naArtCodice'), hint = document.getElementById('naArtCodiceHint'), top = document.getElementById('crCatHint');
  if (!catId) { cod.value = ''; hint.textContent = 'Seleziona prima la categoria'; top.textContent = 'scegli la categoria'; crPrev(); return; }
  const tok = ++CR.tok;
  try {
    const res = await apiFetch('GET',`/articoli/prossimo-codice/${catId}`);
    if (tok !== CR.tok) return;
    top.textContent = `codice automatico ${res.codice}`;
    if (!CR.edited || !cod.value.trim()) { cod.value = res.codice; CR.edited = false; hint.textContent = 'automatico (modificabile)'; }
  } catch(e) {}
  crPrev();
}
function crCodeEdit(el) {
  el.value = el.value.toUpperCase();
  CR.edited = true;
  document.getElementById('naArtCodiceHint').textContent = 'personalizzato';
  crPrev();
}
function crCodiceEsiste(cod) { return !!cod && (D.articoli.some(a => a.codice === cod) || (D.modelli || []).some(m => m.codice === cod)); }
function crPrev() {
  const g = id => document.getElementById(id);
  if (!g('crPrev')) return;
  const cat = getCat(+g('naArtCat').value) || null, nome = g('naArtNome').value.trim(), code = g('naArtCodice').value.trim().toUpperCase();
  const um = g('naArtUm').value, varOn = g('naArtVarOn').checked, vs = varOn ? crVarianti() : [];
  const dup = !varOn && crCodiceEsiste(code);
  const badge = code ? codiceBadge(code, cat?.colore) : '<span class="badge-codice">—</span>';
  g('crPrev').innerHTML = `<div class="cc-pre">${badge}<div style="min-width:0"><div class="sp-name${nome ? '' : ' ph'}" style="margin:0 0 6px">${nome ? h(nome) : "Nome dell'articolo"}</div>
      <div class="cc-pills">${cat ? catPill(cat) : '<span class="cc-pill">categoria?</span>'}<span class="cc-pill">${varOn ? 'pz' : h(um)}</span>${varOn ? '<span class="cc-pill">pezzi univoci</span>' : ''}</div></div></div>
    ${vs.length ? `<div class="sp-chips" style="margin:12px 0 0">${vs.map(v => `<span class="sp-chip">${h(v)}</span>`).join('')}</div>
      <div class="sp-hint" style="margin-top:8px;line-height:1.5">I pezzi nascono al carico, con codici ${h(code || 'COD')}-1, ${h(code || 'COD')}-2…</div>` : ''}
    <div class="sp-hint" style="margin-top:12px;line-height:1.5">${dup ? '<span style="color:var(--red)">Codice già esistente</span>' : 'Appena creato resta senza stock finché non lo carichi in un magazzino.'}</div>`;
  const ok = !!cat && !!nome && (varOn ? vs.length > 0 : (!!code && !dup));
  g('crSum').innerHTML = nome ? `<b>${h(varOn ? (code || '—') : code || '—')}</b> · ${h(nome)} <span class="sp-hint">— ${cat ? h(cat.nome) : 'categoria?'} · ${varOn ? 'pz, con varianti' : h(um)}</span>` : 'Compila categoria, codice e nome';
  g('crBtn').disabled = !ok || CR.busy; g('crBtnCarica').disabled = !ok || CR.busy;
}
function crReset() {
  ['naArtNome', 'naArtNote', 'naArtVarList'].forEach(id => document.getElementById(id).value = '');
  const c = document.getElementById('naArtVarOn'); c.checked = false; onVarToggle('naArt');
  CR.edited = false;
}
function renderCrea() {
  const catEl = document.getElementById('naArtCat');
  if (catEl.value && !getCatNormali().some(c => c.id == catEl.value)) { catEl.value = ''; document.getElementById('naArtCodice').value = ''; }
  crRenderCats();
  onVarToggle('naArt');
  renderCreaNoStock();
  if (catEl.value) onNaArtCatChange(); else { document.getElementById('crCatHint').textContent = 'scegli la categoria'; crPrev(); }
}
function renderCreaNoStock() {
  const box = document.getElementById('tbStockNoMag'); if (!box) return;
  const noMag = D.articoli.filter(a => totalArtAny(a.id) === 0);
  const noMod = modelliSenzaPezzi();
  const n = noMag.length + noMod.length;
  const badge = document.getElementById('stockNoMagBadge');
  if (badge) badge.textContent = n ? `${n} da caricare` : '';
  const rowBtns = (key, mid, aid) => `<span class="cc-acts">${isSpecialArt(aid) ? '' : `<button class="btn btn-ghost btn-xs cc-go" onclick="ccGoTo('${key}')">Carica →</button>`}${
    mid ? `<button class="btn btn-ghost btn-xs" onclick="modificaVarianti(${mid})">Varianti</button><button class="btn btn-danger btn-xs" onclick="eliminaModello(${mid})">Elimina</button>`
        : `<button class="btn btn-ghost btn-xs" onclick="editArt(${aid})">Modifica</button><button class="btn btn-danger btn-xs" onclick="delArtNoStock(${aid})">Elimina</button>`}</span>`;
  box.innerHTML = n ? noMod.map(m => { const cat = getCat(m.cat_id);
      return `<div class="sp-ar cc-nr${CR.hl === 'm' + m.id ? ' hl' : ''}">${codiceBadge(m.codice || '—', cat?.colore)}
        <span class="sp-nm"><strong>${h(m.nome)}</strong> <span class="var-chip">${m.varianti.map(h).join(' · ')}</span>${m.note ? `<span class="sp-ct">${h(m.note)}</span>` : ''}</span><span class="sp-cp">${catPill(cat)}</span>${rowBtns('m' + m.id, m.id)}</div>`; }).join('')
    + noMag.map(a => { const cat = getCat(a.cat_id);
      return `<div class="sp-ar cc-nr${CR.hl === a.id ? ' hl' : ''}">${codiceBadge(a.codice, cat?.colore)}
        <span class="sp-nm"><strong>${h(a.nome)}</strong>${varChip(a)}<span class="sp-ct">${h(a.um)}${a.note ? ' · ' + h(a.note) : ''}</span></span><span class="sp-cp">${catPill(cat)}</span>${rowBtns(String(a.id), 0, a.id)}</div>`; }).join('')
    : '<div class="sp-empty">✓ Tutti gli articoli hanno uno stock assegnato</div>';
}
async function salvaArticoloDaCarico(andLoad) {
  if (CR.busy) return;
  const g = id => document.getElementById(id);
  const varOn = g('naArtVarOn').checked;
  const cat_id = +g('naArtCat').value || null;
  const codice = g('naArtCodice').value.trim().toUpperCase();
  const nome   = g('naArtNome').value.trim();
  const um     = g('naArtUm').value;
  const note   = g('naArtNote').value.trim();
  if (!varOn) {
    if (!cat_id) { toast('Categoria obbligatoria',true); return; }
    if (!codice) { toast('Codice obbligatorio',true); return; }
    if (!nome)   { toast('Nome obbligatorio',true); return; }
  }
  CR.busy = true; crPrev();
  try {
    let key, hl;
    if (varOn) {
      const r = await creaModelloDa('naArt');
      if (!r) return;
      key = 'm' + r.id; hl = key;
    } else {
      const r = await apiFetch('POST','/articoli',{codice,nome,cat_id,um,note});
      key = String(r.id); hl = Number(r.id);
    }
    crReset();
    await loadPartial('articoli');
    CR.hl = hl;
    toast(varOn ? 'Articolo con varianti creato ✓ — i pezzi si creano al carico' : `Articolo "${nome}" creato ✓`);
    if (andLoad) { CR.busy = false; await ccGoTo(key); return; }
    renderCrea();
    document.querySelector('#tbStockNoMag .hl')?.scrollIntoView({ block: 'nearest' });
  } catch(e) {}
  finally { CR.busy = false; crPrev(); }
}

// Elimina articolo direttamente dalla lista (solo se stock totale = 0 in magazzini reali)
async function delArtDirect(id) {
  const a = getArt(id);
  const dove = D.stock.filter(s => s.art_id==id && s.qty>0).map(s => s.qty + ' in ' + (getMag(s.mag_id)?.nome || '?')).join(', ');
  const msg = dove ? `Eliminare definitivamente "${a?.nome}"?

È presente in: ${dove}.
Verrà tolto da tutti i magazzini. Operazione irreversibile.`
                   : `Eliminare definitivamente "${a?.nome}"?
Questa operazione è irreversibile.`;
  if (!await askConfirm(msg, { ok: 'Elimina', danger: true })) return;
  try {
    await apiFetch('DELETE', `/articoli/${id}`);
    await loadPartial('articoli'); renderArticoli();
    toast(`"${a?.nome}" eliminato ✓`);
  } catch(e) {}
}

// toglie un articolo da un solo magazzino (scarica tutta la quantità): resta in Articoli > senza stock
async function togliDaMagazzino(artId, magId) {
  const a = getArt(artId), m = getMag(magId), q = getStock(artId, magId);
  if (!q) return;
  if (!await askConfirm(`Togliere ${q} ${a?.um||'pz'} di "${a?.nome}" da "${m?.nome}"?

L'articolo resta nel database: se non ha stock altrove lo trovi in Articoli > senza stock, dove puoi eliminarlo.`, { ok: 'Togli', danger: true })) return;
  try {
    await apiFetch('POST', '/stock/scarica', { art_id: artId, mag_id: magId, qty: q, note: 'Rimosso dal magazzino' });
    await loadPartial('stock'); renderMagDetailTable(); renderPage(curPage);
    toast(`"${a?.nome}" tolto da "${m?.nome}" ✓`);
  } catch(e) {}
}

// ─── TRASFERISCI TUTTO (Tour) ───
function onTTMagDaChange() {
  const magId = +document.getElementById('ttMagDa').value;
  const ttA = document.getElementById('ttMagA');
  // Rimuovi magazzino DA dalla lista A
  Array.from(ttA.options).forEach(o => o.style.display = (+o.value === magId) ? 'none' : '');
  ttA.value = '';
  document.getElementById('ttPreview').textContent = '';
  if(!magId) return;
  const righe = D.stock.filter(s=>s.mag_id===magId&&s.qty>0);
  const tot = righe.reduce((n,s)=>n+s.qty,0);
  document.getElementById('ttPreview').textContent =
    righe.length ? `${righe.length} tipo/i · ${tot} pezzi totali da spostare` : 'Magazzino vuoto';
}
async function salvaTrasferisciTutto() {
  const magDaId = +document.getElementById('ttMagDa').value;
  const magAId  = +document.getElementById('ttMagA').value;
  if(!magDaId) { toast('Seleziona il magazzino Tour di partenza',true); return; }
  if(!magAId)  { toast('Seleziona il magazzino destinazione',true); return; }
  if(magDaId===magAId) { toast('I magazzini devono essere diversi',true); return; }
  const righe = D.stock.filter(s=>s.mag_id===magDaId&&s.qty>0);
  if(!righe.length) { toast('Il magazzino è già vuoto',true); return; }
  const magDa = getMag(magDaId), magA = getMag(magAId);
  if(!await askConfirm(`Trasferire tutto il contenuto di "${magDa.nome}" in "${magA.nome}"?
${righe.length} tipo/i, ${righe.reduce((n,s)=>n+s.qty,0)} pezzi totali`, { ok: 'Trasferisci' })) return;
  try {
    await apiFetch('POST','/spostamenti/batch',{
      spostamenti: righe.map(s=>({art_id:s.art_id,mag_from:magDaId,mag_to:magAId,qty:s.qty})),
      nota_batch: `Trasferimento tour: ${h(magDa.nome)} → ${h(magA.nome)}`
    });
    await loadPartial('spostamenti'); renderSpos();
    playSpostamentoSound();
    toast(`Trasferimento completato ✓`);
    pushUndo({type:'trasferimentoTour', magDaId, magAId, righe:[...righe], data:nowRoma()});
  } catch(e){ toast(e.message||'Errore', true); }
}

// ─── UNDO (max 5 azioni) ───
const undoStack = [];
function pushUndo(action) {
  undoStack.push(action);
  if(undoStack.length > 5) undoStack.shift();
  updateUndoBtn();
}
let _undoTimer = null;
function updateUndoBtn() {
  const btn = document.getElementById('undoBtn');
  if(!btn) return;
  if(_undoTimer) { clearTimeout(_undoTimer); _undoTimer = null; }
  if(undoStack.length) {
    btn.style.display = 'flex';
    btn.title = `Annulla: ${undoLabelOf(undoStack[undoStack.length-1])} (${undoStack.length}/5)`;
    _undoTimer = setTimeout(() => { btn.style.display = 'none'; }, 5000);
  } else {
    btn.style.display = 'none';
  }
}
function undoLabelOf(a) {
  if(a.type==='spostamento') return `spostamento ${getArt(a.art_id)?.nome||''}`;
  if(a.type==='spostamentoMulti') return a.righe.length===1 ? `spostamento ${getArt(a.righe[0].art_id)?.nome||''}` : `spostamento di ${a.righe.length} articoli`;
  if(a.type==='carico')      return `carico ${getArt(a.art_id)?.nome||''}`;
  if(a.type==='scarico')     return `scarico ${getArt(a.art_id)?.nome||''}`;
  if(a.type==='svuotaMag')   return `svuota ${getMag(a.magId)?.nome||''}`;
  if(a.type==='trasferimentoTour') return `trasferimento tour`;
  return 'azione';
}
async function undoLast() {
  if(!undoStack.length) return;
  const a = undoStack.pop();
  updateUndoBtn();
  try {
    if(a.type==='spostamento') {
      // inverti: sposta qty da mag_to a mag_from
      await apiFetch('POST','/spostamenti',{art_id:a.art_id,mag_from:a.mag_to,mag_to:a.mag_from,qty:a.qty,note:`[ANNULLATO] ${h(a.note)||''}`,data:nowRoma()});
    } else if(a.type==='spostamentoMulti') {
      // un solo annullamento inverte tutti gli articoli dell'operazione
      const data = nowRoma();
      for(const r of a.righe) {
        await apiFetch('POST','/spostamenti',{art_id:r.art_id,mag_from:a.mag_to,mag_to:a.mag_from,qty:r.qty,note:`[ANNULLATO] ${a.note||''}`.trim(),data});
      }
    } else if(a.type==='carico') {
      await apiFetch('POST','/stock/scarica',{art_id:a.art_id,mag_id:a.mag_id,qty:a.qty,note:`[ANNULLATO] carico`,data:nowRoma()});
    } else if(a.type==='svuotaMag'||a.type==='trasferimentoTour') {
      for(const s of a.righe) {
        const from = a.type==='svuotaMag' ? a.magVirtId : a.magAId;
        const to   = a.type==='svuotaMag' ? a.magId     : a.magDaId;
        await apiFetch('POST','/spostamenti',{art_id:s.art_id,mag_from:from,mag_to:to,qty:s.qty,note:`[ANNULLATO]`,data:nowRoma()});
      }
    }
    await loadPartial('spostamenti'); renderPage(curPage);
    toast('Azione annullata ✓');
  } catch(e){ toast('Impossibile annullare questa azione',true); }
}

// ─── MAGAZZINI ───

function renderMag() {
  const grid = document.getElementById('magGrid');
  const cnt = document.getElementById('magCounters');
  if (!D.magazzini.length) { if (cnt) cnt.innerHTML = ''; grid.innerHTML='<div class="lk-empty">Nessun magazzino</div>'; return; }
  const magReali = getMagReali();
  const stabili  = magReali.filter(m => m.classe !== 'tour');
  const tour     = magReali.filter(m => m.classe === 'tour');
  const isAdmin  = currentUser?.ruolo === 'admin';
  const totPezzi = magReali.reduce((n, m) => n + totalMag(m.id), 0);
  if (cnt) cnt.innerHTML = `
    <div class="lk-count"><b>${magReali.length}</b><span>magazzini</span></div>
    <div class="lk-count"><b>${stabili.length}</b><span>stabili</span></div>
    <div class="lk-count"><b>${tour.length}</b><span>tour</span></div>
    <div class="lk-count"><b>${totPezzi.toLocaleString('it-IT')}</b><span>pezzi</span></div>`;

  const cardHtml = m => {
    const tot   = totalMag(m.id);
    const nTipi = Object.values(D._stockMap||{}).filter(mm=>(mm[m.id]||0)>0).length;
    const colore = m.colore || 'var(--border2)';
    const adminFoot = isAdmin ? `
        ${m.classe==='tour'?`<button class="mg-ico mg-svuota" title="Svuota" onclick="event.stopPropagation();svuotaMag(${m.id})">svuota</button>`:''}
        <button class="mg-ico" title="Modifica" aria-label="Modifica magazzino" onclick="event.stopPropagation();editMag(${m.id})">✎</button>
        <button class="mg-ico mg-del" title="Elimina" aria-label="Elimina magazzino" onclick="event.stopPropagation();delMag(${m.id})">✕</button>` : '';
    return `<div class="lk-card mg-card" style="--mc:${colore}" onclick="openMagDetail(${m.id})">
      <div class="mg-top">
        <div class="ds-tile">${m.icona||'🏭'}</div>
        <div class="lk-info"><div class="mg-name">${h(m.nome)}</div><div class="lk-meta">${h(m.citta)||'—'} · ${nTipi} tipi</div></div>
        <div class="ds-num mg-pz"><b>${tot.toLocaleString('it-IT')}</b><span>pezzi</span></div>
      </div>
      <div class="mg-foot"><span class="mg-open">Apri ›</span>${adminFoot}</div>
    </div>`;
  };
  const col = (titolo, dot, items) => `<div class="lk-col"><div class="lk-col-h"><i style="background:${dot}"></i>${titolo}<span>${items.length}</span></div>${items.map(cardHtml).join('') || '<div class="lk-empty">nessun magazzino</div>'}</div>`;
  grid.innerHTML = col('Stabili', 'var(--ink3)', stabili) + col('Tour', 'var(--teal)', tour);
}
let _detailMagId = null;
function openMagDetail(magId) {
  _detailMagId = magId;
  document.getElementById('filterCatDetail').value = '';
  renderMagDetailTable();
  openModal('modalMagDetail');
}
// ⓘ: compare solo se l'articolo ha una nota; apre una finestra con la sola nota
function noteBtn(artId) {
  const n = (getArt(artId)?.note || '').trim();
  return n ? `<button class="note-btn" title="Mostra nota" aria-label="Mostra nota" onclick="event.stopPropagation();showNote(${artId})">ⓘ</button>` : '';
}
function showNote(artId) {
  const a = getArt(artId); if (!a || !(a.note || '').trim()) return;
  document.getElementById('noteTitle').textContent = a.nome;
  document.getElementById('noteBody').textContent = a.note.trim();
  openModal('modalNote');
}

// ─── PEZZI UNIVOCI CON VARIANTI ───
const _openGrp = new Set();      // gruppi aperti (sopravvivono ai ridisegni)
const getModello = id => (D.modelli || []).find(m => m.id == id);
const varChip = a => (a && a.modello_id && a.variante) ? ` <span class="var-chip">${h(a.variante)}</span>` : '';
function varSummary(pezzi) {
  const c = {};
  pezzi.forEach(a => { const v = a.variante || '—'; c[v] = (c[v] || 0) + 1; });
  return Object.entries(c).map(([v, n]) => `<span class="var-chip">${h(v)} ×${n}</span>`).join(' ');
}
function varSelect(a) {
  const m = getModello(a.modello_id);
  const vs = m ? m.varianti : [a.variante];
  return `<select class="var-sel" onclick="event.stopPropagation()" onchange="cambiaVariante(${a.id}, this)">` +
    vs.map(v => `<option${v === a.variante ? ' selected' : ''}>${h(v)}</option>`).join('') + `</select>`;
}
function modelloDi(a) {
  return getModello(a.modello_id) || { id: a.modello_id, nome: a.nome.replace(/ #\d+$/, ''), cat_id: a.cat_id, note: a.note || '', varianti: [] };
}
function raggruppaPezzi(list) {            // lista di articoli → un elemento per modello
  const seen = new Map(), out = [];
  for (const a of list) {
    if (!a.modello_id) { out.push(a); continue; }
    let g = seen.get(a.modello_id);
    if (!g) { g = { g: true, id: 'g' + a.modello_id, modello: modelloDi(a), pezzi: [] }; seen.set(a.modello_id, g); out.push(g); }
    g.pezzi.push(a);
  }
  return out;
}
function stockPills(mags) {                // pill per magazzino con quantità
  return `<div class="stock-inline">${mags.map(x => `<span class="stock-pill"><strong>${x.qty}</strong> ${h(x.m.nome)}</span>`).join('')}</div>`;
}
function raggruppaPezziStock(items) {      // items {a,mags,qty} → un elemento per modello (pezzi dello stesso modello insieme)
  const seen = new Map(), out = [];
  for (const it of items) {
    if (!it.a.modello_id) { out.push(it); continue; }
    let g = seen.get(it.a.modello_id);
    if (!g) { g = { g: true, modello: modelloDi(it.a), pezzi: [], items: [], mags: [], qty: 0 }; seen.set(it.a.modello_id, g); out.push(g); }
    g.pezzi.push(it.a); g.items.push(it); g.qty += it.qty;
    for (const x of it.mags) {
      const e = g.mags.find(y => y.m.id === x.m.id);
      if (e) e.qty += x.qty; else g.mags.push({ m: x.m, qty: x.qty });
    }
  }
  return out;
}
function raggruppaPezziMag(righe) {        // righe stock di un magazzino → gruppi
  const seen = new Map(), out = [];
  for (const s of righe) {
    const a = getArt(s.art_id);
    if (!a || !a.modello_id) { out.push(s); continue; }
    let g = seen.get(a.modello_id);
    if (!g) { g = { g: true, modello: modelloDi(a), pezzi: [], qty: 0 }; seen.set(a.modello_id, g); out.push(g); }
    g.pezzi.push(a); g.qty += s.qty;
  }
  return out;
}
function dovePezzo(a) {
  const dove = D.magazzini.filter(m => getTot(a.id, m.id) > 0).map(m => { const c = D._contMap?.[a.id]?.[m.id]; return h(m.nome) + (m.virtuale ? ' 🗑' : '') + (c ? ` (in ${h(c.case[0].nome)})` : ''); });
  return dove.length ? dove.join(', ') : '<span style="color:var(--ink3)">senza magazzino</span>';
}
function toggleGrp(el, key) {
  const exp = el.nextElementSibling;
  if (!exp) return;
  const open = !exp.classList.contains('open');
  exp.classList.toggle('open', open);
  if (open) _openGrp.add(key); else _openGrp.delete(key);
  const arr = el.querySelector('.mag-bau-arrow, .batch-arrow, .art-expand-btn');
  if (arr && arr.classList.contains('art-expand-btn')) arr.textContent = open ? '▲' : '▼';
  else if (arr) arr.style.transform = open ? 'rotate(90deg)' : '';
}
function artGruppoRows(g) {
  const m = g.modello, cat = getCat(m.cat_id), isAdmin = currentUser?.ruolo === 'admin';
  const key = 'art:' + m.id, open = _openGrp.has(key);
  const pills = D.magazzini.filter(x => !x.virtuale).map(x => {
    const n = g.pezzi.reduce((s, a) => s + getTot(a.id, x.id), 0);
    return n ? `<span class="stock-pill"><strong>${n}</strong> ${h(x.nome)}</span>` : '';
  }).join('');
  const mv = getMagVirt();
  const nv = mv ? g.pezzi.reduce((s, a) => s + getTot(a.id, mv.id), 0) : 0;
  const virt = isAdmin && nv > 0 ? `<span class="stock-pill" style="background:var(--teal-bg);border-color:var(--teal-border);color:var(--virt-text)"><strong>${nv}</strong> cestino</span>` : '';
  const tot = g.pezzi.reduce((s, a) => s + totalArtReale(a.id), 0);
  const pezzi = g.pezzi.map(a => `<tr>
      <td style="width:70px">${codiceBadge(a.codice, getCat(a.cat_id)?.colore)}</td>
      <td><strong>${h(a.nome)}</strong></td>
      <td>${varSelect(a)}</td>
      <td style="font-size:12px">${dovePezzo(a)}</td>
      <td style="text-align:right;white-space:nowrap">${isAdmin ? `<button class="btn btn-orange btn-xs" onclick="event.stopPropagation();mandaANonAssegnati(${a.id})">→ Cestino</button> <button class="btn btn-danger btn-xs" onclick="event.stopPropagation();delArtDirect(${a.id})" title="Elimina">🗑</button>` : ''}</td>
    </tr>`).join('');
  return `<tr onclick="toggleGrp(this,'${key}')" style="cursor:pointer">
      <td class="c-exp" style="padding:4px 2px 4px 10px"><button class="art-expand-btn" onclick="event.stopPropagation();toggleGrp(this.closest('tr'),'${key}')" title="Vedi pezzi">${open ? '▲' : '▼'}</button></td>
      <td>${codiceBadge(g.pezzi[0].codice, cat?.colore)}</td>
      <td class="name"><strong>${h(m.nome)}</strong>${catPill(cat)} <span class="var-chip var-chip-n">×${g.pezzi.length}</span> ${varSummary(g.pezzi)}${m.note?`<span class="nm-note">${h(m.note)}</span>`:''}</td>
      <td><span class="q-n">${tot}</span><span class="q-u">pz</span></td>
      <td class="col-depositi"><div class="stock-inline">${(pills + virt) || '<span style="font-size:11px;color:var(--ink3)">—</span>'}</div></td>
      <td class="act">${isAdmin ? `<button class="btn btn-ghost btn-xs ib" onclick="event.stopPropagation();modificaVarianti(${m.id})" title="Varianti">⚙</button><button class="btn btn-teal btn-xs ib" onclick="event.stopPropagation();caricaModello(${m.id})" title="Carica pezzi">↓</button>` : ''}</td>
    </tr>
    <tr class="art-expand-row${open ? ' open' : ''}"><td colspan="6" class="art-expand-cell"><table class="pezzi-tab"><tbody>${pezzi}</tbody></table></td></tr>`;
}
function stockGruppoRow(r) {
  const m = r.modello, cat = getCat(m.cat_id), key = 'stk:' + m.id, open = _openGrp.has(key);
  const nCase = r.items.reduce((n, it) => n + it.mags.reduce((k, x) => k + caseTot(x.cs), 0), 0);
  const pezzi = r.items.map(it => `<tr><td style="width:70px">${codiceBadge(it.a.codice, getCat(it.a.cat_id)?.colore)}</td><td><strong>${h(it.a.nome)}</strong></td><td>${varSelect(it.a)}</td><td>${stockPills(it.mags)}</td></tr>`).join('');
  return `<tr onclick="toggleGrp(this,'${key}')" style="cursor:pointer">
      <td>${codiceBadge(r.pezzi[0].codice, cat?.colore)}</td>
      <td class="name"><strong>${h(m.nome)}</strong>${catPill(cat)} <span class="var-chip var-chip-n">×${r.pezzi.length}</span> ${varSummary(r.pezzi)}${nCase ? ` <span class="var-chip">${nCase} nei case</span>` : ''}${m.note?`<span class="nm-note">${h(m.note)}</span>`:''}</td>
      <td>${stockPills(r.mags)}</td>
      <td class="r"><span class="q-n">${r.qty}</span><span class="q-u">pz</span></td>
    </tr><tr class="art-expand-row${open ? ' open' : ''}"><td colspan="4" class="art-expand-cell"><table class="pezzi-tab"><tbody>${pezzi}</tbody></table></td></tr>`;
}
function magGruppoRows(g) {
  const m = g.modello, cat = getCat(m.cat_id), key = 'mag:' + m.id, open = _openGrp.has(key);
  const pezzi = g.pezzi.map(a => `<tr>
      <td style="width:70px">${codiceBadge(a.codice, getCat(a.cat_id)?.colore)}</td>
      <td><strong>${h(a.nome)}</strong>${getStock(a.id, _detailMagId) > 0 ? '' : ` <span class="var-chip">in ${h(D._contMap?.[a.id]?.[_detailMagId]?.case[0]?.nome || 'case')}</span>`}</td>
      <td>${varSelect(a)}</td>
      <td style="width:34px;text-align:right">${typeof togliDaMagazzino === 'function' && getStock(a.id, _detailMagId) > 0 ? `<button class="btn btn-danger btn-xs" onclick="event.stopPropagation();togliDaMagazzino(${a.id})" title="Togli dal magazzino">✕</button>` : ''}</td>
    </tr>`).join('');
  return `<tr class="mag-bau-row" onclick="toggleGrp(this,'${key}')">
      <td>${codiceBadge(g.pezzi[0].codice, cat?.colore)}</td>
      <td class="wrap"><strong><span class="mag-bau-arrow" style="${open ? 'transform:rotate(90deg)' : ''}">▶</span>${h(m.nome)} <span class="var-chip var-chip-n">×${g.pezzi.length}</span> ${varSummary(g.pezzi)}${g.pezzi.some(a => getStock(a.id, _detailMagId) === 0) ? ` <span class="var-chip">${g.pezzi.filter(a => getStock(a.id, _detailMagId) === 0).length} nei case</span>` : ''}</strong>${noteBtn(g.pezzi[0].id)}${_magCompact() ? `<div class="mag-cat-sub">${catPill(cat)}</div>` : ''}</td>
      <td style="text-align:right"><span style="font-family:'Fraunces',serif;font-size:20px;font-weight:700">${g.qty}</span></td>
      ${_magCompact() ? '' : `<td style="font-family:'DM Mono',monospace;font-size:12px;color:var(--ink3)">pz</td>
      <td class="wrap">${catPill(cat)}</td>`}
      <td></td>
    </tr>
    <tr class="art-expand-row${open ? ' open' : ''}"><td colspan="${_magCompact()?4:6}" class="art-expand-cell"><div class="pezzi-box">
      <table class="pezzi-tab"><tbody>${pezzi}</tbody></table>
    </div></td></tr>`;
}
function rerenderVarianti() {
  const t = id => document.getElementById(id);
  try { renderArticoli(); } catch (e) {}
  try { renderStock(); } catch (e) {}
  try { if (t('modalMagDetail')?.classList.contains('open')) renderMagDetailTable(); } catch (e) {}
  try { if (typeof renderNonAssegnati === 'function') renderNonAssegnati(); } catch (e) {}
  try { if (_flckCorrente) renderFlckDettaglio(); } catch (e) {}
}
async function cambiaVariante(id, sel) {
  const old = getArt(id)?.variante;
  try {
    await apiFetch('PUT', `/articoli/${id}/variante`, { variante: sel.value });
    await loadPartial('articoli');
    rerenderVarianti();
    toast('Variante aggiornata ✓');
  } catch (e) { sel.value = old; }
}
async function eliminaModello(mid) {
  const m = getModello(mid); if (!m) return;
  if (!await askConfirm(`Eliminare l'articolo "${m.nome}"?\nNon ha ancora pezzi creati.`, { ok: 'Elimina', danger: true })) return;
  try {
    await apiFetch('DELETE', `/modelli/${mid}`);
    await loadPartial('articoli'); rerenderVarianti();
    try { renderCaricaScarica(); } catch (e) {}
    try { if (curPage === 'crea') renderCrea(); } catch (e) {}
    toast('Articolo eliminato ✓');
  } catch (e) {}
}
const modelliSenzaPezzi = () => (D.modelli || []).filter(m => !D.articoli.some(a => a.modello_id == m.id));
const _nascosto = a => isFlightcaseArt(a.id) || isFlckArt(a.id);   // gruppi di articoli: non compaiono nelle liste articoli
function modelloVuotoBtns(m, cls) {
  if (currentUser?.ruolo !== 'admin') return '';
  return `<button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();caricaModello(${m.id})">↓ Carica</button> <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();modificaVarianti(${m.id})">Varianti</button> <button class="btn btn-danger btn-xs" onclick="event.stopPropagation();eliminaModello(${m.id})">Elimina</button>`;
}
// Pannello varianti nel carico: quantità + tessere cliccabili con ripartizione
let _cv = { tot: 1, q: {} };
const cvSum = () => Object.values(_cv.q).reduce((x, y) => x + y, 0);
function cvModello() { const v = document.getElementById('cArticolo')?.value || ''; return /^m\d+$/.test(v) ? getModello(+v.slice(1)) : null; }
function cvReset() { _cv = { tot: 1, q: {} }; cvRender(); }
function cvSetTot(v) {
  let n = Math.max(1, Math.min(200, parseInt(v) || 1)); const was = _cv.tot, ks = Object.keys(_cv.q).filter(k => _cv.q[k] > 0);
  if (n > was && cvSum() === was && ks.length === 1) _cv.q[ks[0]] = n;       // una sola variante: segue il totale
  _cv.tot = n;
  while (cvSum() > n) { const k = Object.keys(_cv.q).sort((x, y) => _cv.q[y] - _cv.q[x])[0]; _cv.q[k]--; if (!_cv.q[k]) delete _cv.q[k]; }
  cvRender();
}
function cvTap(i) {
  const m = cvModello(); if (!m) return; const v = m.varianti[i]; if (v === undefined) return;
  const ks = Object.keys(_cv.q).filter(k => _cv.q[k] > 0);
  if (!ks.length) _cv.q[v] = _cv.tot;                                    // primo tocco: tutti i pezzi a questa variante
  else if (cvSum() < _cv.tot) _cv.q[v] = (_cv.q[v] || 0) + 1;            // ci sono pezzi da assegnare
  else {                                                                  // tutti assegnati: ne sposto 1 dalla variante più numerosa
    const don = ks.filter(k => k !== v).sort((x, y) => _cv.q[y] - _cv.q[x])[0];
    if (!don) return; _cv.q[don]--; if (!_cv.q[don]) delete _cv.q[don]; _cv.q[v] = (_cv.q[v] || 0) + 1;
  }
  cvRender();
}
function cvMinus(i, ev) {
  ev?.stopPropagation(); const m = cvModello(); if (!m) return; const v = m.varianti[i];
  if (_cv.q[v] > 0) { _cv.q[v]--; if (!_cv.q[v]) delete _cv.q[v]; } cvRender();
}
function cvRender() {
  const box = document.getElementById('cVarPanel'); if (!box) return;
  const m = cvModello();
  box.style.display = m ? '' : 'none';
  const qw = document.getElementById('cQtyWrap'), nw = document.getElementById('cNoteWrap');
  if (qw) qw.style.display = m ? 'none' : ''; if (nw) nw.style.display = m ? 'none' : '';
  if (!m) { ccBar(); return; }
  const rest = _cv.tot - cvSum();
  document.getElementById('cVarTot').value = _cv.tot;
  document.getElementById('cVarTiles').innerHTML = m.varianti.map((v, i) => {
    const n = _cv.q[v] || 0;
    return `<div class="cv-tile${n ? ' on' : ''}" onclick="cvTap(${i})"><div class="cv-name">${h(v)}</div><div class="cv-n">${n || ''}</div>${n ? `<button type="button" class="cv-minus" onclick="cvMinus(${i}, event)" title="Togli uno">−</button>` : ''}</div>`;
  }).join('');
  document.getElementById('cVarInfo').innerHTML = rest > 0 ? `Da assegnare: <strong>${rest}</strong> — tocca una variante` : `✓ ${_cv.tot} ${_cv.tot === 1 ? 'pezzo' : 'pezzi'} assegnati`;
  document.getElementById('cVarInfo').style.color = rest > 0 ? 'var(--orange,#c2410c)' : 'var(--green)';
  ccBar();
}
async function modificaVarianti(mid) {
  const m = getModello(mid); if (!m) return;
  const r = await askPrompt(`Varianti di "${m.nome}" (separate da virgola).\nUna variante usata da un pezzo non si può togliere.`, m.varianti.join(', '));
  if (r === null) return;
  try {
    await apiFetch('PUT', `/modelli/${mid}`, { varianti: r.split(/[,;\n]/).map(x => x.trim()).filter(Boolean) });
    await loadPartial('articoli'); rerenderVarianti();
    toast('Varianti aggiornate ✓');
  } catch (e) {}
}
function onVarToggle(p) {
  const on = document.getElementById(p + 'VarOn').checked;
  document.getElementById(p + 'VarBox').style.display = on ? '' : 'none';
  ['Codice', 'Um'].forEach(f => { const el = document.getElementById(p + f); if (el) el.closest('.fgroup').style.display = on ? 'none' : ''; });
}
function resetVar(p) {
  const c = document.getElementById(p + 'VarOn'); if (!c) return;
  c.checked = false; document.getElementById(p + 'VarList').value = '';
  onVarToggle(p);
}
async function creaModelloDa(p) {      // true se creato; false se mancano dati (toast già mostrato)
  const g = f => document.getElementById(p + f);
  const cat_id = +g('Cat').value || null, nome = g('Nome').value.trim(), note = g('Note').value.trim();
  const varianti = g('VarList').value.split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
  if (!cat_id) { toast('Categoria obbligatoria', true); return false; }
  if (!nome) { toast('Nome obbligatorio', true); return false; }
  if (!varianti.length) { toast('Indica almeno una variante', true); return false; }
  return await apiFetch('POST', '/modelli', { nome, cat_id, note, varianti });
}

const _magCompact = () => window.matchMedia('(max-width:600px)').matches;   // telefono: niente colonne U.M. e Categoria
function renderMagDetailTable() {
  const magId = _detailMagId;
  const m = getMag(magId);
  const isAdmin = currentUser?.ruolo==='admin';
  document.getElementById('modalMagDetailTitle').textContent = m.nome;
  document.getElementById('modalMagDetailSub').textContent = (m.citta||'') + ' · ' + totalMag(magId) + ' pezzi totali';
  // Colgroup e thead dinamici in base al ruolo
  const colsMagDetail = document.getElementById('colsMagDetail');
  const headMagDetail = document.getElementById('headMagDetail');
  if(isAdmin) {
    colsMagDetail.innerHTML = _magCompact()
      ? '<col style="width:78px"><col style="width:auto"><col style="width:46px"><col style="width:50px">'
      : '<col style="width:88px"><col style="width:auto"><col style="width:60px"><col style="width:58px"><col style="width:150px"><col style="width:84px">';
    headMagDetail.innerHTML = _magCompact()
      ? '<tr><th>Codice</th><th>Articolo</th><th style="text-align:right">Qtà</th><th></th></tr>'
      : '<tr><th>Codice</th><th>Articolo</th><th style="text-align:right">Qtà</th><th>U.M.</th><th>Categoria</th><th></th></tr>';
  } else {
    colsMagDetail.innerHTML = _magCompact()
      ? '<col style="width:78px"><col style="width:auto"><col style="width:46px"><col style="width:50px">'
      : '<col style="width:88px"><col style="width:auto"><col style="width:60px"><col style="width:58px"><col style="width:150px"><col style="width:84px">';
    headMagDetail.innerHTML = _magCompact()
      ? '<tr><th>Codice</th><th>Articolo</th><th style="text-align:right">Qtà</th><th></th></tr>'
      : '<tr><th>Codice</th><th>Articolo</th><th style="text-align:right">Qtà</th><th>U.M.</th><th>Categoria</th><th></th></tr>';
  }
  // Popola filtro categoria con solo le categorie presenti nel magazzino
  const selCat = document.getElementById('filterCatDetail');
  const prevCat = selCat.value;
  const righeAll = righeMagConContenuti(magId);
  const catPresenti = [...new Map(righeAll.map(s=>{ const a=getArt(s.art_id); const c=getCat(a?.cat_id); return c?[c.id,c]:null; }).filter(Boolean)).entries()].map(([,c])=>c);
  selCat.innerHTML = '<option value="">Tutte le categorie</option>' +
    catPresenti.map(c=>`<option value="${c.id}"${c.id==prevCat?' selected':''}>${h(c.nome)}</option>`).join('');
  // Filtra righe
  const cf = selCat.value;
  const righe = raggruppaPezziMag(sortBauliFirst(righeAll.filter(s=> !cf || getArt(s.art_id)?.cat_id == cf), r => r.art_id));
  document.getElementById('tbMagDetail').innerHTML = righe.length ? righe.map(s=>{
    if (s.g) return magGruppoRows(s);
    const a=getArt(s.art_id), cat=getCat(a?.cat_id);
    const qtyStyle = `font-family:'Fraunces',serif;font-size:20px;font-weight:700`;
    const monoStyle = `font-family:'DM Mono',monospace;font-size:12px;color:var(--ink3)`;
    const isBau = isBauleArt(s.art_id);
    const isFLC = isFlightcaseArt(s.art_id);
    const isFLCK = isFlckArt(s.art_id), kDef = isFLCK ? getFlck(s.art_id) : null;
    const hasCase = !isBau && !isFLC && !isFLCK && !!(s._case && s._case.length);
    const isSpecial = isBau || isFLC || isFLCK || hasCase;
    const fcDef = isFLC ? getFlightcaseDef(s.art_id) : null;
    const specialPill = isFLCK ? flckPillMag(kDef) : isBau
      ? `<span class="mag-bau-pill"><svg width="10" height="10" viewBox="0 0 48 48" fill="none" style="vertical-align:middle;margin-right:2px"><rect x="6" y="12" width="36" height="26" rx="2" stroke="#92400e" stroke-width="3.5" fill="none"/><path d="M6 12l3-3h30l3 3" stroke="#92400e" stroke-width="3" fill="none"/><rect x="6" y="12" width="4" height="4" rx="0.5" fill="#92400e" opacity=".5"/><rect x="38" y="12" width="4" height="4" rx="0.5" fill="#92400e" opacity=".5"/><rect x="6" y="34" width="4" height="4" rx="0.5" fill="#92400e" opacity=".5"/><rect x="38" y="34" width="4" height="4" rx="0.5" fill="#92400e" opacity=".5"/><line x1="6" y1="25" x2="42" y2="25" stroke="#92400e" stroke-width="2" opacity=".5"/><circle cx="16" cy="25" r="2" fill="#92400e" opacity=".5"/><circle cx="32" cy="25" r="2" fill="#92400e" opacity=".5"/></svg> baule</span>`
      : isFLC
      ? `<span class="mag-bau-pill" style="background:#6b4c6e22;color:#6b4c6e;border-color:#6b4c6e44"><svg width="10" height="10" viewBox="0 0 48 48" fill="none" style="vertical-align:middle;margin-right:2px"><rect x="6" y="12" width="36" height="26" rx="2" stroke="#6b4c6e" stroke-width="3.5" fill="none"/><path d="M6 12l3-3h30l3 3" stroke="#6b4c6e" stroke-width="3" fill="none"/><rect x="6" y="12" width="4" height="4" rx="0.5" fill="#6b4c6e" opacity=".5"/><rect x="38" y="12" width="4" height="4" rx="0.5" fill="#6b4c6e" opacity=".5"/><rect x="6" y="34" width="4" height="4" rx="0.5" fill="#6b4c6e" opacity=".5"/><rect x="38" y="34" width="4" height="4" rx="0.5" fill="#6b4c6e" opacity=".5"/><line x1="6" y1="25" x2="42" y2="25" stroke="#6b4c6e" stroke-width="2" opacity=".5"/><circle cx="16" cy="25" r="2" fill="#6b4c6e" opacity=".5"/><circle cx="32" cy="25" r="2" fill="#6b4c6e" opacity=".5"/></svg> case${fcDef?` · ${h(fcDef.art_contenuto_nome)} ×${fcDef.qty_max}`:''}</span>`
      : '';
    const nomeCell = hasCase
      ? `<strong><span class="mag-bau-arrow" id="bau-arr-${s.art_id}">▶</span>${a?h(a.nome):'—'}${caseChips(s._lib, s._case)}</strong>${noteBtn(s.art_id)}`
      : isSpecial
      ? `<strong><span class="mag-bau-arrow" id="bau-arr-${s.art_id}">▶</span>${h(a?.nome)||'—'}${specialPill}</strong>`
      : `<strong>${a?h(a.nome):'—'}</strong>${noteBtn(s.art_id)}`;
    const mainRow = `<tr class="${isSpecial?'mag-bau-row':''}" ${isSpecial?`onclick="toggleBauleInMag(${s.art_id})"`:''}>
      <td>${codiceBadge(a?.codice, a ? getCat(a.cat_id)?.colore : null)}</td>
      <td class="wrap">${nomeCell}${_magCompact() && cat ? `<div class="mag-cat-sub">${catPill(cat)}</div>` : ''}</td>
      <td style="text-align:right"><span style="${qtyStyle}">${s.qty}</span></td>
      ${_magCompact() ? '' : `<td style="${monoStyle}">${h(a?.um)||'pz'}</td>
      <td class="wrap">${catPill(cat)}</td>`}
      <td style="text-align:right;overflow:visible;padding-left:4px;padding-right:12px;white-space:nowrap">${!isSpecial ? `<button class="btn btn-ghost btn-xs" title="Togli da questo magazzino" onclick="event.stopPropagation();togliDaMagazzino(${s.art_id},${magId})">✕</button>` : ''}</td>
    </tr>`;
    const expandRow = hasCase
      ? `<tr class="mag-bau-expand" id="bau-exp-${s.art_id}" style="display:none"><td colspan="${_magCompact()?4:6}"><div class="mag-bau-expand-inner" style="padding:6px 12px">${caseBreakdown(s._lib, s._case)}</div></td></tr>`
      : isFLCK
      ? `<tr class="mag-bau-expand" id="bau-exp-${s.art_id}" style="display:none"><td colspan="${_magCompact()?4:6}"><div class="mag-bau-expand-inner" style="padding:8px 12px">${flckContenutoBox(kDef)}</div></td></tr>`
      : isBau
      ? `<tr class="mag-bau-expand" id="bau-exp-${s.art_id}" style="display:none">
           <td colspan="${_magCompact()?4:6}">
             <div class="mag-bau-expand-inner" id="bau-voci-${s.art_id}">
               <span style="font-size:12px;color:var(--ink3)">Caricamento…</span>
             </div>
           </td>
         </tr>`
      : isFLC && fcDef
      ? `<tr class="mag-bau-expand" id="bau-exp-${s.art_id}" style="display:none">
           <td colspan="${_magCompact()?4:6}">
             <div class="mag-bau-expand-inner" style="padding:8px 12px">
               <div style="font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;margin-bottom:4px">Contenuto definito</div>
               <table><tbody><tr>
                 <td style="width:36px;font-family:'DM Mono',monospace;font-weight:700;color:var(--teal-dark);padding:4px 8px">×${fcDef.qty_max}</td>
                 <td style="padding:4px 8px;font-size:12px">${codiceBadge(fcDef.art_contenuto_codice, fcDef.art_contenuto_cat_colore)} ${h(fcDef.art_contenuto_nome||'—')}${noteBtn(fcDef.art_id_contenuto)}</td>
               </tr></tbody></table>
             </div>
           </td>
         </tr>`
      : '';
    return mainRow + expandRow;
  }).join('') : `<tr><td colspan="${_magCompact()?4:6}" class="empty">Magazzino vuoto</td></tr>`;
}
async function toggleBauleInMag(artId) {
  const expRow = document.getElementById(`bau-exp-${artId}`);
  const arrow  = document.getElementById(`bau-arr-${artId}`);
  if (!expRow) return;
  const isOpen = expRow.style.display !== 'none';
  expRow.style.display = isOpen ? 'none' : '';
  if (arrow) arrow.style.transform = isOpen ? '' : 'rotate(90deg)';
  // FLC: expand row is static, no async load needed
  if (!isBauleArt(artId)) return;
  // BAU: load voci from API
  const vociDiv = document.getElementById(`bau-voci-${artId}`);
  if (!isOpen && vociDiv) {
    vociDiv.innerHTML = '<span style="font-size:12px;color:var(--ink3)">Caricamento…</span>';
    try {
      const voci = await apiFetch('GET', `/bauli/${artId}/voci`);
      if (!voci.length) {
        vociDiv.innerHTML = '<span style="font-size:12px;color:var(--ink3);font-style:italic">Baule vuoto</span>';
      } else {
        vociDiv.innerHTML = `<table>
          <tbody>${voci.map(v => `<tr>
            <td style="width:36px;font-family:'DM Mono',monospace;font-weight:700;color:var(--teal-dark);padding:4px 8px;border-bottom:0.5px solid var(--border)">${v.qty}</td>
            <td style="padding:4px 8px;border-bottom:0.5px solid var(--border);font-size:12px">${h(v.nome)}</td>
          </tr>`).join('')}</tbody>
        </table>`;
      }
    } catch(e) {
      vociDiv.innerHTML = '<span style="font-size:12px;color:var(--red)">Errore caricamento</span>';
    }
  }
}


async function svuotaMag(magId) {
  const magVirt=getMagVirt();
  if (!magVirt) { toast('Magazzino virtuale non trovato',true); return; }
  const mag=getMag(magId);
  const righe=D.stock.filter(s=>s.mag_id==magId&&s.qty>0);
  if (!righe.length) { toast('Il magazzino è già vuoto',true); return; }
  const totPz=righe.reduce((n,s)=>n+s.qty,0);
  if (!await askConfirm(`Spostare tutto il contenuto di "${mag.nome}" nel Cestino?\n${righe.length} tipo/i, ${totPz} pezzi totali`, { ok: 'Sposta nel Cestino', danger: true })) return;
  try {
    await apiFetch('POST','/spostamenti/batch',{
      spostamenti: righe.map(s=>({art_id:s.art_id,mag_from:magId,mag_to:magVirt.id,qty:s.qty})),
      nota_batch: `Svuotamento ${h(mag.nome)}`
    });
    await loadPartial('spostamenti'); renderMag();
    pushUndo({type:'svuotaMag',magId,magVirtId:magVirt.id,righe:[...righe]});
    toast(`"${h(mag.nome)}" svuotato ✓`);
  } catch(e) { toast(e.message||'Errore imprevisto — riprova', true); }
}
function selIconMag(el) {
  document.querySelectorAll('#iconPickerMag .icon-opt').forEach(b=>b.classList.remove('sel'));
  el.classList.add('sel');
  document.getElementById('magIcona').value = el.dataset.icon;
}
function setIconPickerMag(icon) {
  const icons = document.querySelectorAll('#iconPickerMag .icon-opt');
  let found = false;
  icons.forEach(b => {
    b.classList.remove('sel');
    if (b.dataset.icon === icon) { b.classList.add('sel'); found = true; }
  });
  if (!found) { icons[0].classList.add('sel'); document.getElementById('magIcona').value = icons[0].dataset.icon; }
  else { document.getElementById('magIcona').value = icon; }
}
function selClasseMag(el) {
  document.querySelectorAll('.mag-classe-opt').forEach(b=>b.classList.remove('sel'));
  el.classList.add('sel');
  const classe = el.dataset.classe;
  document.getElementById('magClasse').value = classe;
  document.getElementById('magClasseDesc').textContent = classe==='tour'
    ? 'Magazzino mobile da tour — svuotamento e trasferimento totale abilitati.'
    : 'Magazzino fisso permanente — svuotamento disabilitato.';
}
function setClassePickerMag(classe) {
  document.querySelectorAll('.mag-classe-opt').forEach(b=>{
    b.classList.toggle('sel', b.dataset.classe===(classe||'stabile'));
  });
  document.getElementById('magClasse').value = classe||'stabile';
  document.getElementById('magClasseDesc').textContent = classe==='tour'
    ? 'Magazzino mobile da tour — svuotamento e trasferimento totale abilitati.'
    : 'Magazzino fisso permanente — svuotamento disabilitato.';
}
function openModalMagNew() {
  document.getElementById('magEditId').value='';
  document.getElementById('modalMagTitle').textContent='Nuovo Magazzino';
  ['magNome','magCitta','magNote'].forEach(id=>document.getElementById(id).value='');
  selColorMag = COLORS[0]; buildSwatchesMag();
  setIconPickerMag('🏭');
  setClassePickerMag('stabile');
  openModal('modalMag');
}
function editMag(id) {
  const m=getMag(id);
  document.getElementById('magEditId').value=id;
  document.getElementById('modalMagTitle').textContent='Modifica Magazzino';
  document.getElementById('magNome').value=m.nome;
  document.getElementById('magCitta').value=m.citta||'';
  document.getElementById('magNote').value=m.note||'';
  selColorMag = m.colore || COLORS[0]; buildSwatchesMag();
  setIconPickerMag(m.icona||'🏭');
  setClassePickerMag(m.classe||'stabile');
  openModal('modalMag');
}
async function salvaMag() {
  const id=document.getElementById('magEditId').value;
  const body={nome:document.getElementById('magNome').value.trim(), citta:document.getElementById('magCitta').value.trim(), note:document.getElementById('magNote').value.trim(), colore:selColorMag||COLORS[0], icona:document.getElementById('magIcona').value||'🏭', classe:document.getElementById('magClasse').value||'stabile'};
  if (!body.nome) { toast('Nome obbligatorio',true); return; }
  try {
    id ? await apiFetch('PUT',`/magazzini/${id}`,body) : await apiFetch('POST','/magazzini',body);
    closeModal('modalMag'); await loadPartial('magazzini'); renderMag();
    toast(id?'Aggiornato ✓':'Creato ✓');
  } catch(e) { toast(e.message||'Errore imprevisto — riprova', true); }
}
async function delMag(id) {
  if (!await askConfirm('Eliminare questo magazzino?', { ok: 'Elimina', danger: true })) return;
  try { await apiFetch('DELETE',`/magazzini/${id}`); await loadPartial('magazzini'); renderMag(); toast('Eliminato'); }
  catch(e) {}
}

// ─── ARTICOLI ───
let curArtTab = 'stock';
function switchArtTab(tab) {
  curArtTab = tab;
  document.getElementById('tabConStock').classList.toggle('active', tab==='stock');
  document.getElementById('tabSenzaStock').classList.toggle('active', tab==='nosstock');
  document.getElementById('artTabStock').style.display = tab==='stock' ? '' : 'none';
  document.getElementById('artTabNoStock').style.display = tab==='nosstock' ? '' : 'none';
}

function renderArticoli() {
  const fc=document.getElementById('filterCatArt');
  const cv=fc.value;
  fc.innerHTML='<option value="">Tutte le categorie</option>'+
    D.categorie.filter(c=>!['FLC','FLCK'].includes(c.prefisso)).map(c=>`<option value="${c.id}"${cv==c.id?' selected':''}>[${h(c.prefisso)}] ${h(c.nome)}</option>`).join('');
  const fm=document.getElementById('filterMagArt');
  const cmv=fm.value;
  fm.innerHTML='<option value="">Tutti i magazzini</option>'+
    getMagReali().map(m=>`<option value="${m.id}"${cmv==m.id?' selected':''}>${h(m.nome)}</option>`).join('');
  const s=document.getElementById('searchArt').value.toLowerCase();
  const cf=fc.value;
  const mf=fm.value;
  const magVirt=getMagVirt();

  // Tab 1: con stock reale
  let listStock=D.articoli.filter(a=>totalArtReale(a.id)>0&&!_nascosto(a));
  if(s)  listStock=listStock.filter(a=>a.nome.toLowerCase().includes(s)||a.codice.toLowerCase().includes(s));
  if(cf) listStock=listStock.filter(a=>a.cat_id==cf);
  if(mf) listStock=listStock.filter(a=>getTot(a.id,+mf)>0);
  { const c=document.getElementById('cntArt'); if(c) c.textContent=`${listStock.length} articoli · ${listStock.reduce((t,a)=>t+totalArtReale(a.id),0)} pz`; }
  listStock=raggruppaPezzi(sortBauliFirst(listStock));

  document.getElementById('tbArt').innerHTML = listStock.length ? listStock.map(a=>{
    if (a.g) return artGruppoRows(a);
    const cat=getCat(a.cat_id);
    const totReale=totalArtReale(a.id);
    const totVirt=magVirt?getTot(a.id,magVirt.id):0;
    const pills=D.magazzini.filter(m=>!m.virtuale&&getTot(a.id,m.id)>0)
      .map(m=>`<span class="stock-pill"><strong>${getTot(a.id,m.id)}</strong> ${h(m.nome)}</span>`).join('');
    const isAdmin = currentUser?.ruolo==='admin';
    const virtPill = isAdmin && totVirt>0 ? `<span class="stock-pill" style="background:var(--teal-bg);border-color:var(--teal-border);color:var(--virt-text)"><strong>${totVirt}</strong> cestino</span>` : '';
    const allPills = pills + virtPill;
    const expandPills = pills + (isAdmin && totVirt>0 ? virtPill : '');
    const isBau = isBauleArt(a.id);
    const isFLC = isFlightcaseArt(a.id);
    const isFLCK = isFlckArt(a.id), kDef = isFLCK ? getFlck(a.id) : null;
    const fcDef = isFLC ? getFlightcaseDef(a.id) : null;
    const specialPill = isFLCK ? flckPillSm(kDef) : isBau
      ? ' <span style="font-size:9px;background:#92400e15;color:#92400e;border:1px solid #92400e33;padding:1px 5px;border-radius:3px;font-family:\'DM Mono\',monospace;vertical-align:middle">baule</span>'
      : isFLC
      ? ` <span style="font-size:9px;background:#6b4c6e15;color:#6b4c6e;border:1px solid #6b4c6e33;padding:1px 5px;border-radius:3px;font-family:'DM Mono',monospace;vertical-align:middle">case${fcDef?` · ${h(fcDef.art_contenuto_nome)} ${fcDef.qty_caricata}/${fcDef.qty_max}`:''}</span>`
      : '';
    // Extra content for BAU/FLC in expand row
    let specialExpand = '';
    if (isBau) specialExpand = `<div style="margin-top:6px;font-size:11px;color:#92400e" id="art-bau-wrap-${a.id}"><span style="color:var(--ink3)">Caricamento…</span></div>`;
    if (isFLC && fcDef) {
      const pct = fcDef.qty_max ? Math.round(fcDef.qty_caricata / fcDef.qty_max * 100) : 0;
      const barCol = pct >= 100 ? '#22c55e' : pct > 0 ? '#6b4c6e' : 'var(--ink4)';
      specialExpand = `<div style="margin-top:6px;font-size:11px;color:#6b4c6e">
        Contiene: <strong>${h(fcDef.art_contenuto_nome||'—')}</strong> — ${fcDef.qty_caricata}/${fcDef.qty_max} caricati
        <div style="margin-top:4px;height:5px;background:var(--ink4);border-radius:3px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${barCol};border-radius:3px"></div></div>
      </div>`;
    }
    if (isFLCK) specialExpand = `<div style="margin-top:6px">${flckContenutoHtml(kDef)}</div>`;
    const rowClick = (isBau || isFLC || isFLCK) ? ` onclick="toggleArtExpand(this.querySelector('.art-expand-btn'));${isBau?`loadBauVociInArt(${a.id})`:''}" style="cursor:pointer"` : '';
    return `<tr${rowClick}>
      <td class="c-exp" style="padding:4px 2px 4px 10px"><button class="art-expand-btn" onclick="event.stopPropagation();toggleArtExpand(this)${isBau?`;loadBauVociInArt(${a.id})`:''}" title="Vedi dettagli">▼</button></td>
      <td>${codiceBadge(a.codice, getCat(a.cat_id)?.colore)}</td>
      <td class="name" title="${h(a.nome)}"><strong>${h(a.nome)}</strong>${catPill(cat)}${varChip(a)}${specialPill}${a.note?`<span class="nm-note">${h(a.note)}</span>`:''}</td>
      <td><span class="q-n">${totReale}</span><span class="q-u">${h(a.um)}</span></td>
      <td class="col-depositi">
        <div class="stock-inline">${allPills||'<span style="font-size:11px;color:var(--ink3)">—</span>'}</div>
      </td>
      <td class="act">${isAdmin && !isBau && !isFLC && !isFLCK ?`<button class="btn btn-ghost btn-xs ib" data-action="editArt" data-id="${a.id}" title="Modifica">✎</button><button class="btn btn-orange btn-xs ib" data-action="mandaNonAss" data-id="${a.id}" title="Manda nel cestino">🗑</button><button class="btn btn-danger btn-xs ib" data-action="delArtDirect" data-id="${a.id}" title="Elimina">✕</button>`:''}</td>
    </tr>
    <tr class="art-expand-row">
      <td colspan="6" class="art-expand-cell">
        ${a.note?`<div style="font-size:11px;color:var(--ink3);margin-bottom:4px">${h(a.note)}</div>`:''}
        <div class="stock-inline" style="flex-wrap:wrap">${expandPills||'<span style="font-size:11px;color:var(--ink3)">—</span>'}</div>
        ${caseLines(a.id)}
        ${specialExpand}
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="empty">Nessun articolo con stock disponibile</td></tr>';

  // Tab 2: senza stock (nessuno stock in nessun magazzino, nemmeno virtuale)
  const listNoStock=D.articoli.filter(a=>{
    const totAll=totalArtAny(a.id);
    return totAll===0&&!_nascosto(a);
  });
  const listNoStockSorted = sortBauliFirst(listNoStock);
  const modVuoti = modelliSenzaPezzi();
  document.getElementById('tbArtNoStock').innerHTML = (listNoStockSorted.length||modVuoti.length) ? modVuoti.map(m=>{ const cat=getCat(m.cat_id);
    return `<tr>
      <td>${codiceBadge(m.codice||'—', cat?.colore)}</td>
      <td><strong>${h(m.nome)}</strong> <span class="var-chip">${m.varianti.map(h).join(' · ')}</span></td>
      <td class="wrap" style="font-size:12px;color:var(--ink3)">${h(m.note)||'—'}</td>
      <td>${catPill(cat)}</td>
      <td style="font-family:'DM Mono',monospace;font-size:12px">pz</td>
      <td style="text-align:right;white-space:nowrap">${modelloVuotoBtns(m)}</td>
    </tr>`; }).join('') + listNoStockSorted.map(a=>{
    const cat=getCat(a.cat_id);
    return `<tr>
      <td>${codiceBadge(a.codice, getCat(a.cat_id)?.colore)}</td>
      <td><strong>${h(a.nome)}</strong>${varChip(a)}</td>
      <td class="wrap" style="font-size:12px;color:var(--ink3)">${h(a.note)||'—'}</td>
      <td>${catPill(cat)}</td>
      <td style="font-family:'DM Mono',monospace;font-size:12px">${h(a.um)}</td>
      <td style="text-align:right;white-space:nowrap">
        ${currentUser?.ruolo==='admin'?`
        <button class="btn btn-ghost btn-xs" data-action="editArt" data-id="${a.id}">Modifica</button>
        <button class="btn btn-danger btn-xs" data-action="delArt" data-id="${a.id}">Elimina</button>`:''}
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="empty">✓ Tutti gli articoli hanno uno stock assegnato</td></tr>';

  // Aggiorna badge tabs
  document.getElementById('badgeConStock').textContent = listStock.length;
  const nNoStock = listNoStock.length + modVuoti.length;
  document.getElementById('badgeSenzaStock').textContent = nNoStock;
  document.getElementById('badgeSenzaStock').className = 'art-tab-badge' + (nNoStock>0?' warn':'');
}

async function loadBauVociInArt(artId) {
  const div = document.getElementById(`art-bau-wrap-${artId}`);
  if (!div || div.dataset.loaded) return;
  div.dataset.loaded = '1';
  try {
    const voci = await apiFetch('GET', `/bauli/${artId}/voci`);
    if (!voci.length) {
      div.innerHTML = '<em style="color:var(--ink3)">Baule vuoto</em>';
    } else {
      div.innerHTML = '<table style="margin-top:2px">' + voci.map(v =>
        `<tr><td style="width:30px;font-family:'DM Mono',monospace;font-weight:700;color:var(--teal-dark);padding:2px 6px">${v.qty}</td><td style="padding:2px 6px;font-size:11px">${h(v.nome)}</td></tr>`
      ).join('') + '</table>';
    }
  } catch(e) { div.innerHTML = '<span style="color:var(--red)">Errore caricamento</span>'; }
}

function toggleStockExpand(row) {
  const detail = row.nextElementSibling;
  if (!detail?.classList.contains('art-expand-row')) return;
  const isOpen = detail.classList.contains('open');
  detail.classList.toggle('open', !isOpen);
  // Load BAU voci on first open
  if (!isOpen) {
    const bauDiv = detail.querySelector('[id^="stock-bau-"]');
    if (bauDiv && !bauDiv.dataset.loaded) {
      bauDiv.dataset.loaded = '1';
      const artId = bauDiv.id.split('-')[2];
      apiFetch('GET', `/bauli/${artId}/voci`).then(voci => {
        if (!voci.length) bauDiv.innerHTML = '<em style="color:var(--ink3)">Baule vuoto</em>';
        else bauDiv.innerHTML = '<table style="margin-top:2px">' + voci.map(v =>
          `<tr><td style="width:30px;font-family:'DM Mono',monospace;font-weight:700;color:var(--teal-dark);padding:2px 6px">${v.qty}</td><td style="padding:2px 6px;font-size:11px">${h(v.nome)}</td></tr>`
        ).join('') + '</table>';
      }).catch(() => { bauDiv.innerHTML = '<span style="color:var(--red)">Errore</span>'; });
    }
  }
}

// ─── CESTINO ───
function renderNonAssegnati() {
  const magVirt=getMagVirt();
  const tbody=document.getElementById('tbNonAss');
  if (!magVirt) { tbody.innerHTML='<tr><td colspan="7" class="empty">Magazzino virtuale non trovato</td></tr>'; return; }
  const righe=D.stock.filter(s=>s.mag_id==magVirt.id&&s.qty>0);
  if (!righe.length) { tbody.innerHTML='<tr><td colspan="7" class="empty">✓ Nessun articolo parcheggiato qui</td></tr>'; return; }
  tbody.innerHTML = righe.map(s=>{
    const a=getArt(s.art_id), cat=getCat(a?.cat_id);
    const stockReale=totalArtReale(s.art_id);
    const pillsReali=D.magazzini.filter(m=>!m.virtuale&&getTot(s.art_id,m.id)>0)
      .map(m=>`<span class="stock-pill"><strong>${getTot(s.art_id,m.id)}</strong> ${h(m.nome)}</span>`).join('');
    return `<tr class="nonass-row">
      <td>${codiceBadge(a?.codice, a ? getCat(a.cat_id)?.colore : null)}</td>
      <td><strong>${a?h(a.nome):'—'}</strong>${varChip(a)}</td>
      <td>${catPill(cat)}</td>
      <td style="font-family:'DM Mono',monospace;font-size:12px;color:var(--ink3)">${h(a?.um)||'pz'}</td>
      <td><span style="font-family:'Fraunces',serif;font-size:22px;font-weight:700;color:var(--virt-text)">${getTot(s.art_id,s.mag_id)}</span></td>
      <td>${stockReale>0?`<div class="stock-inline">${pillsReali}</div>`:'<span style="font-size:12px;color:var(--ink3)">Nessuno stock altrove</span>'}</td>
      <td style="text-align:right"><div style="display:flex;gap:6px;justify-content:flex-end;align-items:center;flex-wrap:wrap">
        ${(isBauleArt(s.art_id)||isFlightcaseArt(s.art_id)||isFlckArt(s.art_id)) ? '' : `<button class="btn btn-orange btn-xs" data-action="scaricaCest" data-art-id="${s.art_id}">↓ Scarica</button>`}
        ${stockReale===0
          ? (() => { if (isBauleArt(s.art_id)) return `<button class="btn btn-danger btn-xs" onclick="eliminaBaule(${s.art_id})">🗑 Elimina baule</button>`;
              if (isFlightcaseArt(s.art_id)) return `<button class="btn btn-danger btn-xs" onclick="eliminaBaule(${s.art_id})">🗑 Elimina case</button>`;
              if (isFlckArt(s.art_id)) return `<button class="btn btn-danger btn-xs" onclick="eliminaFlck(${s.art_id})">🗑 Elimina case K</button>`;
              return `<button class="btn btn-danger btn-xs" data-action="eliminaDef" data-art-id="${s.art_id}">🗑 Elimina</button>`; })()
          : `<span style="font-size:11px;color:var(--ink3)">Svuota prima gli altri magazzini</span>`}
      </div></td>
    </tr>`;
  }).join('');
}

async function mandaANonAssegnati(artId) {
  const magVirt=getMagVirt();
  if (!magVirt) { toast('Magazzino virtuale non trovato',true); return; }
  const a=getArt(artId);
  const righe=D.stock.filter(s=>s.art_id==artId&&s.mag_id!=magVirt.id&&s.qty>0);
  if (!righe.length) { toast('Nessuno stock da spostare',true); return; }
  if (!await askConfirm(`Spostare tutto lo stock di "${a?.nome}" nel Cestino?`, { ok: 'Sposta nel Cestino', danger: true })) return;
  try {
    for (const s of righe)
      await apiFetch('POST','/spostamenti',{art_id:artId, mag_from:s.mag_id, mag_to:magVirt.id, qty:s.qty, note:'Spostato nel cestino', data:nowRoma()});
    await loadPartial('articoli'); renderArticoli();
    toast(`"${a?.nome}" spostato nel cestino ✓`);
  } catch(e) { toast(e.message||'Errore imprevisto — riprova', true); }
}
async function eliminaArtDefinitivo(artId) {
  const a=getArt(artId);
  if (!await askConfirm(`Eliminare definitivamente "${a?.nome}"?\nQuesta operazione è irreversibile.`, { ok: 'Elimina', danger: true })) return;
  try {
    await apiFetch('DELETE',`/articoli/${artId}`);
    await loadPartial('articoli'); renderNonAssegnati();
    toast(`"${a?.nome}" eliminato ✓`);
  } catch(e) { toast(e.message||'Errore imprevisto — riprova', true); }
}

// ─── SCARICO DAL CESTINO (toglie alcuni pezzi senza eliminare l'articolo) ───
let _scCestArt = 0, _scCestMax = 0;
function scaricaCestino(artId) {
  const mv = getMagVirt(); if (!mv) { toast('Magazzino virtuale non trovato', true); return; }
  const a = getArt(artId), max = getTot(artId, mv.id);
  if (!a || max < 1) { toast('Nessun pezzo nel Cestino', true); return; }
  _scCestArt = artId; _scCestMax = max;
  document.getElementById('scCestSub').innerHTML = `${codiceBadge(a.codice, getCat(a.cat_id)?.colore)} <strong style="color:var(--ink)">${h(a.nome)}</strong>${varChip(a)}`;
  document.getElementById('scCestQty').value = 1;
  scCestLive();
  openModal('modalScaricaCest');
  setTimeout(() => { const i = document.getElementById('scCestQty'); i.focus(); i.select(); }, 50);
}
const scCestClamp = v => Math.max(1, Math.min(_scCestMax, parseInt(v) || 1));
function scCestAdj(d) { const i = document.getElementById('scCestQty'); i.value = scCestClamp((parseInt(i.value) || 0) + d); scCestLive(); }
function scCestSet(v) { document.getElementById('scCestQty').value = scCestClamp(v); scCestLive(); }
function scCestMax()  { document.getElementById('scCestQty').value = _scCestMax; scCestLive(); }
function scCestLive() {
  const q = parseInt(document.getElementById('scCestQty').value) || 0, rest = _scCestMax - q;
  document.getElementById('scCestInfo').textContent = `su ${_scCestMax} nel Cestino · ${rest >= 0 ? 'restano ' + rest : 'troppi'}`;
  const ok = q >= 1 && q <= _scCestMax, btn = document.getElementById('scCestOk');
  btn.disabled = !ok; btn.style.opacity = ok ? '' : '.5';
}
async function scCestConferma() {
  const mv = getMagVirt(), q = parseInt(document.getElementById('scCestQty').value) || 0;
  if (!mv || q < 1 || q > _scCestMax) return;
  const a = getArt(_scCestArt);
  try {
    await apiFetch('POST', '/stock/scarica', { art_id:_scCestArt, mag_id:mv.id, qty:q, note:'Scarico dal cestino', data:nowRoma() });
    closeModal('modalScaricaCest');
    await loadPartial('spostamenti'); renderNonAssegnati();
    toast(`Scaricati ${q} ${a?.um || 'pz'} di "${a?.nome}" ✓` + (q === _scCestMax ? ' — l\'articolo resta nel catalogo' : ''));
  } catch(e) { toast(e.message || 'Errore imprevisto — riprova', true); }
}

// ─── FORM ARTICOLO: cambio categoria → aggiorna codice suggerito ───
async function onCatChange() {
  const catId = document.getElementById('artCat').value;
  const artEditId = document.getElementById('artEditId').value;
  if (!catId) {
    document.getElementById('artCodice').value='';
    document.getElementById('artCodiceHint').textContent='Seleziona prima la categoria';
    return;
  }
  if (artEditId) {
    // In modifica: non sovrascrivere il codice esistente, mostra solo il prefisso
    const cat = D.categorie.find(c=>c.id==catId);
    document.getElementById('artCodiceHint').textContent=`Prefisso categoria: ${cat?.prefisso||'?'}`;
    return;
  }
  try {
    const res = await apiFetch('GET',`/articoli/prossimo-codice/${catId}`);
    document.getElementById('artCodice').value = res.codice;
    document.getElementById('artCodiceHint').textContent = `Suggerito: ${res.codice} (modificabile)`;
  } catch(e) { toast(e.message||'Errore imprevisto — riprova', true); }
}

function openModalArtNew() {
  document.getElementById('artEditId').value='';
  document.getElementById('modalArtTitle').textContent='Nuovo Articolo';
  ['artNome','artNote','artCodice'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('artCodiceHint').textContent='Seleziona prima la categoria';
  document.getElementById('artCat').innerHTML='<option value="">— Seleziona categoria —</option>'+
    getCatNormali().map(c=>`<option value="${c.id}">[${h(c.prefisso)}] ${h(c.nome)}</option>`).join('');
  document.getElementById('artUm').value='pz';
  resetVar('art'); document.getElementById('artVarWrap').style.display='';
  openModal('modalArt');
}
function editArt(id) {
  const a=getArt(id);
  document.getElementById('artEditId').value=id;
  document.getElementById('modalArtTitle').textContent='Modifica Articolo';
  document.getElementById('artNome').value=a.nome;
  document.getElementById('artNote').value=a.note||'';
  document.getElementById('artCodice').value=a.codice||'';
  document.getElementById('artCat').innerHTML='<option value="">— Seleziona categoria —</option>'+
    getCatNormali().map(c=>`<option value="${c.id}"${c.id==a.cat_id?' selected':''}>[${h(c.prefisso)}] ${h(c.nome)}</option>`).join('');
  document.getElementById('artUm').value=a.um||'pz';
  const cat=getCat(a.cat_id);
  document.getElementById('artCodiceHint').textContent=`Prefisso categoria: ${cat?.prefisso||'?'}`;
  resetVar('art'); document.getElementById('artVarWrap').style.display='none';
  openModal('modalArt');
}
async function salvaArt() {
  const id=document.getElementById('artEditId').value;
  if (!id && document.getElementById('artVarOn')?.checked) {
    try {
      if (!(await creaModelloDa('art'))) return;
      closeModal('modalArt'); await loadPartial('articoli'); renderArticoli();
      if(curPage==='crea') renderCrea();
      toast('Articolo con varianti creato ✓ — i pezzi si creano al carico');
    } catch(e) {}
    return;
  }
  const cat_id=+document.getElementById('artCat').value||null;
  const codice=document.getElementById('artCodice').value.trim().toUpperCase();
  const nome=document.getElementById('artNome').value.trim();
  const um=document.getElementById('artUm').value;
  const note=document.getElementById('artNote').value.trim();
  if (!cat_id) { toast('Categoria obbligatoria',true); return; }
  if (!codice) { toast('Codice obbligatorio',true); return; }
  if (!nome)   { toast('Nome obbligatorio',true); return; }
  try {
    id ? await apiFetch('PUT',`/articoli/${id}`,{codice,nome,cat_id,um,note})
       : await apiFetch('POST','/articoli',{codice,nome,cat_id,um,note});
    closeModal('modalArt'); await loadPartial('articoli'); renderArticoli();
    if(curPage==='crea') renderCrea();
    toast(id?'Articolo aggiornato ✓':'Articolo creato ✓');
  } catch(e) { toast(e.message||'Errore imprevisto — riprova', true); }
}
async function delArt(id) {
  if (!await askConfirm('Eliminare questo articolo?', { ok: 'Elimina', danger: true })) return;
  try { await apiFetch('DELETE',`/articoli/${id}`); await loadPartial('articoli'); renderArticoli(); toast('Eliminato'); }
  catch(e) {}
}

function toggleArtExpand(btn) {
  const row = btn.closest('tr');
  const expandRow = row.nextElementSibling;
  if(!expandRow?.classList.contains('art-expand-row')) return;
  const isOpen = expandRow.classList.contains('open');
  expandRow.classList.toggle('open', !isOpen);
  btn.textContent = isOpen ? '▼' : '▲';
}

// ─── CATEGORIE ───
function renderCat() {
  document.getElementById('tbCat').innerHTML = D.categorie.length ? D.categorie.map(c=>{
    const n=D.articoli.filter(a=>a.cat_id==c.id).length;
    return `<tr>
      <td><span class="badge-codice" style="background:${c.colore};color:${inkOn(c.colore)}">${h(c.prefisso)}</span></td>
      <td><strong style="color:${c.colore}">${h(c.nome)}</strong></td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-ghost btn-xs" onclick="editCat(${c.id})">Modifica</button>
        <button class="btn btn-danger btn-xs" onclick="delCat(${c.id})" ${(c.prefisso==='BAU'||c.prefisso==='FLC'||c.prefisso==='FLCK')?'style="display:none"':''}">Elimina</button>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="3" class="empty">Nessuna categoria</td></tr>';
}
function aggiornaCodicePreview() {
  const pfx = document.getElementById('catPrefisso').value.toUpperCase() || '?';
  document.getElementById('catCodicePreview').textContent  = pfx+'1';
  document.getElementById('catCodicePreview2').textContent = pfx+'2';
}
function openModalCatNew() {
  document.getElementById('catEditId').value='';
  document.getElementById('modalCatTitle').textContent='Nuova Categoria';
  document.getElementById('catNome').value='';
  document.getElementById('catPrefisso').value='';
  aggiornaCodicePreview();
  selColor=COLORS[0]; buildSwatches(); openModal('modalCat');
}
function editCat(id) {
  const c=getCat(id);
  document.getElementById('catEditId').value=id;
  document.getElementById('modalCatTitle').textContent='Modifica Categoria';
  document.getElementById('catNome').value=c.nome;
  document.getElementById('catPrefisso').value=c.prefisso||'';
  aggiornaCodicePreview();
  selColor=c.colore; buildSwatches(); openModal('modalCat');
}
function buildSwatches() {
  document.getElementById('swatches').innerHTML=COLORS.flat().map(c=>
    `<div class="swatch${c===selColor?' sel':''}" style="background:${c}" onclick="pickColor('${c}',this)"></div>`
  ).join('');
  const pk=document.getElementById('colorPickerCat');
  if(pk){ pk.value=selColor; document.getElementById('colorPickerCatVal').textContent=selColor; }
}
function pickColor(c,el) {
  selColor=c;
  document.querySelectorAll('#swatches .swatch').forEach(s=>s.classList.remove('sel'));
  el.classList.add('sel');
  const pk=document.getElementById('colorPickerCat');
  if(pk){ pk.value=c; document.getElementById('colorPickerCatVal').textContent=c; }
}
function pickColorCustom(c) {
  selColor=c;
  document.querySelectorAll('#swatches .swatch').forEach(s=>s.classList.remove('sel'));
  document.getElementById('colorPickerCatVal').textContent=c;
}
function buildSwatchesMag() {
  document.getElementById('swatchesMag').innerHTML=COLORS.flat().map(c=>
    `<div class="swatch${c===selColorMag?' sel':''}" style="background:${c}" onclick="pickColorMag('${c}',this)"></div>`
  ).join('');
  const pk=document.getElementById('colorPickerMag');
  if(pk){ pk.value=selColorMag; document.getElementById('colorPickerMagVal').textContent=selColorMag; }
}
function pickColorMag(c,el) {
  selColorMag=c;
  document.querySelectorAll('#swatchesMag .swatch').forEach(s=>s.classList.remove('sel'));
  el.classList.add('sel');
  const pk=document.getElementById('colorPickerMag');
  if(pk){ pk.value=c; document.getElementById('colorPickerMagVal').textContent=c; }
}
function pickColorMagCustom(c) {
  selColorMag=c;
  document.querySelectorAll('#swatchesMag .swatch').forEach(s=>s.classList.remove('sel'));
  document.getElementById('colorPickerMagVal').textContent=c;
}
async function salvaCat() {
  const id=document.getElementById('catEditId').value;
  const nome=document.getElementById('catNome').value.trim();
  const prefisso=document.getElementById('catPrefisso').value.trim().toUpperCase();
  if (!nome)    { toast('Nome obbligatorio',true); return; }
  if (!prefisso){ toast('Prefisso obbligatorio',true); return; }
  const body={nome, colore:selColor, prefisso};
  try {
    id ? await apiFetch('PUT',`/categorie/${id}`,body) : await apiFetch('POST','/categorie',body);
    closeModal('modalCat'); await loadPartial('categorie'); renderCat();
    toast(id?'Categoria aggiornata ✓':'Categoria creata ✓');
  } catch(e) { toast(e.message||'Errore imprevisto — riprova', true); }
}
async function delCat(id) {
  if(!await askConfirm('Eliminare questa categoria?', { ok: 'Elimina', danger: true })) return;
  try { await apiFetch('DELETE',`/categorie/${id}`); await loadPartial('categorie'); renderCat(); toast('Eliminata'); }
  catch(e) {}
}

// ─── STORICO ───
async function risolviConflitti() {
  if (!_listaCorrente?.mag_dest_id) return;
  const destId = parseInt(_listaCorrente.mag_dest_id);
  const righeConConflitto = (_listaCorrente.righe||[]).filter(r =>
    (r.flags||[]).some(f => f.mag_id === destId && (f.qty_presa > 0 || f.qty_prevista > 0))
  );
  if (!righeConConflitto.length) return;
  try {
    for (const r of righeConConflitto) {
      await apiFetch('PUT', `/liste/flag/${r.id}/${destId}`, { qty_prevista: 0, qty_presa: 0 });
    }
    const l = await apiFetch('GET', '/liste/' + _listaCorrente.id);
    _listaCorrente = l;
    renderDettaglioRighe(l);
    aggiornaStatoLista(l);
    // Aggiorna elenco liste per rimuovere pill conflitto
    await load();
    toast('Flag conflittuali rimossi ✓');
  } catch(e) { toast('Errore durante la rimozione', true); }
}

async function loadMoreStorico() {
  const currentCount = D.spostamenti.length;
  const data = await apiFetch('GET', `/spostamenti?limit=200&offset=${currentCount}`);
  const nuovi = data.rows || data;
  D.spostamenti = D.spostamenti.concat(nuovi);
  D._spostamentiTotal = data.total || D._spostamentiTotal;
  renderStorico();
}

function renderStorico() {
  const selMag=document.getElementById('filterMagSto');
  const cv=selMag.value;
  selMag.innerHTML='<option value="">Tutti i magazzini</option>'+
    D.magazzini.map(m=>`<option value="${m.id}"${cv==m.id?' selected':''}>${h(m.nome)}</option>`).join('');
  const selCat=document.getElementById('filterCatSto');
  const ccv=selCat.value;
  selCat.innerHTML='<option value="">Tutte le categorie</option>'+
    D.categorie.map(c=>`<option value="${c.id}"${ccv==c.id?' selected':''}>[${h(c.prefisso)}] ${h(c.nome)}</option>`).join('');
  const selUt=document.getElementById('filterUtenteSto');
  const cuv=selUt.value;
  const utentiInSto=[...new Map(D.spostamenti.filter(x=>x.user_nome).map(x=>[x.user_id,x.user_nome])).entries()];
  selUt.innerHTML='<option value="">Tutti gli utenti</option>'+
    utentiInSto.map(([id,nome])=>`<option value="${id}"${cuv==id?' selected':''}>${h(nome)}</option>`).join('');
  const s=document.getElementById('searchSto').value.toLowerCase();
  const tf=document.getElementById('filterTipoSto').value;
  const mf=selMag.value;
  const uf=selUt.value;
  let list=D.spostamenti;
  if(s)  list=list.filter(x=>(getArt(x.art_id)?.nome||'').toLowerCase().includes(s)||(x.note||'').toLowerCase().includes(s)||(getArt(x.art_id)?.codice||'').toLowerCase().includes(s));
  if(tf) list=list.filter(x=>x.tipo===tf);
  if(mf) list=list.filter(x=>x.mag_from==mf||x.mag_to==mf);
  if(uf) list=list.filter(x=>x.user_id==uf);
  if(selCat.value) list=list.filter(x=>getArt(x.art_id)?.cat_id==selCat.value);
  list=[...list].sort((a,b)=>b.data.localeCompare(a.data));
  // Raggruppa per batch_id
  const isAdm = currentUser?.ruolo==='admin';
  const rows = [];
  const batchSeen = new Set();
  const magP = m => m ? `<span class="stock-pill mp">${h(m.nome)}</span>` : '<span class="cnt-dash">—</span>';
  const flow = (da, av) => `<div class="flow">${da?magP(da)+'<i>→</i>':'<i>→</i>'}${av?magP(av):''}${!da&&!av?'<span class="cnt-dash">—</span>':''}</div>`;
  const dataCell = x => `<td><span class="sto-dt">${fmtDtS(x.data)}${isAdm && x.user_nome ? `<small>${h(x.user_nome)}</small>` : ''}</span></td>`;
  for (const x of list) {
    if (x.batch_id) {
      if (batchSeen.has(x.batch_id)) continue;
      batchSeen.add(x.batch_id);
      const gruppo = list.filter(r => r.batch_id === x.batch_id);
      const da = getMag(x.mag_from), av = getMag(x.mag_to);
      const totPz = gruppo.reduce((s,r) => s+r.qty, 0);
      const inner = gruppo.map(r => {
        const ar = getArt(r.art_id);
        return `<tr style="background:var(--bg2)">
          <td><span class="sto-dt">${fmtDtS(r.data)}</span></td>
          <td><span class="badge tipo-spostamento">sposta</span></td>
          <td class="name">${codiceBadge(ar?.codice, ar ? getCat(ar.cat_id)?.colore : null)} <strong>${ar?h(ar.nome):'—'}</strong></td>
          <td>${flow(getMag(r.mag_from), getMag(r.mag_to))}</td>
          <td class="r"><span class="q-n">${r.qty}</span></td>
          <td></td>
        </tr>`;
      }).join('');
      const titolo = (x.note||'').startsWith('Lista:') ? 'lista '+(h(x.note).slice(7)) : (h(x.note)||'Operazione di massa');
      rows.push(`<tr class="sto-batch-row" onclick="toggleBatch(this)" style="cursor:pointer">
        ${dataCell(x)}
        <td><span class="badge" style="background:var(--teal-bg);color:var(--teal-dark);border:1px solid var(--teal-border)">${(x.note||'').startsWith('Lista:')?'lista':'operazione'}</span></td>
        <td class="name"><span class="batch-arrow" style="margin-right:6px;font-size:10px;color:var(--ink3)">▶</span><strong>${titolo}</strong><span class="nm-note">${gruppo.length} movimenti</span></td>
        <td>${flow(da, av)}</td>
        <td class="r"><span class="q-n">${totPz}</span><span class="q-u">pz</span></td>
        <td class="act">${isAdm?`<button class="btn btn-danger btn-xs ib" onclick="event.stopPropagation();undoBatch('${x.batch_id}')" title="Annulla l'operazione">↩</button>`:''}</td>
      </tr>
      <tr class="sto-batch-detail" style="display:none"><td colspan="6" style="padding:0">
        <table class="sto-inner" style="width:100%;table-layout:fixed"><colgroup><col style="width:158px"><col style="width:112px"><col><col style="width:230px"><col style="width:62px"><col style="width:62px"></colgroup><tbody>${inner}</tbody></table>
      </td></tr>`);
    } else {
      const a=getArt(x.art_id), da=getMag(x.mag_from), a2=getMag(x.mag_to);
      const canUndo = isAdm
        && !((x.note||'').startsWith('[ANNULLATO]'))
        && !isSpecialArt(x.art_id);
      const isBau = isBauleArt(x.art_id);
      const isFLC = isFlightcaseArt(x.art_id);
      const isFLCK = isFlckArt(x.art_id), kDef = isFLCK ? getFlck(x.art_id) : null;
      const isSpec = isBau || isFLC || isFLCK;
      const stoSpecial = isFLCK
        ? ` <span style="font-size:8px;background:${FLCK_COL}15;color:${FLCK_COL};border:1px solid ${FLCK_COL}33;padding:0 4px;border-radius:2px;font-family:'DM Mono',monospace;vertical-align:middle">FLCK</span>`
        : isBau
        ? ' <span style="font-size:8px;background:#92400e15;color:#92400e;border:1px solid #92400e33;padding:0 4px;border-radius:2px;font-family:\'DM Mono\',monospace;vertical-align:middle">BAU</span>'
        : isFLC
        ? ' <span style="font-size:8px;background:#6b4c6e15;color:#6b4c6e;border:1px solid #6b4c6e33;padding:0 4px;border-radius:2px;font-family:\'DM Mono\',monospace;vertical-align:middle">FLC</span>'
        : '';
      const stoClick = isSpec ? ` onclick="toggleStoExpand(this)" style="cursor:pointer"` : '';
      let stoExpandRow = '';
      if (isBau) {
        stoExpandRow = `<tr class="sto-batch-detail" style="display:none"><td colspan="6" style="padding:6px 12px 8px 24px">
          <div id="sto-bau-${x.art_id}" style="font-size:11px;color:#92400e"><span style="color:var(--ink3)">Caricamento…</span></div></td></tr>`;
      } else if (isFLC) {
        const fcDef = getFlightcaseDef(x.art_id);
        if (fcDef) {
          stoExpandRow = `<tr class="sto-batch-detail" style="display:none"><td colspan="6" style="padding:6px 12px 8px 24px;font-size:11px;color:#6b4c6e">
            Contiene: <strong>${h(fcDef.art_contenuto_nome||'—')}</strong> — ${fcDef.qty_caricata}/${fcDef.qty_max} caricati
          </td></tr>`;
        }
      }
      if (isFLCK) stoExpandRow = `<tr class="sto-batch-detail" style="display:none"><td colspan="6" style="padding:6px 12px 8px 24px">${flckContenutoHtml(kDef)}</td></tr>`;
      rows.push(`<tr${stoClick}>
        ${dataCell(x)}
        <td><span class="badge tipo-${x.tipo}">${x.tipo}</span></td>
        <td class="name" title="${a?h(a.nome):''}">${isSpec?'<span class="batch-arrow" style="margin-right:6px;font-size:10px;color:var(--ink3)">▶</span>':''}${codiceBadge(a?.codice, a ? getCat(a.cat_id)?.colore : null)} <strong>${a?h(a.nome):'—'}</strong>${stoSpecial}${x.note?`<span class="nm-note">${h(x.note)}</span>`:''}</td>
        <td>${flow(da, a2)}</td>
        <td class="r"><span class="q-n">${x.qty}</span><span class="q-u">${a?h(a.um):''}</span></td>
        <td class="act">${canUndo?`<button class="btn btn-danger btn-xs ib" onclick="event.stopPropagation();undoStorico(${x.id})" title="Annulla il movimento">↩</button>`:''}</td>
      </tr>${stoExpandRow}`);
    }
  }
  document.getElementById('tbSto').innerHTML = rows.length ? rows.join('') :
    '<tr><td colspan="6" class="empty">Nessun movimento</td></tr>';
  { const c=document.getElementById('cntSto'); if(c) c.textContent=`${list.length} movimenti`; }
  const lmBtn = document.getElementById('storicoLoadMore');
  const lmCnt = document.getElementById('storicoCount');
  if (lmBtn) {
    const total = D._spostamentiTotal || D.spostamenti.length;
    lmBtn.style.display = D.spostamenti.length < total ? '' : 'none';
    if (lmCnt) lmCnt.textContent = `${D.spostamenti.length} / ${total} movimenti`;
  }
}

function toggleBatch(row) {
  const detail = row.nextElementSibling;
  const arrow = row.querySelector('.batch-arrow');
  const open = detail.style.display !== 'none';
  detail.style.display = open ? 'none' : '';
  if (arrow) arrow.textContent = open ? '▶' : '▼';
}

function toggleStoExpand(row) {
  const detail = row.nextElementSibling;
  if (!detail?.classList.contains('sto-batch-detail')) return;
  const arrow = row.querySelector('.batch-arrow');
  const isOpen = detail.style.display !== 'none';
  detail.style.display = isOpen ? 'none' : '';
  if (arrow) arrow.textContent = isOpen ? '▶' : '▼';
  // Load BAU voci on first open
  if (!isOpen) {
    const bauDiv = detail.querySelector('[id^="sto-bau-"]');
    if (bauDiv && !bauDiv.dataset.loaded) {
      bauDiv.dataset.loaded = '1';
      const artId = bauDiv.id.split('-')[2];
      apiFetch('GET', `/bauli/${artId}/voci`).then(voci => {
        if (!voci.length) bauDiv.innerHTML = '<em style="color:var(--ink3)">Baule vuoto</em>';
        else bauDiv.innerHTML = '<table>' + voci.map(v =>
          `<tr><td style="width:30px;font-family:'DM Mono',monospace;font-weight:700;color:var(--teal-dark);padding:2px 6px">${v.qty}</td><td style="padding:2px 6px;font-size:11px">${h(v.nome)}</td></tr>`
        ).join('') + '</table>';
      }).catch(() => { bauDiv.innerHTML = '<span style="color:var(--red)">Errore</span>'; });
    }
  }
}

async function undoBatch(batchId) {
  const gruppo = D.spostamenti.filter(x => x.batch_id === batchId);
  if (!gruppo.length) { toast('Operazione non trovata', true); return; }
  if (gruppo.some(x => isSpecialArt(x.art_id))) {
    toast('Le operazioni su bauli e flight case non possono essere annullate dallo storico', true);
    return;
  }
  const x = gruppo[0];
  const da = getMag(x.mag_from), av = getMag(x.mag_to);
  const desc = `Annullare ${gruppo.length} spostamenti${da?' da '+da.nome:''}${av?' verso '+av.nome:''}?`;
  if (!await askConfirm(desc)) return;
  const data = nowRoma();
  const note = `[ANNULLATO] ${x.note||''}`.trim();
  try {
    for (const s of gruppo) {
      await apiFetch('POST', '/spostamenti', {
        art_id: s.art_id, mag_from: s.mag_to, mag_to: s.mag_from,
        qty: s.qty, note, data
      });
    }
    await loadPartial('spostamenti'); renderStorico();
    toast(`✓ ${gruppo.length} spostamenti annullati`);
  } catch(e) { toast(e.message||'Errore', true); }
}

// ─── STOCK ───
// ─── ANNULLA OPERAZIONE DA STORICO ───
async function undoStorico(spostId) {
  const x = D.spostamenti.find(s=>s.id===spostId);
  if(!x) { toast('Operazione non trovata',true); return; }
  if(isSpecialArt(x.art_id)) {
    toast('Le operazioni su bauli e flight case non possono essere annullate dallo storico', true);
    return;
  }
  const a = getArt(x.art_id);
  const da = getMag(x.mag_from), av = getMag(x.mag_to);
  let desc = '';
  if(x.tipo==='spostamento') desc = `Invertire lo spostamento di ${x.qty} "${a?.nome}" da ${da?.nome||'—'} a ${av?.nome||'—'}?`;
  else if(x.tipo==='carico')  desc = `Annullare il carico di ${x.qty} "${a?.nome}" in ${av?.nome||'—'}?`;
  else if(x.tipo==='scarico') desc = `Annullare lo scarico di ${x.qty} "${a?.nome}" da ${da?.nome||'—'}?`;
  else desc = `Annullare questa operazione?`;
  if(!await askConfirm(desc + '\nViene registrato un movimento inverso nello storico.')) return;
  const data = nowRoma();
  try {
    if(x.tipo==='spostamento') {
      await apiFetch('POST','/spostamenti',{art_id:x.art_id, mag_from:x.mag_to, mag_to:x.mag_from, qty:x.qty, note:`[ANNULLATO] #${spostId}`, data});
    } else if(x.tipo==='carico') {
      await apiFetch('POST','/stock/scarica',{art_id:x.art_id, mag_id:x.mag_to, qty:x.qty, note:`[ANNULLATO] #${spostId}`, data});
    } else if(x.tipo==='scarico') {
      await apiFetch('POST','/stock/carica',{art_id:x.art_id, mag_id:x.mag_from, qty:x.qty, note:`[ANNULLATO] #${spostId}`, data});
    }
    await loadPartial('spostamenti'); renderStorico();
    toast(`Operazione #${spostId} annullata ✓`);
  } catch(e){}
}

async function delArtNoStock(artId) {
  const a = getArt(artId);
  if (!await askConfirm(`Eliminare l'articolo "${a?.nome}"?
Questa azione è irreversibile.`, { ok: 'Elimina', danger: true })) return;
  try {
    await apiFetch('DELETE', `/articoli/${artId}`);
    await loadPartial('articoli');
    renderStock();
    if (curPage === 'crea') renderPage('crea');
    toast(`"${a?.nome}" eliminato ✓`);
  } catch(e) { toast(e.message||'Errore imprevisto — riprova', true); }
}
function renderStock() {
  const sm=document.getElementById('filterMagStock'), sc=document.getElementById('filterCatStock');
  const cmv=sm.value, ccv=sc.value;
  sm.innerHTML='<option value="">Tutti i magazzini</option>'+
    D.magazzini.map(m=>`<option value="${m.id}"${cmv==m.id?' selected':''}>${h(m.nome)}${m.virtuale?' 📦':''}</option>`).join('');
  sc.innerHTML='<option value="">Tutte le categorie</option>'+
    D.categorie.map(c=>`<option value="${c.id}"${ccv==c.id?' selected':''}>[${h(c.prefisso)}] ${h(c.nome)}</option>`).join('');
  const s=document.getElementById('searchStock').value.toLowerCase();
  const rows=[];   // una voce per articolo, con i magazzini in cui è presente
  D.articoli.forEach(a=>{
    if(s&&!a.nome.toLowerCase().includes(s)&&!a.codice.toLowerCase().includes(s)) return;
    if(sc.value&&a.cat_id!=sc.value) return;
    if(isSpecialArt(a.id)) return;   // nello stock solo gli articoli, non i contenitori
    const mags=[];
    D.magazzini.forEach(m=>{
      if(m.virtuale) return;
      if(sm.value&&m.id!=sm.value) return;
      const lib=getStock(a.id,m.id), cs=D._contMap?.[a.id]?.[m.id];
      const qty=lib+(cs?cs.tot:0);
      if(qty>0) mags.push({m,qty,lib,cs:cs?cs.case:[]});
    });
    if(mags.length) rows.push({a,mags,qty:mags.reduce((t,x)=>t+x.qty,0)});
  });
  const rowsSorted = raggruppaPezziStock(rows);
  document.getElementById('tbStock').innerHTML=rowsSorted.length?rowsSorted.map(r=>{
    if (r.g) return stockGruppoRow(r);
    const {a,mags,qty}=r;
    const cat=getCat(a.cat_id);
    const nCase=mags.reduce((n,x)=>n+caseTot(x.cs),0);
    const hasCase=nCase>0;
    const rowClick = hasCase ? ` onclick="toggleStockExpand(this)" style="cursor:pointer"` : '';
    let expandRow = '';
    if (hasCase) expandRow = `<tr class="art-expand-row"><td colspan="4" class="art-expand-cell">${mags.map(x=>(mags.length>1?`<div style="font-size:11px;font-weight:700;margin-top:4px">${h(x.m.nome)}</div>`:'')+caseBreakdown(x.lib,x.cs)).join('')}</td></tr>`;
    return `<tr${rowClick}>
      <td>${codiceBadge(a.codice, getCat(a.cat_id)?.colore)}</td>
      <td class="name" title="${h(a.nome)}"><strong>${h(a.nome)}</strong>${catPill(cat)}${varChip(a)}${hasCase?` <span class="var-chip">${nCase} nei case</span>`:''}${a.note?`<span class="nm-note">${h(a.note)}</span>`:''}</td>
      <td>${stockPills(mags)}</td>
      <td class="r"><span class="q-n">${qty}</span><span class="q-u">${h(a.um)}</span></td>
    </tr>${expandRow}`;
  }).join(''):'<tr><td colspan="4" class="empty">Nessuno stock trovato</td></tr>';
  { const c=document.getElementById('cntStock'); if(c) c.textContent=`${rows.length} articoli · ${rows.reduce((t,r)=>t+r.qty,0)} pz`; }

  renderCreaNoStock();
}

// ─── MODALS ───
// Ricerca + filtro categoria dentro un menu a tendina: nasconde le voci che non corrispondono; se resta una sola voce la seleziona
const _SEL_FILTRI = { flcArtContenuto: ['flcArtCat', 'flcArtSearch'], flckVoceArt: ['flckVoceArtCat', 'flckVoceArtSearch'], flckVoceMod: ['flckVoceModCat', 'flckVoceModSearch'] };
// Menù articolo con filtro categoria/testo: le voci vengono ricostruite (l'attributo `hidden` sulle <option> è ignorato da Safari/iPad).
// _selMaster conserva l'elenco completo di ogni menù, registrato da _riempiCatSel dopo averlo popolato.
const _selMaster = {};
function _riempiCatSel(catId, selId) {   // categorie presenti nelle voci del menu
  const c = document.getElementById(catId), sel = document.getElementById(selId); if (!c || !sel) return;
  const opts = [...sel.options];
  _selMaster[selId] = { ph: opts[0]?.textContent || '', items: opts.filter(o => o.value !== '').map(o => ({ v: o.value, t: o.textContent, c: o.dataset.cat })) };
  const ids = new Set(_selMaster[selId].items.map(o => o.c).filter(Boolean));
  c.innerHTML = '<option value="">Tutte le categorie</option>' + D.categorie.filter(x => ids.has(String(x.id))).map(x => `<option value="${x.id}">${h(x.nome)}</option>`).join('');
  const t = document.getElementById(_SEL_FILTRI[selId][1]); if (t) t.value = '';
}
function filtraSelect(selId) {
  const sel = document.getElementById(selId), m = _selMaster[selId]; if (!sel || !m) return;
  const [catId, txtId] = _SEL_FILTRI[selId];
  const cat = document.getElementById(catId)?.value || '';
  const q = (document.getElementById(txtId)?.value || '').trim().toLowerCase();
  const prev = sel.value;
  const vis = m.items.filter(o => (!q || o.t.toLowerCase().includes(q)) && (!cat || o.c === cat));
  sel.innerHTML = `<option value="">${h(m.ph)}</option>` + vis.map(o => `<option value="${h(o.v)}" data-cat="${h(o.c || '')}">${h(o.t)}</option>`).join('');
  sel.value = vis.some(o => o.v === prev) ? prev : '';
  if ((q || cat) && vis.length === 1) sel.value = vis[0].v;
  if (sel.onchange) sel.onchange();
}
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('open');
  const cb = el.dataset.onclose;
  if (cb && typeof window[cb] === 'function') window[cb]();
}

// ─── DIALOGHI (al posto di confirm / prompt del browser) ───
// askConfirm(msg, {ok, danger}) → true/false · askPrompt(msg, valore, {ok, type}) → testo oppure null
// La prima riga del messaggio (se breve) diventa il titolo, le altre il testo.
let _dlgDone = null, _dlgCancelVal = false;
function _dlg(msg, { ok = 'Conferma', danger = false, prompt = null } = {}) {
  _dlgEnd(_dlgCancelVal);                                    // una sola finestra alla volta
  const righe = String(msg).split('\n'), breve = righe[0].length <= 90;
  document.getElementById('dlgTitle').textContent = breve ? righe[0] : 'Conferma';
  const corpo = document.getElementById('dlgMsg');
  corpo.textContent = (breve ? righe.slice(1) : righe).join('\n').trim();
  corpo.style.display = corpo.textContent ? '' : 'none';
  const inp = document.getElementById('dlgInput');
  inp.style.display = prompt ? '' : 'none';
  if (prompt) { inp.type = prompt.type || 'text'; inp.value = prompt.value ?? ''; }
  const btn = document.getElementById('dlgOk');
  btn.textContent = ok;
  btn.className = 'btn ' + (danger ? 'dlg-danger' : 'btn-dark');
  _dlgCancelVal = prompt ? null : false;
  openModal('modalDialog');
  setTimeout(() => prompt ? (inp.focus(), inp.select()) : btn.focus(), 50);
  return new Promise(res => { _dlgDone = res; });
}
function askConfirm(msg, opts) { return _dlg(msg, opts); }
function askPrompt(msg, valore, { ok = 'Salva', type } = {}) { return _dlg(msg, { ok, prompt: { value: valore, type } }); }
function _dlgEnd(v) { const f = _dlgDone; _dlgDone = null; if (f) f(v); }
function _dlgOk() {
  const inp = document.getElementById('dlgInput');
  _dlgEnd(inp.style.display === 'none' ? true : inp.value);
  closeModal('modalDialog');
}
function _dlgClosed() { _dlgEnd(_dlgCancelVal); }            // chiuso con Annulla, ✕, fuori dal riquadro o tasto indietro
document.addEventListener('keydown', e => {
  if (!document.getElementById('modalDialog').classList.contains('open')) return;
  if (e.key === 'Escape') closeModal('modalDialog');
  else if (e.key === 'Enter' && document.activeElement?.id !== 'dlgCancel') { e.preventDefault(); _dlgOk(); }
});

// Click sull'overlay (fuori dal modal) chiude
document.addEventListener('click', e => {
  if (e.target.classList.contains('overlay') && e.target.classList.contains('open')) {
    closeModal(e.target.id);
  }
});

// ─── CLOCK ───
setInterval(()=>{
  const n=new Date();
  document.getElementById('clock').textContent=String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0');
},1000);

// ─── POLLING aggiornamento in tempo reale (ogni 15s) ───
let _pollTs = 0;
let _pollPaused = false;

async function pollUpdate() { }

// (polling disattivato: versione offline)
// First ping right after load


// ─── SANITIZZAZIONE ───
function h(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#x27;');
}

// ─── ASPETTO: stile · struttura · colore · modo ───
const THEMES = [
  {id:'',       name:'Whiskey', c:'#e6a830'},
  {id:'forest', name:'Forest',  c:'#1D9E75'},
  {id:'rose',   name:'Rose',    c:'#D4537E'},
  {id:'ocean',  name:'Ocean',   c:'#378ADD'},
  {id:'sand',   name:'Sand',    c:'#c9a96e'},
  {id:'red',    name:'Pure Red',c:'#dc2626'},
  {id:'cemento',name:'Cemento', c:'#8a8a8a'},
  {id:'neutro', name:'Neutro',  c:'#d8d8dc'},
];
const ASP_STILI = ['', 'cr', 'neu', 'term', 'sheet', 'w95'];
function _lsSet(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }
function _lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
function _setBodyAttr(name, val) { if (val) document.body.setAttribute(name, val); else document.body.removeAttribute(name); }

function setTheme(theme) {
  _setBodyAttr('data-theme', theme);
  _lsSet('wf-theme', theme);
  aspettoRefresh();
}
// Modo scuro effettivo: lo stile Anni 90 resta sempre chiaro
function _applyDarkClass() {
  const s = _lsGet('wf-dark');
  let d = s === '1' || (s !== '0' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (document.body.getAttribute('data-style') === 'w95') d = false;
  document.body.classList.toggle('dark', d);
}
function setStile(stile) {
  if (!ASP_STILI.includes(stile)) stile = '';
  _setBodyAttr('data-style', stile);
  _lsSet('wf-style', stile);
  _applyDarkClass();
  aspettoRefresh();
}
function setStruttura(s) {
  s = (s === 'top') ? 'top' : '';
  _setBodyAttr('data-struct', s);
  _lsSet('wf-struct', s);
  aspettoRefresh();
  aspettoScrollNav();
}
// Modo: 'l' chiaro, 'd' scuro, 'a' automatico (segue il sistema)
function setModo(m) {
  _lsSet('wf-dark', m === 'a' ? '' : (m === 'd' ? '1' : '0'));
  _applyDarkClass();
  aspettoRefresh();
}

function aspettoRefresh() {
  const b = document.body, theme = b.getAttribute('data-theme') || '';
  const modo = _lsGet('wf-dark') === '1' ? 'd' : _lsGet('wf-dark') === '0' ? 'l' : 'a';
  const on = (sel, val) => document.querySelectorAll(sel).forEach(el => {
    const sel_ = el.dataset.v === val;
    el.classList.toggle('on', sel_);
    el.setAttribute('aria-pressed', sel_);
  });
  on('.asp-st', b.getAttribute('data-style') || '');
  on('.asp-seg:not(#aspModo) button', b.getAttribute('data-struct') || '');
  on('#aspModo button', modo);
  on('.asp-c', theme);
  const t = THEMES.find(x => x.id === theme) || THEMES[0];
  const btn = document.getElementById('aspettoBtn');
  if (btn) btn.style.setProperty('--asw', t.c);
}
function aspettoScrollNav() {
  if (document.body.getAttribute('data-struct') !== 'top') return;
  const a = document.querySelector('.aside-nav .nav-btn.active');
  if (a && a.scrollIntoView) a.scrollIntoView({ inline: 'center', block: 'nearest' });
}
let _aspW = 0;
function toggleAspetto(ev) {
  if (ev) ev.stopPropagation();
  const p = document.getElementById('aspettoPanel');
  if (p.classList.contains('open')) { chiudiAspetto(); return; }
  closeMobileNav();
  aspettoRefresh();
  p.classList.add('open');
  document.getElementById('aspettoScrim').classList.add('open');
  document.getElementById('aspettoBtn').setAttribute('aria-expanded', 'true');
  _aspW = window.innerWidth;
  if (window.innerWidth > 768) {
    const r = document.getElementById('aspettoBtn').getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight, m = 12;
    let left, top;
    if (document.body.getAttribute('data-struct') === 'top') { left = r.right - w; top = r.bottom + 8; }
    else { left = r.left; top = r.top - h - 8; }
    left = Math.max(m, Math.min(left, window.innerWidth - w - m));
    top = Math.max(m, Math.min(top, window.innerHeight - h - m));
    p.style.cssText = 'left:' + left + 'px;top:' + top + 'px;';
  } else {
    p.style.cssText = '';
  }
}
function chiudiAspetto() {
  document.getElementById('aspettoPanel').classList.remove('open');
  document.getElementById('aspettoScrim').classList.remove('open');
  const btn = document.getElementById('aspettoBtn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') chiudiAspetto(); });
window.addEventListener('resize', () => { if (window.innerWidth !== _aspW) chiudiAspetto(); });

function initTheme() {
  document.getElementById('aspCols').innerHTML = THEMES.map(t =>
    `<button class="asp-c" data-v="${t.id}" style="--c:${t.c}" title="${t.name}" aria-label="${t.name}" onclick="setTheme('${t.id}')"></button>`).join('');
  setStile(_lsGet('wf-style'));
  setStruttura(_lsGet('wf-struct'));
  setTheme(_lsGet('wf-theme'));
  // Modo automatico: segue il cambio di tema del sistema
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onMq = () => { if (!_lsGet('wf-dark')) _applyDarkClass(); };
  if (mq.addEventListener) mq.addEventListener('change', onMq);
  aspettoRefresh();
}

// ─── LISTE DI CARICO ───
let _listaCorrente = null;
let _listeElenco = [];

async function renderListe() {
  const el = document.getElementById('listeElenco');
  const det = document.getElementById('listaDettaglio');
  if (!el) return;
  // Se c'è una lista aperta, aggiorna il dettaglio invece di tornare all'elenco
  if (_listaCorrente) {
    const l = await apiFetch('GET', '/liste/' + _listaCorrente.id);
    _listaCorrente = l;
    renderDettaglioRighe(l);
    return;
  }
  if (det) det.style.display = 'none';
  el.style.display = '';

  const liste = await apiFetch('GET', '/liste');
  _listeElenco = liste;
  const hdr = document.getElementById('listeElencoHeader');
  if (!liste.length) {
    if (hdr) hdr.style.display = 'none';
    el.innerHTML = '<div class="empty" style="padding:40px;text-align:center;color:var(--ink3)">Nessuna lista ancora.<br><button class="btn btn-dark" style="margin-top:12px" onclick="openModalListaNew()">+ Nuova lista</button></div>';
    return;
  }
  if (hdr) hdr.style.display = '';
  _renderListeBoard();
}

// ── Tabellone liste: 3 colonne per stato (schede su schermi stretti) ──
let _listeTab = 'completa';
function setListeTab(st) { _listeTab = st; _renderListeBoard(); }

function _renderListeBoard() {
  const el = document.getElementById('listeElenco');
  if (!el) return;
  const liste = _listeElenco || [];
  const stOf = l => l.stato_display || l.stato;
  const cols = [
    { st: 'completa',        titolo: 'Pronte',          tab: 'Pronte',    col: 'var(--teal)' },
    { st: 'in-preparazione', titolo: 'In preparazione', tab: 'In prep.',  col: 'var(--amber)' },
    { st: 'inattiva',        titolo: 'Inattive',        tab: 'Inattive',  col: 'var(--ink3)' }
  ];
  const by = st => liste.filter(l => stOf(l) === st);
  const card = l => {
    const st = stOf(l);
    const veloce = l.tipo === 'veloce';
    const tot = l.tot_richiesta || 0, pr = l.tot_pronti || 0;
    const pct = tot ? Math.min(100, Math.round(pr / tot * 100)) : 0;
    const colore = st === 'completa' ? 'var(--teal)' : st === 'in-preparazione' ? 'var(--amber)' : 'var(--ink3)';
    const src = (l.mag_src_nomi || '').split('|').filter(Boolean).join(' + ');
    const dest = l.mag_dest_nome || (veloce ? '?' : '');
    const rotta = src ? `${src} → ${dest || '—'}` : (l.mag_dest_nome ? '→ ' + l.mag_dest_nome : 'Nessuna destinazione');
    let azione;
    if (st === 'completa') {
      azione = (veloce && !l.mag_dest_id)
        ? `<button class="lk-btn lk-ask" onclick="event.stopPropagation();scegliDestVeloce(${l.id})">Scegli destinazione</button>`
        : `<button class="lk-btn lk-go" onclick="event.stopPropagation();eseguiDaCard(${l.id})">⇄ Esegui spostamento</button>`;
    } else if (st === 'in-preparazione') {
      azione = `<button class="lk-btn lk-prep" onclick="event.stopPropagation();apriLista(${l.id})">Continua</button>`;
    } else {
      azione = `<button class="lk-btn lk-idle" onclick="event.stopPropagation();apriLista(${l.id})">Inizia a preparare</button>`;
    }
    const admin = currentUser?.ruolo === 'admin';
    return `<div class="lk-card${st==='completa'?' pronta':''}" onclick="apriLista(${l.id})">
      <div class="lk-card-top">
        <div class="lk-ring" style="--p:${pct};--c:${colore}"><span>${pct}%</span></div>
        <div class="lk-info">
          <div class="lk-nome">${h(l.nome)}${veloce?' <span class="tipo-badge-prov">veloce</span>':''}</div>
          <div class="lk-rotta">${h(rotta)}</div>
          <div class="lk-meta">${l.n_righe} ${l.n_righe===1?'articolo':'articoli'} · ${pr} / ${tot} pz</div>
          <div class="lk-meta">${h(l.creato_da_nome||'—')} · ${l.creato_il?l.creato_il.slice(0,10):'—'}</div>
        </div>
      </div>
      <div class="lk-foot">
        ${azione}
        <div class="lk-tools" onclick="event.stopPropagation()">
          <button class="lk-ico" title="Modifica" aria-label="Modifica lista" onclick="openModalListaEdit(${l.id},'${h(l.nome)}',${l.mag_dest_id||'null'},'${h(l.note||'')}','${l.tipo||'normale'}')">✎</button>
          ${admin?`<button class="lk-ico lk-del" title="Elimina" aria-label="Elimina lista" onclick="eliminaLista(${l.id})">🗑</button>`:''}
        </div>
      </div>
    </div>`;
  };
  if (!cols.some(c => c.st === _listeTab)) _listeTab = 'completa';
  const tabs = `<div class="lk-tabs">` + cols.map(c =>
    `<button class="lk-tab${c.st===_listeTab?' on':''}" onclick="setListeTab('${c.st}')"><i style="background:${c.col}"></i>${c.tab}<span>${by(c.st).length}</span></button>`
  ).join('') + `</div>`;
  const board = `<div class="lk-board">` + cols.map(c => {
    const items = by(c.st);
    return `<div class="lk-col${c.st===_listeTab?' active':''}">
      <div class="lk-col-h"><i style="background:${c.col}"></i>${c.titolo}<span>${items.length}</span></div>
      ${items.map(card).join('') || '<div class="lk-empty">nessuna lista</div>'}
    </div>`;
  }).join('') + `</div>`;
  el.innerHTML = `<div class="lk-wrap">${tabs}${board}</div>`;
}

// Esegui direttamente dalla scheda: apre la lista e avvia il flusso di esecuzione
async function eseguiDaCard(id) {
  await apriLista(id);
  await eseguiLista();
}

async function apriLista(id) {
  const lista = await apiFetch('GET', '/liste/' + id);
  _listaCorrente = lista;
  document.getElementById('listeElenco').style.display = 'none';
  const leh = document.getElementById('listeElencoHeader');
  if (leh) leh.style.display = 'none';
  const det = document.getElementById('listaDettaglio');
  det.style.display = '';
  document.getElementById('listaDetNome').textContent = lista.nome;
  const tipoBadgeEl = document.getElementById('listaDetTipoBadge');
  if (tipoBadgeEl) tipoBadgeEl.style.display = lista.tipo === 'veloce' ? '' : 'none';
  const statoEl = document.getElementById('listaDetStato');
  statoEl.textContent = lista.stato;
  statoEl.className = 'lista-stato ' + lista.stato;
  _setListaMeta(lista);
  if (!_giro || _giro.listaId !== lista.id) _giroInit(lista.id);
  renderDettaglioRighe(lista);
  aggiornaStatoLista(lista);
  // Mostra "+ articolo" solo per liste normali
  const btnAggArt = document.querySelector('.lista-btn-articolo');
  if (btnAggArt) btnAggArt.style.display = lista.tipo === 'veloce' ? 'none' : '';
}

function chiudiDettaglioLista() {
  _listaCorrente = null;
  document.getElementById('listeElenco').style.display = '';
  document.getElementById('listaDettaglio').style.display = 'none';
  // Ripristina visibilità header (bottone + Nuova lista)
  const leh = document.getElementById('listeElencoHeader');
  if (leh) {
    const liste = document.querySelectorAll('#listeElenco .lk-card');
    leh.style.display = liste.length ? '' : 'none';
  }
  renderListe();
}

// Magazzino/i di partenza di una lista (dai flag)
function _listaSorgenti(lista) {
  const m = new Map();
  (lista.righe || []).forEach(r => (r.flags || []).forEach(f => { if (f.qty_presa > 0) m.set(f.mag_id, f.mag_nome); }));
  return [...m].map(([id, nome]) => ({ id, nome }));
}

function _setListaMeta(lista) {
  const src = lista.tipo === 'veloce' ? _listaSorgenti(lista) : [];
  const chip = (t, extra) => `<span class="lk-chip"${extra||''}>${t}</span>`;
  const tot = (lista.righe||[]).reduce((n,r) => n + (r.qty_richiesta||0), 0);
  const pr = (lista.righe||[]).reduce((n,r) => n + Math.min(r.qty_richiesta||0, (r.flags||[]).reduce((a,f)=>a+(f.qty_presa||0),0)), 0);
  let html = '';
  if (src.length) html += chip('Da ' + h(src.map(s => s.nome).join(' + '))) + ' → ';
  html += lista.mag_dest_nome ? chip(h(lista.mag_dest_nome)) : chip('Nessuna destinazione', ' style="border-style:dashed"');
  if (tot) html += ' ' + chip(pr + ' / ' + tot + ' pz');
  if (lista.note) html += ' <span>' + h(lista.note) + '</span>';
  document.getElementById('listaDetMeta').innerHTML = html;
}

function renderDettaglioRighe(lista) {
  _setListaMeta(lista);
  if (lista.tipo !== 'veloce') { _renderGiro(lista); return; }
  _renderVeloce(lista);
}

// ── Lista veloce: stessa grafica delle liste normali, una sola schermata ──
async function lsQtyV(rigaId, d) {
  const r = (_listaCorrente.righe || []).find(x => x.id === rigaId);
  if (!r) return;
  const nq = Math.max(1, r.qty_richiesta + d);
  if (nq === r.qty_richiesta) return;
  try {
    await apiFetch('PUT', `/liste/righe/${rigaId}`, { qty_richiesta: nq });
    await _giroReload();
  } catch(e) { toast(e.message, true); }
}
function _renderVeloce(lista) {
  const el = document.getElementById('listaDetRighe');
  const warn = document.getElementById('listaConflittoWarn');
  if (warn) warn.style.display = 'none';
  const righe = lista.righe || [];
  const src = _listaSorgenti(lista);
  const srcIds = src.map(s => s.id);
  const destId = lista.mag_dest_id ? parseInt(lista.mag_dest_id) : null;
  const totPz = righe.reduce((n, r) => n + r.qty_richiesta, 0);
  const rows = sortBauliFirst(righe, r => r.art_id).map(r => {
    const f0 = (r.flags || []).find(f => f.qty_presa > 0);
    const stock = f0 ? ((r.stock || []).find(s => s.mag_id === f0.mag_id)?.qty || 0) : 0;
    return `<div class="ph-row">
      <div class="ph-r-main">
        <div class="ph-r-n">${h(r.art_nome)}</div>
        <div class="ph-r-s">${h(r.art_codice)}${f0 ? ' · da ' + h(f0.mag_nome) + ' · disp. ' + stock : ''}${r.note_riga ? ' · ' + h(r.note_riga) : ''}</div>
      </div>
      <div class="ph-q"><button onclick="lsQtyV(${r.id},-1)" aria-label="Meno">−</button><button class="ph-qn" onclick="modificaRiga(${r.id},${r.qty_richiesta},'${h(r.note_riga || '')}')" aria-label="Modifica quantità">${r.qty_richiesta}</button><button onclick="lsQtyV(${r.id},1)" aria-label="Più">+</button></div>
      <button class="gr-ico gr-del ph-del" aria-label="Rimuovi dalla lista" onclick="eliminaRiga(${r.id})">✕</button>
    </div>`;
  }).join('');
  if (!righe.length) {
    el.innerHTML = '<div class="empty" style="padding:30px;text-align:center;color:var(--ink3)">Lista vuota. Aggiungi articoli dal contenuto di un magazzino con "Aggiungi a lista veloce".</div>';
    return;
  }
  const conflitto = destId && srcIds.includes(destId);
  const pronto = !!destId && !conflitto && src.length > 0;
  let motivo = '';
  if (!destId) motivo = 'Scegli la destinazione';
  else if (conflitto) motivo = 'La destinazione coincide con la partenza';
  const destOpts = '<option value="">— Scegli la destinazione —</option>' +
    getMagReali().filter(m => !srcIds.includes(m.id)).map(m => `<option value="${m.id}"${m.id === destId ? ' selected' : ''}>${h(m.nome)}</option>`).join('');
  el.innerHTML = `<div class="ph-wrap">
    <div class="ph-hint">${src.length ? 'Parte da <b>' + h(src.map(s => s.nome).join(' + ')) + '</b>. ' : ''}Gli articoli sono già pronti: scegli la destinazione e sposta.</div>
    <div class="ph-rows">${rows}</div>
    <div class="ph-foot ph-cons">
      <div class="ph-foot-t"><div class="ph-foot-a">${righe.length} ${righe.length === 1 ? 'articolo' : 'articoli'} · ${totPz} pz</div>
        <select class="finput ph-dest" onchange="giroSetDest(this.value)">${destOpts}</select></div>
      <div class="gr-slide${pronto ? '' : ' off'}" id="grSlide" data-on="${pronto ? 1 : 0}">
        <button class="gr-knob" aria-label="Esegui lo spostamento" ${pronto ? '' : 'disabled'}>${pronto ? '→' : '🔒'}</button>
        <span>${pronto ? 'Scorri per eseguire lo spostamento' : h(motivo)}</span>
      </div>
    </div>
  </div>`;
  _giroBindSlider();
}

// ─── DETTAGLIO LISTA A 4 FASI (liste normali) ───
// 1 Articoli → 2 Provenienza → 3 Giro → 4 Carico.
// La lista degli articoli è sempre visibile. Per ogni (articolo, magazzino):
//   qty_prevista = quanto si prevede di prendere da lì (fase 2)
//   qty_presa    = quanto è stato caricato/spuntato (fase 4), sempre <= qty_prevista
// Il giro (ordine dei magazzini) è salvato sul dispositivo; con una sola sorgente la fase 3 si salta.
let _giro = null;
function _giroInit(listaId) {
  let tappe = [];
  try { tappe = JSON.parse(localStorage.getItem('wf-giro-' + listaId) || '[]') || []; } catch(e) {}
  _giro = { listaId, tappe, fase: null, newRiga: null };
}
function _giroSave() {
  try { localStorage.setItem('wf-giro-' + _giro.listaId, JSON.stringify(_giro.tappe)); } catch(e) {}
}
function _giroMagNome(id) { return getMag(id)?.nome || ('Magazzino ' + id); }
function _giroMagCol(id) { return getMag(id)?.colore || '#8c8278'; }

function _lsCalc(lista) {
  const destId = lista.mag_dest_id ? parseInt(lista.mag_dest_id) : null;
  const info = (lista.righe || []).map(r => {
    const flags = (r.flags || []).filter(f => f.qty_prevista > 0);
    const valid = flags.filter(f => f.mag_id !== destId);
    const plan = valid.reduce((s, f) => s + f.qty_prevista, 0);
    const taken = valid.reduce((s, f) => s + Math.min(f.qty_presa, f.qty_prevista), 0);
    return { r, valid, plan, taken, missing: Math.max(0, r.qty_richiesta - plan), conflict: flags.some(f => f.mag_id === destId) };
  });
  const used = [];
  info.forEach(x => x.valid.forEach(f => { if (!used.includes(f.mag_id)) used.push(f.mag_id); }));
  const tappe = _giro.tappe.filter(id => used.includes(id));
  used.forEach(id => { if (!tappe.includes(id)) tappe.push(id); });
  const stops = tappe.map(id => {
    const voci = [];
    info.forEach(x => { const f = x.valid.find(f => f.mag_id === id); if (f) voci.push({ x, f }); });
    const done = voci.length > 0 && voci.every(v => v.f.qty_presa >= v.f.qty_prevista);
    return { id, voci, done, nDone: voci.filter(v => v.f.qty_presa >= v.f.qty_prevista).length };
  });
  const planComplete = info.length > 0 && info.every(x => x.missing <= 0);
  return {
    destId, info, tappe, stops, planComplete,
    planAny: info.some(x => x.plan > 0),
    allTaken: planComplete && stops.every(s => s.done),
    conflict: info.some(x => x.conflict),
    totReq: info.reduce((n, x) => n + x.r.qty_richiesta, 0),
    totTaken: info.reduce((n, x) => n + Math.min(x.taken, x.r.qty_richiesta), 0)
  };
}

async function _giroReload() {
  const main = document.querySelector('main');
  const t = main ? main.scrollTop : 0;
  const l = await apiFetch('GET', '/liste/' + _listaCorrente.id);
  _listaCorrente = l;
  renderDettaglioRighe(l);
  aggiornaStatoLista(l);
  if (main) main.scrollTop = t;
}
function _giroRender() { renderDettaglioRighe(_listaCorrente); }

// ── navigazione tra le fasi ──
function lsGo(n) {
  const c = _lsCalc(_listaCorrente);
  if (n >= 2 && !c.info.length) { toast('Aggiungi prima almeno un articolo', true); n = 1; }
  if (n >= 3 && !c.planComplete) { toast('Prima decidi da dove prendere tutti gli articoli', true); n = 2; }
  if (_giro.fase === 3 && n > 3) _giroConferma(c);
  _giro.fase = n;
  _giro.newRiga = null;
  _giroRender();
  const main = document.querySelector('main');
  if (main) main.scrollTop = 0;
}
function lsAvanti() {
  const c = _lsCalc(_listaCorrente);
  let n = _giro.fase + 1;
  if (n === 3 && c.tappe.length <= 1) n = 4;
  lsGo(Math.min(4, n));
}
function lsIndietro() {
  const c = _lsCalc(_listaCorrente);
  let n = _giro.fase - 1;
  if (n === 3 && c.tappe.length <= 1) n = 2;
  lsGo(Math.max(1, n));
}

// ── fase 1: quantità richiesta ──
async function _lsApplyQty(rigaId, nq) {
  const r = (_listaCorrente.righe || []).find(x => x.id === rigaId);
  if (!r) return;
  const stockTot = (r.stock || []).reduce((n, s) => n + s.qty, 0);
  if (stockTot && nq > stockTot) { toast('Disponibili in totale: ' + stockTot, true); return; }
  try {
    await apiFetch('PUT', `/liste/righe/${rigaId}`, { qty_richiesta: nq });
    // se si scende sotto la quantità già assegnata, si riduce l'ultima provenienza
    let eccesso = (r.flags || []).reduce((s, f) => s + f.qty_prevista, 0) - nq;
    for (const f of [...(r.flags || [])].reverse()) {
      if (eccesso <= 0) break;
      if (f.qty_prevista <= 0) continue;
      const t = Math.min(eccesso, f.qty_prevista);
      await apiFetch('PUT', `/liste/flag/${rigaId}/${f.mag_id}`, { qty_prevista: f.qty_prevista - t });
      eccesso -= t;
    }
    await _giroReload();
  } catch(e) { toast(e.message, true); }
}
function lsQty(rigaId, d) {
  const r = (_listaCorrente.righe || []).find(x => x.id === rigaId);
  if (!r) return;
  const nq = Math.max(1, r.qty_richiesta + d);
  if (nq === r.qty_richiesta) return;
  _lsApplyQty(rigaId, nq);
}

// ── fase 2: da dove prendere ──
async function lsFonte(rigaId, magId, mode) {
  const c = _lsCalc(_listaCorrente);
  const x = c.info.find(i => i.r.id === rigaId);
  if (!x) return;
  const stock = (x.r.stock || []).find(s => s.mag_id === magId)?.qty || 0;
  const cur = x.valid.find(f => f.mag_id === magId)?.qty_prevista || 0;
  const resto = x.r.qty_richiesta - x.plan;
  let nv;
  if (mode === 't') nv = cur > 0 ? 0 : Math.min(stock, resto);
  else nv = Math.max(0, Math.min(Math.max(stock, cur), cur + mode, cur + resto));
  if (nv === cur) { if (mode === 't' && cur === 0) toast('Questo articolo è già assegnato per intero', true); return; }
  try {
    await apiFetch('PUT', `/liste/flag/${rigaId}/${magId}`, { qty_prevista: nv });
    await _giroReload();
  } catch(e) { toast(e.message, true); }
}

// ── fase 3: ordine dei magazzini ──
function lsMove(id, d) {
  const c = _lsCalc(_listaCorrente);
  const a = [...c.tappe], i = a.indexOf(id), j = i + d;
  if (i < 0 || j < 0 || j >= a.length) return;
  [a[i], a[j]] = [a[j], a[i]];
  _giro.tappe = a;
  _giroSave();
  _giroRender();
}

// ── fase 4: spunta dei pezzi caricati ──
async function lsTick(rigaId, magId) {
  const r = (_listaCorrente.righe || []).find(x => x.id === rigaId);
  const f = r && (r.flags || []).find(f => f.mag_id === magId);
  if (!f) return;
  const nv = f.qty_presa >= f.qty_prevista ? 0 : f.qty_prevista;
  try {
    await apiFetch('PUT', `/liste/flag/${rigaId}/${magId}`, { qty_presa: nv });
    await _giroReload();
  } catch(e) { toast(e.message, true); }
}
function lsVaiTappa(id) {
  const el = document.getElementById('lsg-' + id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function giroSetDest(v) {
  if (!v) return;
  try {
    await apiFetch('PUT', '/liste/' + _listaCorrente.id, { mag_dest_id: parseInt(v) });
    await _giroReload();
    await load();
  } catch(err) { toast(err.message, true); }
}

async function giroEsegui() {
  const l = _listaCorrente;
  if (!l) return;
  if (l.tipo === 'veloce') {
    try {
      const r = await apiFetch('POST', `/liste/${l.id}/esegui`, { mag_dest_id: parseInt(l.mag_dest_id) });
      await loadPartial('spostamenti');
      playSpostamentoSound();
      toast(`✓ ${r.spostamenti} spostamenti registrati`);
      _listaCorrente = null;
      chiudiDettaglioLista();
      renderListe();
    } catch(err) { toast(err.message, true); _giroRender(); }
    return;
  }
  try {
    const r = await apiFetch('POST', `/liste/${l.id}/esegui`);
    await loadPartial('spostamenti');
    playSpostamentoSound();
    toast(`✓ ${r.spostamenti} spostamenti registrati`);
    _giro.fase = null; _giro.newRiga = null;
    apriLista(l.id);
  } catch(err) { toast(err.message, true); _giroRender(); }
}

function _giroBindSlider() {
  const tr = document.getElementById('grSlide');
  if (!tr || tr.dataset.on !== '1') return;
  const kn = tr.querySelector('.gr-knob');
  if (!kn) return;
  let x0 = null, max = 0, dx = 0;
  kn.onpointerdown = e => { x0 = e.clientX; dx = 0; max = tr.clientWidth - kn.offsetWidth - 12; kn.setPointerCapture(e.pointerId); kn.style.transition = 'none'; };
  kn.onpointermove = e => { if (x0 === null) return; dx = Math.max(0, Math.min(max, e.clientX - x0)); kn.style.transform = `translateX(${dx}px)`; };
  kn.onpointerup = () => {
    if (x0 === null) return;
    x0 = null;
    kn.style.transition = 'transform .2s';
    if (max > 0 && dx >= max * 0.9) { kn.style.transform = `translateX(${max}px)`; giroEsegui(); }
    else kn.style.transform = 'translateX(0)';
  };
  kn.onkeydown = e => { if (e.key === 'Enter') giroEsegui(); };
}

function _giroSig(c) { return [...c.tappe].sort((a, b) => a - b).join(','); }
function _giroConfermato(c) {
  if (!c.planComplete) return false;
  if (c.tappe.length <= 1) return true;
  try { return localStorage.getItem('wf-giro-ok-' + _giro.listaId) === _giroSig(c); } catch(e) { return false; }
}
function _giroConferma(c) {
  try { localStorage.setItem('wf-giro-ok-' + _giro.listaId, _giroSig(c)); } catch(e) {}
}

function _lsStepper(c, fase) {
  const nomi = ['Articoli', 'Provenienza', 'Giro', 'Carico'];
  const skip3 = c.tappe.length <= 1 && c.planComplete;
  const compl = [c.info.length > 0, c.planComplete, _giroConfermato(c), c.allTaken];
  return `<div class="ph-steps">${nomi.map((nm, i) => {
    const n = i + 1;
    const locked = (n >= 2 && !c.info.length) || (n >= 3 && !c.planComplete);
    const done = compl[i] && !locked;
    const cls = (n === fase ? ' on' : locked ? ' lock' : '') + (done ? ' done' : '');
    const sub = n === 3 && skip3 ? '<em>tappa unica</em>' : '';
    return `<button class="ph-step${cls}" onclick="lsGo(${n})" ${locked ? 'aria-disabled="true"' : ''}><span class="ph-dot">${done ? '✓' : n}</span><span class="ph-sl">${nm}${sub}</span></button>`;
  }).join('')}</div>`;
}

function _lsFoot(left, leftSub, nextLabel, nextOk, nextAction, backAction) {
  return `<div class="ph-foot">
    ${backAction ? `<button class="btn btn-ghost ph-back" onclick="${backAction}" aria-label="Fase precedente">←<span class="ph-back-l"> Indietro</span></button>` : ''}
    <div class="ph-foot-t"><div class="ph-foot-a">${left}</div><div class="ph-foot-b">${leftSub}</div></div>
    ${nextLabel ? `<button class="lk-btn ${nextOk ? 'lk-go' : 'lk-idle'} ph-next" ${nextOk ? '' : 'disabled'} onclick="${nextAction}">${nextLabel}</button>` : ''}
  </div>`;
}

function _renderGiro(lista) {
  const el = document.getElementById('listaDetRighe');
  const warn = document.getElementById('listaConflittoWarn');
  if (warn) warn.style.display = 'none';
  if (!_giro || _giro.listaId !== lista.id) _giroInit(lista.id);
  const c = _lsCalc(lista);
  if (_giro.fase === null) _giro.fase = !c.info.length || !c.planAny ? 1 : !c.planComplete ? 2 : 4;
  if (_giro.fase >= 2 && !c.info.length) _giro.fase = 1;
  if (_giro.fase >= 3 && !c.planComplete) _giro.fase = 2;
  const fase = _giro.fase;
  const stepper = _lsStepper(c, fase);
  const righe = sortBauliFirst(c.info, x => x.r.art_id);
  const nPz = c.totReq;
  let body = '', foot = '';

  if (fase === 1) {
    const rows = righe.map(x => {
      const r = x.r;
      const stockTot = (r.stock || []).reduce((n, s) => n + s.qty, 0);
      const nMag = (r.stock || []).length;
      const isNew = _giro.newRiga === r.id;
      return `<div class="ph-row${isNew ? ' new' : ''}" id="lsr-${r.id}">
        <div class="ph-r-main">
          <div class="ph-r-n">${h(r.art_nome)}${isNew ? ' <span class="ph-tag">APPENA AGGIUNTO</span>' : ''}</div>
          <div class="ph-r-s">${h(r.art_codice)} · disp. ${stockTot}${nMag ? ' · ' + nMag + ' mag.' : ''}${r.note_riga ? ' · ' + h(r.note_riga) : ''}</div>
        </div>
        <div class="ph-q"><button onclick="lsQty(${r.id},-1)" aria-label="Meno">−</button><button class="ph-qn" onclick="modificaRiga(${r.id},${r.qty_richiesta},'${h(r.note_riga || '')}')" aria-label="Modifica quantità">${r.qty_richiesta}</button><button onclick="lsQty(${r.id},1)" aria-label="Più">+</button></div>
        <button class="gr-ico gr-del ph-del" aria-label="Rimuovi dalla lista" onclick="eliminaRiga(${r.id})">✕</button>
      </div>`;
    }).join('');
    body = `<div class="ph-add"><button class="lk-btn lk-ask ph-addb" onclick="aggiungiArticoloLista()">+ Aggiungi articolo</button></div>
      <div class="ph-rows">${rows || '<div class="empty" style="padding:30px;text-align:center;color:var(--ink3)">Lista vuota. Aggiungi gli articoli che servono.</div>'}</div>`;
    foot = _lsFoot(`${c.info.length} ${c.info.length === 1 ? 'articolo' : 'articoli'} · ${nPz} pz richiesti`,
      'Aggiungi tutto ciò che serve. Dopo decidi da dove prenderlo.',
      'Avanti · Da dove li prendi →', c.info.length > 0, 'lsAvanti()', '');
  } else if (fase === 2) {
    const nMiss = c.info.filter(x => x.missing > 0).length;
    const rows = righe.map(x => {
      const r = x.r;
      const complete = x.missing <= 0;
      const over = x.plan > r.qty_richiesta;
      const srcs = (r.stock || []).filter(s => s.mag_id !== c.destId).map(s => ({ mag_id: s.mag_id, mag_nome: s.mag_nome, mag_colore: s.mag_colore, qty: s.qty }));
      x.valid.forEach(f => { if (!srcs.some(s => s.mag_id === f.mag_id)) srcs.push({ mag_id: f.mag_id, mag_nome: f.mag_nome, mag_colore: f.mag_colore, qty: 0 }); });
      const chips = srcs.map(s => {
        const cur = x.valid.find(f => f.mag_id === s.mag_id)?.qty_prevista || 0;
        return `<div class="ph-src${cur ? ' on' : ''}">
          <button class="ph-src-b" onclick="lsFonte(${r.id},${s.mag_id},'t')"><i style="background:${s.mag_colore}"></i><span class="ph-src-n">${h(s.mag_nome)}</span><span class="ph-src-d">${s.qty} disp.</span></button>
          ${cur ? `<div class="ph-q sm"><button onclick="lsFonte(${r.id},${s.mag_id},-1)" aria-label="Meno">−</button><span>${cur}</span><button onclick="lsFonte(${r.id},${s.mag_id},1)" aria-label="Più">+</button></div>` : '<span class="ph-src-hint">tocca</span>'}
        </div>`;
      }).join('') || '<span class="ph-r-s">Nessuno stock disponibile</span>';
      return `<div class="ph-row ph-row2${complete ? ' ok' : ' miss'}">
        <div class="ph-r-top"><span class="ph-badge${complete ? ' ok' : ''}">${complete ? '✓' : '!'}</span>
          <div class="ph-r-main"><div class="ph-r-n">${h(r.art_nome)}</div>
            <div class="ph-r-s">${h(r.art_codice)} · servono ${r.qty_richiesta} · assegnati ${x.plan}${over ? ' (troppi)' : ''}</div></div></div>
        <div class="ph-srcs">${chips}</div>
      </div>`;
    }).join('');
    const riep = c.stops.map(s => `<span class="ph-riep"><i style="background:${_giroMagCol(s.id)}"></i><b>${h(_giroMagNome(s.id))}</b> ${s.voci.length} ${s.voci.length === 1 ? 'articolo' : 'articoli'} · ${s.voci.reduce((n, v) => n + v.f.qty_prevista, 0)} pz</span>`).join('');
    const conflitto = c.conflict ? `<div class="gr-warn">⚠ Alcuni articoli risultano assegnati proprio alla destinazione. <button class="btn btn-danger btn-xs" onclick="risolviConflitti()">Risolvi</button></div>` : '';
    body = `<div class="ph-hint">Per ogni articolo scegli da quale magazzino lo prendi: tocca un magazzino per assegnare ciò che serve, poi regola la quantità se vuoi dividerlo.</div>
      ${conflitto}<div class="ph-rows">${rows}</div>
      <div class="ph-riepilogo"><span class="ph-riep-t">DA DOVE PRENDI</span>${riep || '<span class="ph-r-s">nessuno ancora</span>'}</div>`;
    foot = _lsFoot(nMiss ? `Manca ${nMiss} ${nMiss === 1 ? 'articolo' : 'articoli'}: ${c.info.filter(x => x.missing > 0).map(x => h(x.r.art_nome)).join(', ')}` : 'Tutti gli articoli hanno una provenienza',
      'Puoi tornare indietro e modificare gli articoli in qualsiasi momento.',
      c.tappe.length > 1 ? 'Avanti · Imposta il giro →' : 'Avanti · Carico →', c.planComplete, 'lsAvanti()', 'lsIndietro()');
  } else if (fase === 3) {
    const cards = c.stops.map((s, i) => `<div class="ph-stop">
      <span class="ph-stop-n">${i + 1}</span>
      <div class="ph-stop-b">
        <div class="gr-stop-n"><i style="background:${_giroMagCol(s.id)}"></i>${h(_giroMagNome(s.id))}<span class="ph-stop-t">${s.voci.reduce((n, v) => n + v.f.qty_prevista, 0)} pz</span></div>
        <div class="ph-chips">${s.voci.map(v => `<span class="ph-chip">${h(v.x.r.art_nome)} × ${v.f.qty_prevista}</span>`).join('')}</div>
      </div>
      <div class="ph-mv"><button class="gr-ico" ${i === 0 ? 'disabled style="opacity:.3"' : ''} onclick="lsMove(${s.id},-1)" aria-label="Sposta su">↑</button><button class="gr-ico" ${i === c.stops.length - 1 ? 'disabled style="opacity:.3"' : ''} onclick="lsMove(${s.id},1)" aria-label="Sposta giù">↓</button></div>
    </div>`).join('');
    const dest = c.destId ? _giroMagNome(c.destId) : null;
    body = `<div class="ph-hint">In che ordine passi dai magazzini? Qui compaiono solo quelli scelti nella fase 2.</div>
      <div class="ph-rows">${cards}
        <div class="ph-stop ph-stop-end"><span class="ph-stop-n">⚑</span><div class="ph-stop-b"><div class="gr-stop-n">${dest ? 'Consegna a ' + h(dest) : 'Consegna'}</div><div class="gr-stop-m">sempre ultima</div></div></div>
      </div>`;
    foot = _lsFoot(`${c.stops.length} ${c.stops.length === 1 ? 'tappa' : 'tappe'} · ${nPz} pz`, "L'ordine si può cambiare anche durante il carico.", 'Avanti · Inizia il carico →', true, 'lsAvanti()', 'lsIndietro()');
  } else {
    const cur = c.stops.find(s => !s.done);
    const pills = c.stops.map(s => `<button class="ph-pill${cur && cur.id === s.id ? ' on' : ''}${s.done ? ' done' : ''}" onclick="lsVaiTappa(${s.id})"><i style="background:${_giroMagCol(s.id)}"></i>${h(_giroMagNome(s.id))}<span>${s.nDone}/${s.voci.length}</span></button>`).join('');
    const groups = c.stops.map((s, i) => `<div class="ph-grp${cur && cur.id === s.id ? ' cur' : ''}" id="lsg-${s.id}">
      <div class="ph-grp-h"><i style="background:${_giroMagCol(s.id)}"></i><b>${c.stops.length > 1 ? (i + 1) + '. ' : ''}${h(_giroMagNome(s.id))}</b><span class="ph-grp-p">${s.nDone} / ${s.voci.length}</span>${cur && cur.id === s.id && c.stops.length > 1 ? '<span class="ph-grp-tag">TAPPA CORRENTE</span>' : ''}</div>
      ${s.voci.map(v => {
        const r = v.x.r, done = v.f.qty_presa >= v.f.qty_prevista;
        const altri = v.x.valid.filter(f => f.mag_id !== s.id);
        const nota = altri.length ? `${v.f.qty_prevista} di ${r.qty_richiesta} · altri ${altri.reduce((n, f) => n + f.qty_prevista, 0)} da ${altri.map(f => h(_giroMagNome(f.mag_id))).join(', ')}` : `${(r.stock || []).find(s2 => s2.mag_id === s.id)?.qty ?? '—'} disponibili`;
        return `<div class="ph-v${done ? ' done' : ''}">
          <button class="gr-chk${done ? ' on' : ''}" aria-label="Spunta ${h(r.art_nome)}" onclick="lsTick(${r.id},${s.id})">${done ? '✓' : ''}</button>
          <div class="ph-r-main"><div class="ph-r-n">${h(r.art_nome)}</div><div class="ph-r-s">${h(r.art_codice)} · ${nota}</div></div>
          <div class="ph-vq">× ${v.f.qty_prevista}</div>
        </div>`;
      }).join('')}
    </div>`).join('');
    const pronto = c.allTaken && c.destId && !c.conflict;
    const mancano = c.stops.reduce((n, s) => n + s.voci.reduce((m, v) => m + Math.max(0, v.f.qty_prevista - v.f.qty_presa), 0), 0);
    let motivo = '';
    if (!c.destId) motivo = 'Scegli la destinazione';
    else if (c.conflict) motivo = 'Alcuni articoli sono assegnati alla destinazione';
    else if (!c.allTaken) motivo = `Spunta tutto per sbloccare · mancano ${mancano} pz`;
    const destOpts = '<option value="">— Scegli la destinazione —</option>' +
      getMagReali().map(m => `<option value="${m.id}"${m.id === c.destId ? ' selected' : ''}>${h(m.nome)}</option>`).join('');
    const conflitto = c.conflict ? `<div class="gr-warn">⚠ Alcuni articoli risultano assegnati proprio alla destinazione. <button class="btn btn-danger btn-xs" onclick="risolviConflitti()">Risolvi</button></div>` : '';
    body = `${c.stops.length > 1 ? `<div class="ph-pills"><span class="ph-riep-t">GIRO</span>${pills}</div>` : ''}${conflitto}
      <div class="ph-rows">${groups}</div>`;
    foot = `<div class="ph-foot ph-cons">
      <button class="btn btn-ghost ph-back" onclick="lsIndietro()" aria-label="Fase precedente">←<span class="ph-back-l"> Indietro</span></button>
      <div class="ph-foot-t"><div class="ph-foot-a">Consegna</div>
        <select class="finput ph-dest" onchange="giroSetDest(this.value)">${destOpts}</select></div>
      <div class="gr-slide${pronto ? '' : ' off'}" id="grSlide" data-on="${pronto ? 1 : 0}">
        <button class="gr-knob" aria-label="Esegui lo spostamento" ${pronto ? '' : 'disabled'}>${pronto ? '→' : '🔒'}</button>
        <span>${pronto ? 'Scorri per eseguire lo spostamento' : h(motivo)}</span>
      </div>
    </div>`;
  }

  el.innerHTML = `<div class="ph-wrap">${stepper}${body}${foot}</div>`;
  _giroBindSlider();
  if (fase === 1 && _giro.newRiga) {
    const nr = document.getElementById('lsr-' + _giro.newRiga);
    if (nr) nr.scrollIntoView({ block: 'nearest' });
  }
}

function toggleRigaLista(head) {
  const body = head.nextElementSibling;
  const arrow = head.querySelector('span:first-child');
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  arrow.textContent = open ? '▶' : '▼';
}

async function stepFlag(rigaId, magId, delta, maxQty, qtyRichiesta) {
  const numEl = document.getElementById(`flag-num-${rigaId}-${magId}`);
  const doneEl = document.getElementById(`flag-done-${rigaId}-${magId}`);
  if (!numEl) return;
  const curr = parseInt(numEl.textContent) || 0;
  // Calcola quanto è già flaggato sugli altri magazzini per questa riga
  const riga = _listaCorrente?.righe?.find(r => r.id === rigaId);
  const altriFlag = riga?.stock?.reduce((s, s2) => {
    if (s2.mag_id === magId) return s;
    const el = document.getElementById(`flag-num-${rigaId}-${s2.mag_id}`);
    return s + (el ? (parseInt(el.textContent) || 0) : 0);
  }, 0) || 0;
  const maxEffettivo = qtyRichiesta !== undefined
    ? Math.min(maxQty, Math.max(0, qtyRichiesta - altriFlag))
    : maxQty;
  const nuova = Math.max(0, Math.min(maxEffettivo, curr + delta));
  if (nuova === curr) return;
  numEl.textContent = nuova;
  if (doneEl) { doneEl.style.opacity = nuova > 0 ? '1' : '0'; }
  // Aggiorna in background senza ricostruire il DOM
  await apiFetch('PUT', `/liste/flag/${rigaId}/${magId}`, { qty_presa: nuova });
  // Aggiorna solo progress bar e contatore nella testata
  if (_listaCorrente) {
    const l = await apiFetch('GET', '/liste/' + _listaCorrente.id);
    _listaCorrente = l;
    aggiornaSoloTestata(l);
    aggiornaStatoLista(l);
  }
}

// Aggiorna progress bar e contatori senza ricostruire il DOM delle righe
function calcolaStatoLista(lista) {
  const righe = lista.righe || [];
  if (!righe.length) return 'vuota';
  const destId = lista.mag_dest_id ? parseInt(lista.mag_dest_id) : null;
  const valide = r => (r.flags||[]).filter(f => !(destId && f.mag_id === destId));
  // inattiva = articoli inseriti ma nessuna provenienza; in preparazione = almeno una provenienza
  const totPrev = righe.reduce((s,r) => s + valide(r).reduce((n,f) => n + (f.qty_prevista||0), 0), 0);
  if (totPrev === 0) return 'inattiva';
  const completa = righe.every(r => valide(r).reduce((s,f) => s + f.qty_presa, 0) >= r.qty_richiesta);
  return completa ? 'completa' : 'in-preparazione';
}

function aggiornaStatoLista(lista) {
  const statoEl = document.getElementById('listaDetStato');
  const statoMob = document.getElementById('listaDetStatoMobile');
  if (!statoEl) return;
  const stato = calcolaStatoLista(lista);
  if (stato === 'vuota') { statoEl.style.display = 'none'; return; }
  statoEl.style.display = '';
  const label = {'inattiva':'inattiva','in-preparazione':'in preparazione','completa':'completa'}[stato] || stato;
  statoEl.textContent = label;
  statoEl.className = 'lista-stato lista-stato-desktop ' + stato;
  if (statoMob) { statoMob.textContent = label; statoMob.className = 'lista-stato lista-stato-mobile ' + stato; }
}

function aggiornaSoloTestata(lista) {
  for (const r of lista.righe || []) {
    const qtyPresa = (r.flags||[]).reduce((s,f) => s+f.qty_presa, 0);
    const pct = Math.min(100, Math.round(qtyPresa / r.qty_richiesta * 100));
    const completo = qtyPresa >= r.qty_richiesta;
    // Aggiorna contatore testata
    const riga = document.querySelector(`.lista-riga-head [data-riga="${r.id}"]`);
    if (riga) { riga.textContent = `${qtyPresa}/${r.qty_richiesta} ${h(r.art_um)}`; riga.style.color = completo?'var(--green)':'var(--ink2)'; }
    // Aggiorna progress bar
    const pb = document.getElementById(`pb-${r.id}`);
    if (pb) { pb.style.width = pct+'%'; pb.className = 'lista-progress-bar' + (completo?' completo':''); }
  }
}

async function salvaFlag(rigaId, magId, input) {
  const qty = Math.max(0, +input.value || 0);
  input.value = qty;
  await apiFetch('PUT', `/liste/flag/${rigaId}/${magId}`, { qty_presa: qty });
  const doneEl = document.getElementById(`flag-done-${rigaId}-${magId}`);
  if (doneEl) { doneEl.style.opacity = qty > 0 ? '1' : '0'; }
  if (_listaCorrente) { const l = await apiFetch('GET', '/liste/' + _listaCorrente.id); _listaCorrente = l; aggiornaSoloTestata(l); }
}

function openModalListaNew() {
  document.getElementById('listaEditId').value = '';
  document.getElementById('modalListaTitolo').textContent = 'Nuova lista';
  document.getElementById('listaNome').value = '';
  document.getElementById('listaNota').value = '';
  document.getElementById('listaTipo').value = 'normale';
  const sel = document.getElementById('listaMagDest');
  sel.innerHTML = '<option value="">— Nessuna destinazione —</option>' +
    getMagReali().map(m => `<option value="${m.id}">${h(m.nome)}</option>`).join('');
  openModal('modalLista');
  setTimeout(() => document.getElementById('listaNome').focus(), 100);
}

function openModalListaEdit(id, nome, magDestId, note, tipo) {
  document.getElementById('listaEditId').value = id;
  document.getElementById('modalListaTitolo').textContent = 'Modifica lista';
  document.getElementById('listaNome').value = nome;
  document.getElementById('listaNota').value = note;
  document.getElementById('listaTipo').value = tipo || 'normale';
  const sel = document.getElementById('listaMagDest');
  // Lista veloce: il magazzino di partenza non è tra le destinazioni possibili
  const srcId = tipo === 'veloce' ? ((_listeElenco.find(l => l.id == id) || {}).mag_src_id || null) : null;
  sel.innerHTML = '<option value="">— Nessuna destinazione —</option>' +
    getMagReali().filter(m => !srcId || m.id != srcId).map(m => `<option value="${m.id}"${m.id==magDestId?' selected':''}>${h(m.nome)}</option>`).join('');
  openModal('modalLista');
}

async function salvaLista() {
  const id = document.getElementById('listaEditId').value;
  const nome = document.getElementById('listaNome').value.trim();
  const note = document.getElementById('listaNota').value;
  const mag_dest_id = document.getElementById('listaMagDest').value || null;
  const tipo = document.getElementById('listaTipo').value;
  if (!nome) { toast('Nome obbligatorio', true); return; }
  try {
    if (id) await apiFetch('PUT', '/liste/' + id, { nome, note, mag_dest_id });
    else await apiFetch('POST', '/liste', { nome, note, mag_dest_id, tipo });
    closeModal('modalLista');
    await load();
    renderListe();
    toast('Lista salvata ✓');
  } catch(e) { toast(e.message, true); }
}

async function eliminaLista(id) {
  if (!await askConfirm('Eliminare questa lista?', { ok: 'Elimina', danger: true })) return;
  await apiFetch('DELETE', '/liste/' + id);
  await loadPartial('spostamenti');
  renderListe();
  toast('Lista eliminata');
}

function eliminaListaCorrente() {
  if (_listaCorrente) eliminaLista(_listaCorrente.id).then(chiudiDettaglioLista);
}

function aggiungiArticoloLista() {
  if (!_listaCorrente) return;
  document.getElementById('aggArtListaId').value = _listaCorrente.id;
  const catSel = document.getElementById('aggArtCat');
  catSel.innerHTML = '<option value="">Tutte</option>' +
    D.categorie.map(c => `<option value="${c.id}">[${h(c.prefisso)}] ${h(c.nome)}</option>`).join('');
  const srch = document.getElementById('aggArtSearch'); if (srch) srch.value = '';
  filterAggArtArticoli();
  document.getElementById('aggArtQty').value = '';
  document.getElementById('aggArtNota').value = '';
  openModal('modalAggArt');
  setTimeout(() => { if (srch) srch.focus(); }, 80);
}

function filterAggArtArticoli() {
  const catId = document.getElementById('aggArtCat').value;
  const sel = document.getElementById('aggArtArticolo');
  let lista = catId ? D.articoli.filter(a => a.cat_id == catId) : D.articoli;
  const terms = (document.getElementById('aggArtSearch')?.value || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) lista = lista.filter(a => { const t = `${a.nome} ${a.codice} ${a.variante || ''}`.toLowerCase(); return terms.every(w => t.includes(w)); });
  const artsSConStock = lista.filter(a => D.stock.some(s => s.art_id == a.id && s.qty > 0));
  sel.innerHTML = artsSConStock.map(a => `<option value="${a.id}">[${h(a.codice)}] ${h(a.nome)}${a.variante?' · '+h(a.variante):''}</option>`).join('');
  aggArtShowStock();
}

function stepAddToListaQty(delta) {
  const input = document.getElementById('addToListaQty');
  const curr = parseInt(input.value) || 0;
  const artId = document.getElementById('addToListaArtId').value;
  const maxStock = artId
    ? D.stock.filter(s => s.art_id == artId && s.mag_id == _detailMagId).reduce((n, s) => n + s.qty, 0)
    : 9999;
  input.value = Math.max(1, Math.min(maxStock, curr + delta));
}

function stepAggArtQty(delta) {
  const input = document.getElementById('aggArtQty');
  const curr = parseInt(input.value) || 0;
  const artId = document.getElementById('aggArtArticolo').value;
  const maxStock = artId
    ? D.stock.filter(s => s.art_id == artId && !D.magazzini.find(m => m.id == s.mag_id)?.virtuale)
        .reduce((n, s) => n + s.qty, 0)
    : 9999;
  input.value = Math.max(1, Math.min(maxStock, curr + delta));
}

function aggArtShowStock() {
  const artId = document.getElementById('aggArtArticolo').value;
  const info = document.getElementById('aggArtStockInfo');
  if (!artId) { info.textContent = ''; return; }
  const tot = D.stock.filter(s => s.art_id == artId && !D.magazzini.find(m=>m.id==s.mag_id)?.virtuale)
    .reduce((n,s) => n+s.qty, 0);
  info.textContent = `Stock disponibile: ${tot} pz`;
}

async function salvaAggArt() {
  const listaId = document.getElementById('aggArtListaId').value;
  const artId = document.getElementById('aggArtArticolo').value;
  const qty = +document.getElementById('aggArtQty').value;
  const note = document.getElementById('aggArtNota').value;
  if (!artId) { toast('Seleziona un articolo', true); return; }
  if (!qty || qty < 1) { toast('Inserisci una quantità', true); return; }
  try {
    const nr = await apiFetch('POST', `/liste/${listaId}/righe`, { art_id: artId, qty_richiesta: qty, note_riga: note });
    closeModal('modalAggArt');
    await apriLista(listaId);
    // Lista normale: si resta/torna alla fase Articoli con la riga appena inserita in evidenza
    if (_giro && _listaCorrente && _listaCorrente.tipo !== 'veloce' && nr && nr.id) { _giro.fase = 1; _giro.newRiga = nr.id; _giroRender(); }
    toast('Articolo aggiunto ✓');
  } catch(e) { toast(e.message, true); }
}

async function modificaRiga(rigaId, qtyAttuare, noteRiga) {
  const nuovaQty = await askPrompt('Quantità richiesta:', qtyAttuare, { type: 'number' });
  if (nuovaQty === null) return;
  const qty = +nuovaQty;
  if (!qty || qty < 1) { toast('Quantità non valida', true); return; }
  if (_listaCorrente && _listaCorrente.tipo !== 'veloce') { await _lsApplyQty(rigaId, qty); return; }
  try {
    await apiFetch('PUT', `/liste/righe/${rigaId}`, { qty_richiesta: qty });
    const l = await apiFetch('GET', '/liste/' + _listaCorrente.id);
    _listaCorrente = l; renderDettaglioRighe(l);
    toast('Riga aggiornata ✓');
  } catch(e) { toast(e.message, true); }
}

async function eliminaRiga(rigaId) {
  if (!await askConfirm('Rimuovere questo articolo dalla lista?', { ok: 'Rimuovi', danger: true })) return;
  await apiFetch('DELETE', `/liste/righe/${rigaId}`);
  const l = await apiFetch('GET', '/liste/' + _listaCorrente.id);
  _listaCorrente = l; renderDettaglioRighe(l);
  toast('Articolo rimosso');
}

// Lista veloce: destinazione scelta al momento dell'esecuzione
function _sorgentiIdsVeloce() { return _listaSorgenti(_listaCorrente).map(s => s.id); }

async function _eseguiVeloce(destId, destNome) {
  const lista = _listaCorrente;
  const totPz = (lista.righe||[]).reduce((s,r) => s + (r.flags||[]).reduce((n,f) => n + (f.qty_presa>0?f.qty_presa:0), 0), 0);
  const nRighe = (lista.righe||[]).filter(r => (r.flags||[]).some(f => f.qty_presa>0)).length;
  const src = _listaSorgenti(lista).map(s => s.nome).join(', ');
  if (!await askConfirm(`Spostare ${totPz} pz (${nRighe} articoli) da "${src}" a "${destNome}"?`, { ok: 'Sposta' })) return;
  try {
    const r = await apiFetch('POST', `/liste/${lista.id}/esegui`, { mag_dest_id: destId });
    await loadPartial('spostamenti');
    playSpostamentoSound();
    toast(`✓ ${r.spostamenti} spostamenti registrati`);
    _listaCorrente = null;
    chiudiDettaglioLista();
    renderListe();
  } catch(e) { toast(e.message, true); }
}

// La destinazione viene solo salvata: lo spostamento si esegue poi con "Esegui spostamento"
let _destVeloceListaId = null;
async function scegliDestVeloce(id) {
  try {
    const l = await apiFetch('GET', '/liste/' + id);
    const src = _listaSorgenti(l).map(s => s.id);
    _destVeloceListaId = id;
    document.getElementById('destVeloceSel').innerHTML = '<option value="">— Scegli il magazzino —</option>' +
      getMagReali().filter(m => !src.includes(m.id)).map(m => `<option value="${m.id}"${m.id == l.mag_dest_id ? ' selected' : ''}>${h(m.nome)}</option>`).join('');
    openModal('modalDestVeloce');
  } catch(e) { toast(e.message, true); }
}
async function confermaDestVeloce() {
  const v = document.getElementById('destVeloceSel').value;
  if (!v) { toast('Scegli il magazzino di destinazione', true); return; }
  const id = _destVeloceListaId || (_listaCorrente && _listaCorrente.id);
  if (!id) return;
  try {
    await apiFetch('PUT', '/liste/' + id, { mag_dest_id: parseInt(v) });
    closeModal('modalDestVeloce');
    _destVeloceListaId = null;
    await load();
    if (_listaCorrente && _listaCorrente.id === id) await apriLista(id);
    renderListe();
    toast('Destinazione impostata ✓');
  } catch(e) { toast(e.message, true); }
}

async function eseguiLista() {
  if (!_listaCorrente) return;
  // Liste normali: l'esecuzione avviene dalla fase "Carico" (consegna con gesto di conferma)
  if (_listaCorrente.tipo !== 'veloce') { lsGo(4); return; }
  if (_listaCorrente.tipo === 'veloce' && _listaSorgenti(_listaCorrente).length) {
    const src = _sorgentiIdsVeloce();
    const destId = _listaCorrente.mag_dest_id ? parseInt(_listaCorrente.mag_dest_id) : null;
    if (destId && src.includes(destId)) { toast('La destinazione coincide con il magazzino di partenza', true); return; }
    if (destId) { _eseguiVeloce(destId, _listaCorrente.mag_dest_nome || 'destinazione'); return; }
    scegliDestVeloce(_listaCorrente.id);
    return;
  }
  if (!_listaCorrente.mag_dest_id) { toast('Imposta un magazzino destinazione prima di eseguire', true); return; }
  // Blocca se la lista non è completa
  const stato = calcolaStatoLista(_listaCorrente);
  if (stato !== 'completa') {
    toast('La lista deve essere "completa" prima di eseguire gli spostamenti', true);
    return;
  }
  // Blocca se ci sono flag conflittuali
  const destId = _listaCorrente.mag_dest_id ? parseInt(_listaCorrente.mag_dest_id) : null;
  const hasConflitti = destId && (_listaCorrente.righe||[]).some(r =>
    (r.flags||[]).some(f => f.mag_id === destId && f.qty_presa > 0)
  );
  if (hasConflitti) {
    toast('Rimuovi i flag conflittuali prima di eseguire — alcuni articoli sono flaggati sul magazzino di destinazione', true);
    return;
  }
  const totFlag = (_listaCorrente.righe||[]).reduce((s,r) =>
    s + (r.flags||[]).reduce((n,f) => n + (destId && f.mag_id === destId ? 0 : f.qty_presa), 0), 0);
  const dest = _listaCorrente.mag_dest_nome || 'destinazione';
  if (!await askConfirm(`Eseguire ${totFlag} spostamenti verso "${dest}"?`, { ok: 'Esegui' })) return;
  try {
    const r = await apiFetch('POST', `/liste/${_listaCorrente.id}/esegui`);
    await loadPartial('spostamenti');
    playSpostamentoSound();
    toast(`✓ ${r.spostamenti} spostamenti registrati`);
    if (_listaCorrente.tipo === 'veloce') {
      _listaCorrente = null;
      chiudiDettaglioLista();
      renderListe();
    } else {
      const l = await apiFetch('GET', '/liste/' + _listaCorrente.id);
      _listaCorrente = l; apriLista(l.id);
    }
  } catch(e) { toast(e.message, true); }
}

async function _fillAddToListaSelect(selectId) {
  const liste = await apiFetch('GET', '/liste');
  // Escludi liste veloci che hanno come destinazione il magazzino corrente
  const magCorrente = _detailMagId ? parseInt(_detailMagId) : null;
  // Una lista veloce ha un solo magazzino di partenza: ok se vuota o già "da" questo magazzino
  const veloci = liste.filter(l =>
    l.tipo === 'veloce' &&
    !(magCorrente && l.mag_dest_id && parseInt(l.mag_dest_id) === magCorrente) &&
    (!l.mag_src_id || !magCorrente || parseInt(l.mag_src_id) === magCorrente)
  );
  const sel = document.getElementById('addToListaId');
  if (!veloci.length) {
    sel.innerHTML = '<option value="">Nessuna lista veloce disponibile per questo magazzino</option>';
  } else {
    sel.innerHTML = veloci.map(l => `<option value="${l.id}">${h(l.nome)}</option>`).join('');
    if (selectId && veloci.some(l => String(l.id) === String(selectId))) sel.value = String(selectId);
  }
  return liste;
}

// Crea una nuova lista veloce "<utente> <n>" e la preseleziona
async function creaNuovaListaVeloce() {
  const btn = document.getElementById('addToListaNewBtn');
  if (btn) btn.disabled = true;
  try {
    const liste = await apiFetch('GET', '/liste');
    const base = (currentUser?.username || 'Lista').trim();
    const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' (\\d+)$', 'i');
    let max = 0;
    liste.forEach(l => { const m = re.exec(l.nome || ''); if (m) max = Math.max(max, parseInt(m[1])); });
    const r = await apiFetch('POST', '/liste', { nome: `${base} ${max + 1}`, note: '', mag_dest_id: null, tipo: 'veloce' });
    await _fillAddToListaSelect(r.id);
    toast('Lista veloce creata ✓');
  } catch(e) { toast(e.message, true); }
  finally { if (btn) btn.disabled = false; }
}

// Tasto ⚡ nel contenuto magazzino: contatore verde se l'articolo è già in una lista veloce
function velociQtyArt(artId) {
  return (D.liste || []).reduce((n, l) => n + (l.tipo === 'veloce' ? (+(l.art_qty || {})[artId] || 0) : 0), 0);
}
function velociBtn(artId) {
  const q = velociQtyArt(artId);
  return `<button class="vl-btn${q ? ' on' : ''}" onclick="event.stopPropagation();openAddToLista(${artId})" title="${q ? q + ' pz già in liste veloci · ' : ''}Aggiungi a lista veloce" aria-label="Aggiungi a lista veloce">⚡${q ? `<span>${q}</span>` : '+'}</button>`;
}
// Apri modal "Aggiungi a lista" dal modal contenuto magazzino
async function openAddToLista(artId) {
  const art = getArt(artId);
  if (!art) return;
  document.getElementById('addToListaArtId').value = artId;
  document.getElementById('addToListaArtInfo').innerHTML =
    `${codiceBadge(art.codice, getCat(art.cat_id)?.colore)} <strong>${h(art.nome)}</strong>`;
  const tot = D.stock.filter(s => s.art_id==artId && s.mag_id==_detailMagId).reduce((n,s) => n+s.qty, 0);
  document.getElementById('addToListaStockInfo').textContent = `Disponibili in ${getMag(parseInt(_detailMagId))?.nome || 'magazzino'}: ${tot} pz`;
  await _fillAddToListaSelect();
  document.getElementById('addToListaQty').value = '';
  openModal('modalAddToLista');
}

async function salvaAddToLista() {
  const artId = document.getElementById('addToListaArtId').value;
  const listaId = document.getElementById('addToListaId').value;
  const qty = +document.getElementById('addToListaQty').value;
  if (!listaId) { toast('Nessuna lista disponibile', true); return; }
  if (!qty || qty < 1) { toast('Inserisci una quantità', true); return; }
  try {
    await apiFetch('POST', `/liste/${listaId}/righe`, { art_id: artId, qty_richiesta: qty, mag_id: _detailMagId });
    closeModal('modalAddToLista');
    try { D.liste = await apiFetch('GET', '/liste'); renderMagDetailTable(); } catch (e) {}
    toast('Aggiunto alla lista ✓');
  } catch(e) { toast(e.message, true); }
}

// ─── UTENTI ONLINE ───
const AVATAR_COLORS = [
  {bg:'#0F6E56',fg:'#9FE1CB'},{bg:'#185FA5',fg:'#85B7EB'},{bg:'#993556',fg:'#F4C0D1'},
  {bg:'#7c3aed',fg:'#c4b5fd'},{bg:'#b45309',fg:'#fcd34d'},{bg:'#0e7490',fg:'#67e8f9'},
  {bg:'#15803d',fg:'#86efac'},{bg:'#be185d',fg:'#f9a8d4'},{bg:'#1d4ed8',fg:'#93c5fd'},
  {bg:'#92400e',fg:'#fde68a'}
];
function avatarColor(username) {
  let h = 0;
  for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function _renderOnlineFromList(lista) {
  const countEl = document.getElementById('onlineCount');
  const avEl = document.getElementById('onlineAvatars');
  if (!countEl || !avEl) return;
  const n = lista.length;
  countEl.textContent = String(n);
  const pill = document.getElementById('onlinePill');
  if (pill) pill.title = (n === 1 ? '1 utente online' : `${n} utenti online`) + (n ? ': ' + lista.map(u => u.username).join(', ') : '');
  const visibili = lista.slice(0, 3);
  avEl.innerHTML = visibili.map(u => {
    const c = avatarColor(u.username);
    const iniziale = u.username.charAt(0).toUpperCase();
    return `<div class="online-av" style="background:${c.bg};color:${c.fg}" title="${h(u.username)}">${iniziale}</div>`;
  }).join('') + (n > 3 ? `<div class="online-av" style="background:#3a3835;color:#ddd" title="${n - 3} altri">+${n - 3}</div>` : '');
}

function initOnline() {}

// ─── DARK MODE ───
function initDark() {
  const saved = localStorage.getItem('wf-dark');
  if (saved === '1' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.body.classList.add('dark');
  }
}

// ─── MOBILE NAV ───
function toggleMobileNav() {
  const sidebar   = document.getElementById('sidebar');
  const hamburger = document.getElementById('hamburger');
  const overlay   = document.getElementById('navOverlay');
  const isOpen = sidebar.classList.contains('mobile-open');
  if (isOpen) {
    sidebar.classList.remove('mobile-open');
    hamburger.classList.remove('open');
    overlay.classList.remove('open');
  } else {
    sidebar.classList.add('mobile-open');
    hamburger.classList.add('open');
    overlay.classList.add('open');
  }
}
function closeMobileNav() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  sidebar.classList.remove('mobile-open');
  const hamburger = document.getElementById('hamburger');
  if (hamburger) hamburger.classList.remove('open');
  const overlay = document.getElementById('navOverlay');
  if (overlay) overlay.classList.remove('open');
}

// ─── AUTH ───
async function initAuth() {
  try {
    await window.localReady;
    currentUser = { id:1, username:'iPad', ruolo:'admin' };
    const APP_BUILD = 45;   // deve coincidere con LOCALAPI_BUILD in localapi.js
    const okBuild = window.LOCALAPI_BUILD === APP_BUILD;
    document.getElementById('userLabel').textContent = okBuild ? 'Offline · v' + APP_BUILD : '⚠ file non allineati';
    if (!okBuild) setTimeout(() => toast('Aggiornamento incompleto: chiudi e riapri l\'app con la rete attiva', true), 800);
    applyRuolo('admin');
    return true;
  } catch(e) {
    document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif"><h2>Impossibile avviare il database locale</h2><p>' + (e.message||e) + '</p><p>Riapri l\'app con la connessione attiva almeno una volta.</p></div>';
    return false;
  }
}
function applyRuolo(ruolo) {
  const isAdmin = ruolo === 'admin';
  document.querySelectorAll('.admin-only').forEach(el => { el.style.display = isAdmin ? '' : 'none'; });
  document.querySelectorAll('.user-only').forEach(el => {
    if(isAdmin) { el.style.display = 'none'; return; }
    // Ripristina il display corretto in base al tag/classe
    if(el.classList.contains('nav-btn'))          el.style.display = 'flex';
    else if(el.classList.contains('nav-group-label')) el.style.display = 'block';
    else el.style.display = '';
  });
  const hAdmin = document.getElementById('magDetailHint');
  const hUser  = document.getElementById('magDetailHintUser');
  if(hAdmin) hAdmin.style.display = isAdmin ? '' : 'none';
  if(hUser)  hUser.style.display  = isAdmin ? 'none' : '';
  // colgroup e thead del modal detail sono gestiti dinamicamente in renderMagDetailTable
}
async function doLogout() { }

// ─── ADMIN UTENTI ───
// ─── ADMIN ───
async function seedTestDB() {
  if (!await askConfirm('Attenzione: tutti i dati attuali (articoli, magazzini, stock, storico) saranno sostituiti con dati di test. Gli utenti rimarranno invariati. Continuare?', { ok: 'Sostituisci', danger: true })) return;
  const msg = document.getElementById('seedMsg');
  msg.style.display = '';
  msg.style.color = 'var(--ink2)';
  msg.textContent = 'Caricamento in corso...';
  try {
    const r = await apiFetch('POST', '/admin/seed-test');
    await load();
    msg.style.color = 'var(--green)';
    msg.textContent = '✓ ' + r.message;
  } catch(e) {
    msg.style.color = 'var(--red)';
    msg.textContent = '✗ ' + (e.message || 'Errore');
  }
}

async function importaDbEsterno(inp) {
  const f = inp.files && inp.files[0]; inp.value = '';
  if (!f) return;
  if (!await askConfirm('Importare "' + f.name + '"?\nTutti i dati attuali (articoli, magazzini, stock, case, bauli, liste, storico) saranno sostituiti.\nGli utenti restano invariati. Nello storico i movimenti fatti da utenti che qui non esistono compariranno come "iPad".\nÈ un caricamento temporaneo: su Render gratuito i dati non vengono conservati.', { ok: 'Importa', danger: true })) return;
  const msg = document.getElementById('seedMsg');
  msg.style.display = ''; msg.style.color = 'var(--ink2)'; msg.textContent = 'Importazione in corso...';
  try {
    const r = await fetch(API + '/admin/import-db', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream', 'x-csrf-token': _csrfToken() },
      body: f
    });
    if (r.status === 401) { window.location.href = '/login'; return; }
    let j = {}; try { j = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(j.error || ('Errore ' + r.status));
    await load();
    try { renderAdmin(); } catch (_) {}
    msg.style.color = 'var(--green)'; msg.textContent = '✓ ' + j.message;
  } catch (e) {
    msg.style.color = 'var(--red)'; msg.textContent = '✗ ' + (e.message || 'Errore');
  }
}

async function resetDB() {
  if (!await askConfirm('Ripristina i dati demo minimali? Tutti i dati attuali andranno persi.', { ok: 'Ripristina', danger: true })) return;
  const msg = document.getElementById('seedMsg');
  msg.style.display = '';
  msg.style.color = 'var(--ink2)';
  msg.textContent = 'Ripristino in corso...';
  try {
    const r = await apiFetch('POST', '/admin/reset-db');
    await load();
    msg.style.color = 'var(--green)';
    msg.textContent = '✓ ' + r.message;
  } catch(e) {
    msg.style.color = 'var(--red)';
    msg.textContent = '✗ ' + (e.message || 'Errore');
  }
}

async function renderAdmin() {
  const utenti = await apiFetch('GET','/admin/utenti');
  document.getElementById('tbUtenti').innerHTML = utenti.length ? utenti.map(u=>{
    const isSelf  = u.id === currentUser.id;
    const initials = u.username.slice(0,2).toUpperCase();
    const isAdmin  = u.ruolo === 'admin';
    const isAttivo = !!u.attivo;
    const avatarCls = `au-avatar ${isAdmin?'au-avatar-admin':'au-avatar-user'}${!isAttivo?' au-avatar-dis':''}`;
    const ruoloBadge  = `<span class="badge ${isAdmin?'badge-admin':'badge-gray'}">${isAdmin?'admin':'utente'}</span>`;
    const statoBadge  = `<span class="badge ${isAttivo?'badge-attivo':'badge-disabilitato'}">${isAttivo?'attivo':'disabilitato'}</span>`;
    const rowStyle    = isAttivo ? '' : 'opacity:.6';
    return `<tr style="${rowStyle}">
      <td>
        <div class="au-user-cell">
          <div class="${avatarCls}">${h(initials)}</div>
          <div>
            <strong style="${!isAttivo?'color:var(--ink2)':''}">${h(u.username)}</strong>${isSelf?'<span class="au-self">(tu)</span>':''}
          </div>
        </div>
      </td>
      <td>${ruoloBadge}</td>
      <td>${statoBadge}</td>
      <td style="font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace">${u.creato_il?u.creato_il.slice(0,10):'—'}</td>
      <td style="text-align:right">
        <div style="display:flex;gap:4px;justify-content:flex-end;flex-wrap:nowrap">
          <button class="btn btn-ghost btn-xs" onclick="openResetPwd(${u.id},'${h(u.username)}')">Pwd</button>
          ${!isSelf?`<button class="btn btn-ghost btn-xs" onclick="toggleAttivo(${u.id},${u.attivo})">${isAttivo?'Disabilita':'Abilita'}</button>`:''}
          ${!isSelf?`<button class="btn btn-danger btn-xs" onclick="delUtente(${u.id},'${h(u.username)}')">Elimina</button>`:''}
        </div>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">Nessun utente</td></tr>';
}
function openModalUtenteNew() {
  document.getElementById('utenteEditId').value='';
  document.getElementById('modalUtenteTitle').textContent='Nuovo Utente';
  document.getElementById('utenteUsername').value='';
  document.getElementById('utenteUsername').disabled=false;
  document.getElementById('utentePassword').value='';
  document.getElementById('utenteRuolo').value='utente';
  document.getElementById('utentePasswordGroup').style.display='';
  openModal('modalUtente');
}
async function salvaUtente() {
  const id=document.getElementById('utenteEditId').value;
  const username=document.getElementById('utenteUsername').value.trim();
  const password=document.getElementById('utentePassword').value;
  const ruolo=document.getElementById('utenteRuolo').value;
  if(!username){toast('Username obbligatorio',true);return;}
  try {
    if(id){ await apiFetch('PUT','/admin/utenti/'+id,{ruolo}); }
    else {
      if(!password||password.length<4){toast('Password minimo 4 caratteri',true);return;}
      await apiFetch('POST','/admin/utenti',{username,password,ruolo});
    }
    closeModal('modalUtente'); await renderAdmin();
    toast(id?'Utente aggiornato ✓':'Utente creato ✓');
  } catch(e){ toast(e.message||'Errore', true); }
}
function openResetPwd(id,username) {
  document.getElementById('resetPwdUserId').value=id;
  document.getElementById('modalResetPwdSub').textContent='Reset password per: '+username;
  document.getElementById('resetPwdVal').value='';
  openModal('modalResetPwd');
}
async function salvaResetPwd() {
  const id=document.getElementById('resetPwdUserId').value;
  const password=document.getElementById('resetPwdVal').value;
  if(!password||password.length<4){toast('Password minimo 4 caratteri',true);return;}
  try { await apiFetch('POST','/admin/utenti/'+id+'/reset-password',{password}); closeModal('modalResetPwd'); toast('Password aggiornata ✓'); } catch(e){}
}
async function toggleAttivo(id,attivo) {
  if(!await askConfirm(attivo?'Disabilitare questo utente?':'Riabilitare questo utente?')) return;
  try { await apiFetch('PUT','/admin/utenti/'+id,{attivo:attivo?0:1}); await renderAdmin(); toast('Aggiornato ✓'); } catch(e){ toast(e.message||'Errore', true); }
}
async function delUtente(id,username) {
  if(!await askConfirm('Eliminare "'+username+'"? I movimenti saranno conservati.', { ok: 'Elimina', danger: true })) return;
  try { await apiFetch('DELETE','/admin/utenti/'+id); await renderAdmin(); toast('Eliminato ✓'); } catch(e){ toast(e.message||'Errore', true); }
}

// ─── CAMBIA PASSWORD (tutti gli utenti) ───
async function salvaCambiaPwd() {
  const oldPwd  = document.getElementById('cambiaPwdOld').value;
  const newPwd  = document.getElementById('cambiaPwdNew').value;
  const confPwd = document.getElementById('cambiaPwdConf').value;
  if (!oldPwd) { toast('Inserisci la password attuale', true); return; }
  if (!newPwd || newPwd.length < 4) { toast('La nuova password deve avere almeno 4 caratteri', true); return; }
  if (newPwd !== confPwd) { toast('Le password non coincidono', true); return; }
  try {
    await apiFetch('POST', '/auth/change-password', { oldPassword: oldPwd, newPassword: newPwd });
    closeModal('modalCambiaPwd');
    document.getElementById('cambiaPwdOld').value = '';
    document.getElementById('cambiaPwdNew').value = '';
    document.getElementById('cambiaPwdConf').value = '';
    toast('Password aggiornata ✓');
  } catch(e) { toast(e.message||'Errore imprevisto — riprova', true); }
}

// ─── STAMPA CONTENUTO MAGAZZINO ───
// ─── STAMPA ───
// ─── STAMPE ───
// Helper condivisi dalle stampe della lista di carico e del contenuto di un magazzino.
const _PRINT_CSS = 'body{font-family:"Helvetica Neue",Arial,sans-serif;padding:32px;color:#1a1814;}h1{font-size:22px;margin-bottom:4px;}.sub{font-size:13px;color:#9a9287;margin-bottom:24px;}table{width:100%;border-collapse:collapse;font-size:12px;}th{background:#f4f1eb;padding:4px 8px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.5px;color:#5a5449;border-bottom:1px solid #ddd9cf;}td{padding:4px 8px;border-bottom:0.5px solid #ede9e0;vertical-align:middle;}.foot{margin-top:32px;font-size:11px;color:#9a9287;border-top:1px solid #ede9e0;padding-top:12px;}tr.catrow td{background:#e9e4d8;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.6px;padding:6px 8px;border-bottom:1px solid #ccc6b6;}tr.catrow span{float:right;font-family:monospace;}tr.catrow{break-after:avoid;}tr{break-inside:avoid;}.bx{display:inline-block;width:11px;height:11px;border:1px solid #9a9287;border-radius:2px;vertical-align:middle}.q{text-align:right;white-space:nowrap;font-weight:700;width:60px}.q .um{font-weight:400;color:#9a9287;font-size:11px}.nm{font-size:14px}.cod{font-family:monospace;font-size:10px;font-weight:400;color:#8a8275;white-space:nowrap}table.fx{table-layout:fixed}@media print{body{padding:16px;}}';
const _cmpCodice = (x, y) => String(x || '').localeCompare(String(y || ''), 'it', { numeric: true });

// Raggruppa i pezzi con varianti che hanno stesso modello e stessa variante (extra = chiave aggiuntiva, es. il case)
function _groupVar(items, qtyOf, extra) {
  const map = new Map(), out = [];
  for (const it of items) {
    const a = getArt(it.art_id);
    if (!a || !a.modello_id) { out.push(it); continue; }
    const k = a.modello_id + '|' + (a.variante || '') + '|' + (extra ? extra(it) : '');
    let g = map.get(k);
    if (!g) { g = { ...it, _grp: [], _items: [], _qty: 0 }; map.set(k, g); out.push(g); }
    g._grp.push(a); g._items.push(it); g._qty += qtyOf(it);
  }
  return out;
}
// Case di una riga di stampa (nei gruppi di pezzi: quantità sommate per case)
function _caseSum(s) {
  if (!s._items) return s._case;
  const m = new Map();
  s._items.forEach(it => (it._case || []).forEach(e => { const x = m.get(e.id); if (x) x.qty += e.qty; else m.set(e.id, { ...e }); }));
  return [...m.values()];
}
// Nome + variante + codici dei pezzi, per le righe raggruppate (html)
function _grpNome(g) {
  const a = g._grp[0], cod = [...new Set(g._grp.map(x => x.codice))].sort(_cmpCodice).join(', ');
  return h(modelloDi(a).nome) + ' <span style="color:#6b6358">· ' + h(a.variante || '—') + '</span><div style="font-size:10px;color:#9a9287;font-family:monospace;white-space:normal">' + h(cod) + '</div>';
}
// Raggruppa per categoria: Bauli/FLC/FLCK per primi, poi le altre nell'ordine della pagina Categorie; dentro, per codice
function _catGroups(items, artIdFn) {
  const rank = c => { const i = ['BAU', 'FLC', 'FLCK'].indexOf(c?.prefisso); return i >= 0 ? i - 10 : D.categorie.indexOf(c); };
  const by = new Map();
  items.forEach(it => { const k = getArt(artIdFn(it))?.cat_id ?? 0; if (!by.has(k)) by.set(k, []); by.get(k).push(it); });
  return [...by]
    .map(([cid, arr]) => ({ cat: getCat(cid), items: arr.sort((x, y) => _cmpCodice(getArt(artIdFn(x))?.codice, getArt(artIdFn(y))?.codice)) }))
    .sort((x, y) => rank(x.cat) - rank(y.cat));
}
// larghezze fisse (px) delle colonne: tutte tranne 'Articolo', che prende lo spazio rimasto
const _printCols = w => '<colgroup>' + w.map(x => x ? `<col style="width:${x}px">` : '<col>').join('') + '</colgroup>';
const _printCatRow = (cat, n, cols) => `<tr class="catrow"><td colspan="${cols}">${h(cat?.nome || 'Senza categoria')}<span>${n} pz</span></td></tr>`;
// Badge del FLC/FLCK che contiene l'articolo: cs = [{nome, codice, qty, tipo}]
function _printCaseBadge(cs, conQty) {
  return (cs || []).map(e => ` <span style="font-size:9px;background:#6b4c6e22;color:#6b4c6e;border:1px solid #6b4c6e44;padding:1px 5px;border-radius:3px;font-family:monospace;white-space:nowrap">${e.tipo === 'FLCK' ? 'FLCK' : 'FLC'} · ${h(e.nome)}${e.codice ? ' ' + h(e.codice) : ''}${conQty ? ' ×' + e.qty : ''}</span>`).join('');
}
// Etichetta con icona del tipo di contenitore (baule / flight case / flightcase K)
function _printTipoPill(artId) {
  const [col, txt] = isBauleArt(artId) ? ['#92400e', 'baule'] : isFlckArt(artId) ? [FLCK_COL, 'flightcase K'] : ['#6b4c6e', 'flight case'];
  const svg = `<svg width="10" height="10" viewBox="0 0 48 48" fill="none"><rect x="6" y="12" width="36" height="26" rx="2" stroke="${col}" stroke-width="3.5" fill="none"/><path d="M6 12l3-3h30l3 3" stroke="${col}" stroke-width="3" fill="none"/><rect x="6" y="12" width="4" height="4" rx="0.5" fill="${col}" opacity=".5"/><rect x="38" y="12" width="4" height="4" rx="0.5" fill="${col}" opacity=".5"/><rect x="6" y="34" width="4" height="4" rx="0.5" fill="${col}" opacity=".5"/><rect x="38" y="34" width="4" height="4" rx="0.5" fill="${col}" opacity=".5"/><line x1="6" y1="25" x2="42" y2="25" stroke="${col}" stroke-width="2" opacity=".5"/><circle cx="16" cy="25" r="2" fill="${col}" opacity=".5"/><circle cx="32" cy="25" r="2" fill="${col}" opacity=".5"/></svg>`;
  return ` <span style="font-size:9px;background:${col}22;color:${col};border:1px solid ${col}44;padding:1px 5px;border-radius:3px;font-family:monospace;display:inline-flex;align-items:center;gap:2px;vertical-align:middle">${svg} ${txt}</span>`;
}

// Contenuto di baule / FLC / FLCK, in righe rientrate sotto il contenitore.
// layout = ordine delle colonne della tabella: 'lista' (casella, qtà, nome, prelevato da, cod) | 'mag' (casella, qtà, nome, cod)
const _SUB_COLS = { lista: ['', 'qty', 'nome', '', 'cod'], mag: ['', 'qty', 'nome', 'cod'] };
const _SUB_STILE = {
  qty: 'font-size:12px;font-weight:600', nome: 'padding-left:14px;font-size:12px;color:#5a5449',
  cod: 'text-align:right;font-family:monospace;font-size:10px;color:#8a8275'
};
function _printSubRow(layout, cod, nome, qty, um) {
  const v = { qty: qty + (um ? ' <span class="um">' + h(um) + '</span>' : ''), nome: '↳ ' + nome, cod: h(cod || '') };
  return '<tr style="background:#faf8f3">' + _SUB_COLS[layout].map(c => c ? `<td${c === 'qty' ? ' class="q"' : ''} style="${_SUB_STILE[c]}">${v[c]}</td>` : '<td></td>').join('') + '</tr>';
}
function _printSubNote(layout, testo) {
  const cols = _SUB_COLS[layout], i = cols.indexOf('nome');
  return `<tr style="background:#faf8f3">${'<td></td>'.repeat(i)}<td colspan="${cols.length - i}" style="font-size:11px;color:#9a9287;font-style:italic;padding-left:14px">↳ ${testo}</td></tr>`;
}
async function _printBauVoci(artIds) {     // voci dei bauli indicati: { artId: [voci] }
  const map = {};
  await Promise.all(artIds.filter(isBauleArt).map(async id => {
    try { map[id] = await apiFetch('GET', `/bauli/${id}/voci`); } catch (e) { map[id] = []; }
  }));
  return map;
}
function _printContenuto(artId, bauVoci, layout) {
  const riga = (...a) => _printSubRow(layout, ...a), nota = t => _printSubNote(layout, t);
  if (isBauleArt(artId)) {
    const voci = bauVoci[artId] || [];
    return voci.length ? voci.map(v => riga('', h(v.nome), v.qty, '')).join('') : nota('Baule vuoto');
  }
  if (isFlightcaseArt(artId)) {
    const fc = getFlightcaseDef(artId), art = getArt(fc?.art_id_contenuto);
    return fc && fc.qty_caricata > 0 ? riga(art?.codice, h(fc.art_contenuto_nome || '—'), fc.qty_caricata, art?.um) : nota('Flight case vuoto');
  }
  if (isFlckArt(artId)) {
    const voci = (getFlck(artId)?.voci || []).filter(v => v.qty_caricata > 0);
    return voci.length
      ? _groupVar(voci, v => v.qty_caricata, null).map(v => v._grp ? riga('', _grpNome(v), v._qty, v.um) : riga(v.art_codice, h(v.art_nome), v.qty_caricata, v.um)).join('')
      : nota('Flightcase K vuoto');
  }
  return '';
}

function _printInFrame(htmlContent) {
  const frame = document.getElementById('printFrame');
  frame.srcdoc = htmlContent;
  frame.onload = () => { frame.contentWindow.focus(); frame.contentWindow.print(); };
}

// Stampa della lista di carico aperta
async function stampaTesto() {
  const lista = _listaCorrente;
  if (!lista) return;
  const righe = lista.righe || [];
  const bauVoci = await _printBauVoci(righe.map(r => r.art_id));
  const dest = lista.mag_dest_nome ? ' → ' + h(lista.mag_dest_nome) : '';
  const rigaLista = r => {
    const its = r._items || [r];                       // nei gruppi di pezzi: righe e flag sommati
    const prese = new Map();                           // magazzino -> quantità da prelevare
    its.forEach(it => (it.flags || []).forEach(f => prese.set(f.mag_id, (prese.get(f.mag_id) || 0) + (+f.qty_presa || 0))));
    const flags = [...prese].map(([mid, q]) => '<span style="font-size:11px;background:#f4f1eb;padding:1px 6px;border-radius:3px;margin-right:4px;white-space:nowrap;display:inline-block">' + h(getMag(mid)?.nome || '?') + ' <strong>' + q + '</strong></span>').join('');
    const magPresa = [...prese].filter(([, q]) => q > 0).map(([mid]) => String(mid));
    const case_ = new Map();                           // FLC/FLCK che contengono l'articolo (nei magazzini di prelievo, o in tutti se non ancora scelti)
    its.forEach(it => {
      const perMag = D._contMap?.[it.art_id] || {};
      (magPresa.length ? magPresa : Object.keys(perMag)).forEach(mid => (perMag[mid]?.case || []).forEach(e => case_.set(e.id, e)));
    });
    const codice = r._grp ? modelloDi(getArt(r.art_id)).codice || r.art_codice : r.art_codice;
    return '<tr><td style="width:22px;padding-right:0"><span class="bx"></span></td><td class="q" style="font-size:16px">' + r.qty_richiesta + ' <span class="um">' + h(r.art_um || 'pz') + '</span></td><td class="nm">' + (r._grp ? _grpNome(r) : h(r.art_nome || '—')) + _printCaseBadge([...case_.values()], false) + '</td><td>' + (flags || '—') + '</td><td class="cod" style="text-align:right">' + h(codice || '—') + '</td></tr>' + _printContenuto(r.art_id, bauVoci, 'lista');
  };
  const righeGrp = _groupVar(righe, r => +r.qty_richiesta || 0, null);      // pezzi con varianti: una riga per modello+variante
  righeGrp.forEach(g => { if (g._grp) g.qty_richiesta = g._qty; });
  const rows = _catGroups(righeGrp, r => r.art_id).map(g => _printCatRow(g.cat, g.items.reduce((n, r) => n + (+r.qty_richiesta || 0), 0), 5) + g.items.map(rigaLista).join('')).join('');
  const now = new Date();
  _printInFrame('<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><title>Lista — ' + h(lista.nome) + '</title><style>' + _PRINT_CSS + '</style></head><body><h1>' + h(lista.nome) + '</h1><div class="sub">' + righe.length + ' articoli' + dest + (lista.note ? ' · ' + h(lista.note) : '') + '</div><table class="fx">' + _printCols([22, 64, 0, 270, 84]) + '<thead><tr><th></th><th style="text-align:right">Qtà</th><th>Articolo</th><th>Prelevato da</th><th style="text-align:right">Codice</th></tr></thead><tbody>' + rows + '</tbody></table><div class="foot">Stampato il ' + now.toLocaleDateString('it-IT') + ' alle ' + now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) + ' · WareFlow</div></body></html>');
}

// Modalità di stampa del magazzino (cursore nel modale): tutto | articoli | contenitori
const _STAMPA_MODI = [
  { id: 'tutto', hint: 'Articoli, bauli e case con il loro contenuto' },
  { id: 'articoli', hint: 'Solo articoli (anche quelli nei case), senza bauli, FLC e FLCK' },
  { id: 'contenitori', hint: 'Solo bauli, FLC e FLCK con il contenuto espanso' }
];
let _stampaMod = 0;
function setStampaMod(i) {
  _stampaMod = i;
  document.querySelector('#printSl .knob').style.left = (16.6 + 33.3 * i) + '%';
  document.querySelectorAll('#printSl .tk').forEach((b, j) => b.classList.toggle('on', i === j));
  document.getElementById('printHint').textContent = _STAMPA_MODI[i].hint;
}

// Stampa del contenuto del magazzino aperto, secondo la modalità scelta nel cursore (_stampaMod):
//  tutto = articoli + bauli/FLC/FLCK con contenuto · articoli = solo articoli (anche nei case, con badge) · contenitori = solo bauli/FLC/FLCK con contenuto
async function stampaMagDetail() {
  const modo = _STAMPA_MODI[_stampaMod].id, soloArt = modo === 'articoli', soloCont = modo === 'contenitori';
  const m = getMag(_detailMagId);
  const cf = document.getElementById('filterCatDetail').value;
  let righe = righeMagConContenuti(_detailMagId);
  if (cf) righe = righe.filter(s => getArt(s.art_id)?.cat_id == cf);
  if (soloArt) righe = righe.filter(s => !isSpecialArt(s.art_id));
  if (soloCont) righe = righe.filter(s => isSpecialArt(s.art_id));
  const totale = righe.reduce((n, s) => n + (isSpecialArt(s.art_id) ? 0 : s.qty), 0);
  const bauVoci = await _printBauVoci(righe.map(s => s.art_id));
  const rigaMag = s => {
    const a = getArt(s.art_id), special = isSpecialArt(s.art_id);
    const codice = s._grp ? modelloDi(a).codice || a?.codice : a?.codice;
    return `<tr${special ? ' style="background:#fdf8f0"' : ''}>
      <td style="width:22px;padding-right:0"><span class="bx"></span></td>
      <td class="q" style="font-size:16px">${s.qty} <span class="um">${h(a?.um) || 'pz'}</span></td>
      <td class="nm">${s._grp ? _grpNome(s) : (h(a?.nome) || '—')}${special ? _printTipoPill(s.art_id) : _printCaseBadge(_caseSum(s), true)}</td>
      <td class="cod" style="text-align:right">${h(codice) || '—'}</td>
    </tr>` + _printContenuto(s.art_id, bauVoci, 'mag');
  };
  // pezzi con varianti: una riga per modello+variante, separati tra liberi e dentro ciascun FLC/FLCK
  const righeGrp = _groupVar(righe, s => s.qty, s => (s._case || []).map(e => e.tipo + e.id).sort().join(','));
  righeGrp.forEach(g => { if (g._grp) g.qty = g._qty; });
  const rows = _catGroups(righeGrp, s => s.art_id).map(g => _printCatRow(g.cat, g.items.reduce((n, s) => n + s.qty, 0), 4) + g.items.map(rigaMag).join('')).join('');
  _printInFrame(`<!DOCTYPE html><html lang="it"><head>
    <meta charset="UTF-8">
    <title>Contenuto — ${h(m.nome)}</title>
    <style>${_PRINT_CSS}.totale{margin-top:16px;font-size:13px;color:#5a5449;text-align:right;}</style>
  </head><body>
    <h1>${h(m.nome)}</h1>
    <div class="sub">${m.citta ? h(m.citta) + ' · ' : ''}${soloCont ? righe.length + ' contenitori' : totale + ' pezzi totali'}${soloArt ? ' · solo articoli' : ''}${soloCont ? ' · solo contenitori' : ''}${cf ? ' · filtro categoria attivo' : ''}</div>
    <table class="fx">
      ${_printCols([22, 64, 0, 84])}
      <thead><tr><th></th><th style="text-align:right">Qtà</th><th>Articolo</th><th style="text-align:right">Codice</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totale">Totale: ${soloCont ? `<strong>${righe.length} contenitori</strong>` : `<strong>${totale} pezzi</strong> in ${righe.length} articoli`}</div>
    <div class="foot">Stampato il ${new Date().toLocaleDateString('it-IT')} alle ${new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })} · WareFlow</div>
  </body></html>`);
}


// ─── SUONI ───

function _doLoginSound(ac) {
  // Pad caldo (accordo A minore)
  [220, 277.2, 329.6, 440].forEach(freq => {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0, ac.currentTime);
    g.gain.linearRampToValueAtTime(0.06, ac.currentTime + 0.4);
    g.gain.setValueAtTime(0.06, ac.currentTime + 0.85);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 1.6);
    o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + 1.7);
  });

  // Glissando arpa finale
  [523.3, 659.3, 784, 1046.5, 1318.5, 1568].forEach((freq, i) => {
    const t = ac.currentTime + 0.95 + i * 0.06;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.13 - i * 0.015, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g); g.connect(ac.destination);
    o.start(t); o.stop(t + 0.5);
  });
}

function playLoginSound() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    ac.resume().then(() => {
      if (ac.state === 'running') {
        _doLoginSound(ac);
      } else {
        // iOS/iPadOS: AudioContext ancora suspended — aspetta primo tap
        const unlock = () => {
          ac.resume().then(() => {
            if (ac.state === 'running') _doLoginSound(ac);
          }).catch(()=>{});
          document.removeEventListener('touchstart', unlock, true);
          document.removeEventListener('click', unlock, true);
        };
        document.addEventListener('touchstart', unlock, true);
        document.addEventListener('click', unlock, true);
      }
    }).catch(()=>{});
  } catch(e) {}
}

function playSpostamentoSound() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    ac.resume().then(() => {
      // Swoosh lento crescente
      const bufLen = ac.sampleRate * 0.42;
      const buf = ac.createBuffer(1, bufLen, ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++)
        d[i] = (Math.random() * 2 - 1) * Math.pow(i / bufLen, 0.4) * Math.pow(1 - i / bufLen, 0.8);
      const src = ac.createBufferSource(); src.buffer = buf;
      const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 0.6;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.15, ac.currentTime);
      g.gain.linearRampToValueAtTime(0.5, ac.currentTime + 0.25);
      g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.46);
      src.connect(f); f.connect(g); g.connect(ac.destination);
      src.start(); src.stop(ac.currentTime + 0.5);

      // Bump risonante
      const o = ac.createOscillator(), og = ac.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(160, ac.currentTime + 0.4);
      o.frequency.exponentialRampToValueAtTime(40, ac.currentTime + 0.58);
      og.gain.setValueAtTime(0.45, ac.currentTime + 0.4);
      og.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.65);
      o.connect(og); og.connect(ac.destination);
      o.start(ac.currentTime + 0.4); o.stop(ac.currentTime + 0.7);

      // Risonanza finale
      const o2 = ac.createOscillator(), og2 = ac.createGain();
      o2.type = 'sine'; o2.frequency.value = 110;
      og2.gain.setValueAtTime(0.08, ac.currentTime + 0.48);
      og2.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.75);
      o2.connect(og2); og2.connect(ac.destination);
      o2.start(ac.currentTime + 0.48); o2.stop(ac.currentTime + 0.8);
    }).catch(()=>{});
  } catch(e) {}
}


// ─── BAULI ───

let _bauleCorrente = null;

function renderBauli() {
  _bauliTabCounts();
  // Reset to bauli tab
  if (_bauliTab === 'flc' || _bauliTab === 'flck') { switchBauliTab(_bauliTab); return; }
  const grid = document.getElementById('bauliGrid');
  document.getElementById('bauleDettaglio').style.display = 'none';
  grid.style.display = '';

  if (!D.bauli.length) {
    _btRender(grid, [], 'Nessun baule — clicca "+ Baule" per crearne uno');
    return;
  }

  _btRender(grid, D.bauli.map(b => ({
    nome: b.nome, cod: b.codice, sub: '', col: _btCol('BAU', '#92400e'),
    chip: b.n_voci > 0 ? `${b.n_voci} VOCI` : 'VUOTO', ok: b.n_voci > 0,
    id: b.id, dupOk: true, onOpen: `apriBaule(${b.id})`, delOk: true, onDel: `eliminaBaule(${b.id})`
  })), '');
}

async function apriBaule(id) {
  const b = D.bauli.find(x => x.id === id);
  if (!b) return;
  _bauleCorrente = b;

  document.getElementById('bauliGrid').style.display = 'none';
  document.getElementById('bauleDettaglio').style.display = '';
  document.getElementById('bauleDetNome').textContent = b.nome;
  document.getElementById('bauleDetCodice').innerHTML = `<span class="badge-codice" style="background:#92400e;color:#ffffff">${h(b.codice)}</span>`;

  await caricaVociBaule();
}

async function caricaVociBaule() {
  if (!_bauleCorrente) return;
  const voci = await apiFetch('GET', `/bauli/${_bauleCorrente.id}/voci`);
  _bauleCorrente._voci = voci;
  renderVociBaule(voci);
}

function renderVociBaule(voci) {
  const badgeEl = document.getElementById('bauleDetBadge');
  if (voci.length > 0) {
    badgeEl.textContent = `${voci.length} voci`;
    badgeEl.className = 'baule-badge compilato';
  } else {
    badgeEl.textContent = 'vuoto';
    badgeEl.className = 'baule-badge vuoto';
  }

  document.getElementById('bauleVociList').innerHTML = voci.length
    ? voci.map(v => `
        <div class="baule-voce-row" id="baule-voce-${v.id}">
          <div class="baule-voce-nome">${h(v.nome)}</div>
          <div style="display:flex;align-items:center;gap:4px">
            <button class="btn btn-ghost btn-xs" style="padding:2px 7px;font-size:14px;line-height:1" onclick="stepVoceBaule(${v.id},-1)">−</button>
            <span class="baule-voce-qty" id="baule-voce-qty-${v.id}">${v.qty}</span>
            <button class="btn btn-ghost btn-xs" style="padding:2px 7px;font-size:14px;line-height:1" onclick="stepVoceBaule(${v.id},+1)">+</button>
          </div>
          <button class="btn btn-danger btn-xs" onclick="eliminaVoceBaule(${v.id})">✕</button>
        </div>`)
      .join('')
    : '<div class="empty" style="padding:16px 0">Baule vuoto — aggiungi il contenuto qui sotto</div>';
}

async function stepVoceBaule(id, delta) {
  const qtyEl = document.getElementById(`baule-voce-qty-${id}`);
  if (!qtyEl) return;
  const curr = parseInt(qtyEl.textContent) || 1;
  const nuova = Math.max(1, curr + delta);
  if (nuova === curr) return;
  qtyEl.textContent = nuova;
  try {
    const v = _bauleCorrente._voci?.find(x => x.id === id);
    await apiFetch('PUT', `/bauli/voci/${id}`, { nome: v?.nome || '', qty: nuova });
    if (v) v.qty = nuova;
  } catch(e) {
    qtyEl.textContent = curr; // ripristina se errore
    toast('Errore aggiornamento quantità', true);
  }
}

async function aggiungiVoceBaule() {
  const nome = document.getElementById('bauleNuovaVoce').value.trim();
  const qty  = parseInt(document.getElementById('bauleNuovaQty').value) || 1;
  if (!nome) { toast("Inserisci il nome dell'articolo", true); return; }
  try {
    await apiFetch('POST', `/bauli/${_bauleCorrente.id}/voci`, { nome, qty });
    document.getElementById('bauleNuovaVoce').value = '';
    document.getElementById('bauleNuovaQty').value  = '';
    await caricaVociBaule();
    await _aggiornaBauliD();
  } catch(e) { toast(e.message || 'Errore', true); }
}

async function eliminaVoceBaule(id) {
  try {
    await apiFetch('DELETE', `/bauli/voci/${id}`);
    await caricaVociBaule();
    await _aggiornaBauliD();
  } catch(e) { toast(e.message || 'Errore', true); }
}

function chiudiBauleDettaglio() {
  _bauleCorrente = null;
  document.getElementById('bauleDettaglio').style.display = 'none';
  document.getElementById('bauliGrid').style.display = '';
  // Riaggiorna le card per riflettere il conteggio voci aggiornato
  _aggiornaBauliD().then(() => renderBauli());
}

// Modifica (solo admin): _btEdit = id dell'elemento in modifica, null = creazione nuova
let _btEdit = null;
function modificaBt(id) {
  if (isBauleArt(id)) openModalBauleEdit(id);
  else if (isFlckArt(id)) openModalFlckEdit(id);
  else openModalFlcEdit(id);
}
// dopo una modifica: ricarica tutto (nomi e note compaiono anche in liste, stock, storico) e ridisegna l'elenco aperto
async function _btDopoModifica(msg) {
  await load();
  ({ bauli: renderBauli, flc: renderFlc, flck: renderFlck })[_bauliTab]();
  toast(msg);
}
function _bauleForm(edit) {
  document.getElementById('bauleTitle').textContent = edit ? 'Modifica baule' : 'Nuovo baule';
  document.getElementById('bauleMagGrp').style.display = edit ? 'none' : '';
  document.getElementById('bauleSalvaBtn').textContent = edit ? 'Salva' : 'Crea baule';
}
function openModalBauleNew() {
  _btEdit = null; _bauleForm(false);
  document.getElementById('bauleNome').value = '';
  document.getElementById('bauleNote').value = '';
  const sel = document.getElementById('bauleMagId');
  sel.innerHTML = '<option value="">— Seleziona magazzino —</option>' +
    getMagReali().map(m => `<option value="${m.id}">${m.icona||'🏭'} ${h(m.nome)}</option>`).join('');
  openModal('modalBaule');
}
function openModalBauleEdit(id) {
  const a = getArt(id); if (!a) return;
  _btEdit = id; _bauleForm(true);
  document.getElementById('bauleNome').value = a.nome;
  document.getElementById('bauleNote').value = a.note || '';
  openModal('modalBaule');
}

async function salvaBaule() {
  const nome  = document.getElementById('bauleNome').value.trim();
  const note  = document.getElementById('bauleNote').value.trim();
  const mag_id = +document.getElementById('bauleMagId').value;
  if (!nome)   { toast('Nome obbligatorio', true); return; }
  if (!_btEdit && !mag_id) { toast('Seleziona un magazzino', true); return; }
  try {
    if (_btEdit) {
      await apiFetch('PUT', `/bauli/${_btEdit}`, { nome, note });
      closeModal('modalBaule');
      await _btDopoModifica('Baule modificato ✓');
      return;
    }
    await apiFetch('POST', '/bauli', { nome, note, mag_id });
    closeModal('modalBaule');
    // Ricarica articoli, stock, spostamenti e bauli
    await Promise.all([
      loadPartial('spostamenti'),
      _aggiornaBauliD()
    ]);
    renderBauli();
    toast('Baule creato ✓');
  } catch(e) { toast(e.message || 'Errore', true); }
}

// Duplica baule / flight case / flightcase K (solo admin; le regole le controlla il server)
async function duplicaBt(id) {
  try {
    const r = await apiFetch('POST', `/duplica/${id}`);
    await Promise.all([loadPartial('spostamenti'), _aggiornaBauliD()]);
    ({ bauli: renderBauli, flc: renderFlc, flck: renderFlck })[_bauliTab]();
    toast(`Creato "${r.nome}" (${r.codice}) ✓` + (r.saltate ? ` · ${r.saltate} pezzi univoci non copiati` : ''));
  } catch (e) {}
}

async function eliminaBaule(id) {
  const b = D.bauli.find(x => x.id === id) || D.flightcase.find(x => x.id === id);
  if (!b) { toast('Elemento non trovato', true); return; }
  const isB = isBauleArt(id), tipo = isB ? 'baule' : 'flight case';
  const dove = D.stock.filter(s => s.art_id==id && s.qty>0).map(s => getMag(s.mag_id)?.nome).filter(Boolean).join(', ');
  let extra = isB ? '\nLe voci del baule verranno cancellate.' : '';
  if (!isB) { const fc = getFlightcaseDef(id); if (fc && fc.qty_caricata > 0) extra = `\nI ${fc.qty_caricata} pz di "${fc.art_contenuto_nome||'articolo'}" contenuti tornano in stock${dove ? ` in "${dove}"` : ''}.`; }
  if (!await askConfirm(`Eliminare definitivamente "${b.nome}" (${tipo})${dove ? `, presente in: ${dove}` : ''}?${extra}\nOperazione irreversibile.`, { ok: 'Elimina', danger: true })) return;
  try {
    await apiFetch('DELETE', `/bauli/${id}`);
    await Promise.all([loadPartial('spostamenti'), _aggiornaBauliD()]);
    if (_bauliTab === 'flc') renderFlc(); else renderBauli();
    toast(`"${b.nome}" eliminato ✓`);
  } catch(e) {}
}

// Ricarica bauli, articoli e stock in parallelo
async function _aggiornaBauliD() {
  const [bauli, flightcase, articoli, stock, flck, modelli] = await Promise.all([
    apiFetch('GET', '/bauli'),
    apiFetch('GET', '/flightcase'),
    apiFetch('GET', '/articoli'),
    apiFetch('GET', '/stock'),
    apiFetch('GET', '/flck'),
    apiFetch('GET', '/modelli')
  ]);
  D.bauli = bauli;
  D.flightcase = flightcase;
  D.flck = flck;
  D.modelli = modelli;
  D.articoli = articoli;
  D.stock = stock;
  _rebuildMaps();
  aggiornaNavBadge();
}

// ─── FLIGHT CASE ───

let _bauliTab = 'bauli';

function switchBauliTab(tab) {
  _bauliTab = tab;
  document.getElementById('tabBauli').classList.toggle('active', tab === 'bauli');
  document.getElementById('tabFlc').classList.toggle('active', tab === 'flc');
  document.getElementById('tabFlck').classList.toggle('active', tab === 'flck');
  document.getElementById('bauliTabContent').style.display = tab === 'bauli' ? '' : 'none';
  document.getElementById('flcTabContent').style.display = tab === 'flc' ? '' : 'none';
  document.getElementById('flckTabContent').style.display = tab === 'flck' ? '' : 'none';
  const nb = document.getElementById('bauliNewBtn');
  if (nb) nb.textContent = { bauli: '+ Baule', flc: '+ Flight Case', flck: '+ Flightcase K' }[tab];
  _bauliTabCounts();
  if (tab === 'flc') renderFlc();
  if (tab === 'flck') renderFlck();
}
function nuovoBauliCorrente() {
  ({ bauli: openModalBauleNew, flc: openModalFlcNew, flck: openModalFlckNew })[_bauliTab]();
}
function _bauliTabCounts() {
  const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
  set('tabBauliN', (D.bauli || []).length); set('tabFlcN', (D.flightcase || []).length); set('tabFlckN', (D.flck || []).length);
}

// ── Riquadri / lista compatta per Bauli, Flight Case, Flightcase K ──
let _bauliView = (() => { try { return localStorage.getItem('bauliView') === 'list' ? 'list' : 'tile'; } catch (e) { return 'tile'; } })();
function _btCol(pref, fb) { const c = (D.categorie || []).find(x => x.prefisso === pref); return (c && c.colore) || fb; }
const _BT_SVG = '<svg width="52" height="52" viewBox="0 0 48 48" fill="none" stroke="currentColor"><rect x="6" y="12" width="36" height="26" rx="2" stroke-width="2.5"/><path d="M6 12l3-3h30l3 3" stroke-width="2"/><line x1="6" y1="25" x2="42" y2="25" stroke-width="1.8"/><circle cx="16" cy="25" r="2.5" fill="currentColor" stroke="none"/><circle cx="32" cy="25" r="2.5" fill="currentColor" stroke="none"/></svg>';
function _btSyncToggle() {
  document.getElementById('btvTile')?.classList.toggle('on', _bauliView !== 'list');
  document.getElementById('btvList')?.classList.toggle('on', _bauliView === 'list');
}
function setBauliView(v) {
  _bauliView = v === 'list' ? 'list' : 'tile';
  try { localStorage.setItem('bauliView', _bauliView); } catch (e) {}
  _btSyncToggle();
  // con un dettaglio aperto il cambio vale al ritorno all'elenco
  const open = ['bauleDettaglio', 'flcDettaglio', 'flckDettaglio'].some(id => document.getElementById(id)?.style.display === '');
  if (open) return;
  ({ bauli: renderBauli, flc: renderFlc, flck: renderFlck })[_bauliTab]();
}
function _btRender(grid, items, vuoto) {
  _btSyncToggle();
  if (!items.length) { grid.className = 'bt-grid'; grid.innerHTML = `<div class="lk-empty" style="grid-column:1/-1">${vuoto}</div>`; return; }
  const admin = currentUser?.ruolo === 'admin';
  const list = _bauliView === 'list';
  const del = i => !admin ? '' : i.delOk
    ? `<button class="bt-del" title="Elimina" aria-label="Elimina" onclick="event.stopPropagation();${i.onDel}">✕</button>`
    : `<button class="bt-del off" title="Sposta nel cestino prima di eliminare" aria-label="Elimina non disponibile" onclick="event.stopPropagation()">✕</button>`;
  const dup = i => !admin ? '' : i.dupOk
    ? `<button class="bt-dup" title="Duplica" aria-label="Duplica" onclick="event.stopPropagation();duplicaBt(${i.id})">⧉</button>`
    : `<button class="bt-dup off" title="Svuota prima il case per duplicarlo" aria-label="Duplica non disponibile" onclick="event.stopPropagation()">⧉</button>`;
  const edt = i => !admin ? '' : `<button class="bt-dup bt-edt" title="Modifica" aria-label="Modifica" onclick="event.stopPropagation();modificaBt(${i.id})">✎</button>`;
  const chip = i => `<span class="bt-chip ${i.ok ? 'ok' : 'no'}">${h(i.chip)}</span>`;
  const cod = i => h(i.cod) + (i.sub ? ' · ' + h(i.sub) : '');
  const pos = i => { const m = getMag(D.stock.find(s => s.art_id == i.id && s.qty > 0)?.mag_id); return m ? { ic: h(m.icona || '📍'), nome: h(m.nome), col: m.colore || 'var(--ink3)' } : null; };
  grid.className = list ? 'bt-list' : 'bt-grid';
  grid.innerHTML = items.map(i => list
    ? (p => `<div class="bt-row" style="--bc:${i.col}" onclick="${i.onOpen}"><i class="bt-dot"></i><span class="bt-rn"><span>${h(i.nome)}</span>${p ? `<span class="bt-rl">📍 ${p.nome}</span>` : ''}</span><span class="bt-rc">${cod(i)}</span>${p ? `<span class="bt-pos2" style="--mc:${p.col}">${p.ic} ${p.nome}</span>` : ''}${chip(i)}${edt(i)}${dup(i)}${del(i)}</div>`)(pos(i))
    : (p => `<div class="bt-card" style="--bc:${i.col}" onclick="${i.onOpen}">${edt(i)}${dup(i)}${del(i)}<div class="bt-band">${p ? `<span class="bt-pos">${p.ic} ${p.nome}</span>` : ''}${_BT_SVG}</div><div class="bt-foot"><div class="bt-nome">${h(i.nome)}</div><div class="bt-r2"><span class="bt-cod">${cod(i)}</span>${chip(i)}</div></div></div>`)(pos(i))
  ).join('');
}

function renderFlc() {
  const grid = document.getElementById('flcGrid');
  _bauliTabCounts();
  _btRender(grid, D.flightcase.map(fc => ({
    nome: fc.nome, cod: fc.codice, sub: fc.art_contenuto_nome || '', col: _btCol('FLC', '#6b4c6e'),
    chip: `${fc.qty_caricata || 0}/${fc.qty_max}`, ok: fc.qty_caricata > 0,
    id: fc.id, dupOk: !(fc.qty_caricata > 0), onOpen: `apriFlc(${fc.id})`, delOk: true, onDel: `eliminaBaule(${fc.id})`
  })), 'Nessun flight case — clicca "+ Flight Case" per crearne uno');
}

let _flcCorrente = null;

// Riga di contenuto (FLC e FLCK): max assente = nessuna barra (pezzi univoci); disp assente = nessuna disponibilità
function _contRiga({ cod, colore, nome, qty, max, disp, azioni }) {
  const pct = max > 0 ? Math.round(qty / max * 100) : 0;
  const stato = pct >= 100 ? 'full' : pct > 0 ? 'part' : '';
  const sub = (max ? `<div class="cr-bar"><i class="${stato}" style="width:${pct}%"></i></div><span class="cr-n">${qty}/${max}</span>` : '')
    + (disp != null ? `<span>${disp} disp.</span>` : '');
  return `<div class="cr"><div class="cr-main"><div class="cr-top">${codiceBadge(cod, colore)} ${nome}</div>${sub ? `<div class="cr-sub">${sub}</div>` : ''}</div><div class="cr-az">${azioni}</div></div>`;
}
// Quantità con − / + (l'input resta leggibile da caricaFlc / caricaVoceFlck)
function _contQty(id) {
  return `<div class="cr-stp"><button type="button" onclick="_stepQty('${id}',-1)">−</button><input type="number" id="${id}" min="1" value="1" autocomplete="off"><button type="button" onclick="_stepQty('${id}',1)">+</button></div>`;
}
function _stepQty(id, d) {
  const i = document.getElementById(id);
  i.value = Math.max(1, (parseInt(i.value) || 1) + d);
}

function apriFlc(id) {
  const fc = D.flightcase.find(x => x.id === id);
  if (!fc) return;
  _flcCorrente = fc;
  document.getElementById('flcGrid').style.display = 'none';
  document.getElementById('flcDettaglio').style.display = '';
  renderFlcDettaglio();
}

function renderFlcDettaglio() {
  const fc = _flcCorrente;
  if (!fc) return;
  document.getElementById('flcDetNome').textContent = fc.nome;
  document.getElementById('flcDetCodice').innerHTML = `<span style="font-family:'DM Mono',monospace;font-size:12px;color:var(--ink3);margin-left:8px">${h(fc.codice)}</span>`;
  const badge = fc.qty_caricata > 0
    ? `<span class="baule-badge compilato">${fc.qty_caricata} / ${fc.qty_max}</span>`
    : `<span class="baule-badge vuoto">vuoto</span>`;
  document.getElementById('flcDetBadge').innerHTML = badge;

  const fcStockEntries = D.stock.filter(s => s.art_id === fc.id && s.qty > 0);
  const magReale = fcStockEntries.find(s => !getMag(s.mag_id)?.virtuale);
  const artStockInMag = magReale ? getStock(fc.art_id_contenuto, magReale.mag_id) : 0;
  document.getElementById('flcContInfo').innerHTML = _contRiga({
    cod: fc.art_contenuto_codice, colore: fc.art_contenuto_cat_colore, nome: `<strong>${h(fc.art_contenuto_nome || '—')}</strong>`,
    qty: fc.qty_caricata, max: fc.qty_max, disp: artStockInMag,
    azioni: _contQty('flcQtyAction') + `<button class="btn btn-dark btn-xs" onclick="caricaFlc()">↓ Carica</button><button class="btn btn-ghost btn-xs" onclick="scaricaFlc()">↑ Scarica</button>`
  });

  if (magReale) {
    const magNome = getMag(magReale.mag_id)?.nome || '—';
    document.getElementById('flcStockInfo').innerHTML = `📍 Il case è in <strong>${h(magNome)}</strong> — ${h(fc.art_contenuto_nome||'articolo')}: <strong>${artStockInMag}</strong> disponibili nello stesso magazzino`;
  } else {
    document.getElementById('flcStockInfo').innerHTML = `⚠️ Il flight case non è in nessun magazzino reale`;
  }
}

function chiudiFlcDettaglio() {
  _flcCorrente = null;
  document.getElementById('flcDettaglio').style.display = 'none';
  document.getElementById('flcGrid').style.display = '';
  _aggiornaBauliD().then(() => renderFlc());
}

async function caricaFlc() {
  if (!_flcCorrente) return;
  const qty = parseInt(document.getElementById('flcQtyAction').value);
  if (isNaN(qty) || qty <= 0) { toast('Quantità non valida', true); return; }
  try {
    await apiFetch('POST', `/flightcase/${_flcCorrente.id}/carica`, { qty });
    await _aggiornaBauliD();
    _flcCorrente = D.flightcase.find(x => x.id === _flcCorrente.id);
    renderFlcDettaglio();
    toast(`${qty} pz caricati nel case ✓`);
  } catch(e) { toast(e.message || 'Errore', true); }
}

async function scaricaFlc() {
  if (!_flcCorrente) return;
  const qty = parseInt(document.getElementById('flcQtyAction').value);
  if (isNaN(qty) || qty <= 0) { toast('Quantità non valida', true); return; }
  try {
    await apiFetch('POST', `/flightcase/${_flcCorrente.id}/scarica`, { qty });
    await _aggiornaBauliD();
    _flcCorrente = D.flightcase.find(x => x.id === _flcCorrente.id);
    renderFlcDettaglio();
    toast(`${qty} pz scaricati dal case ✓`);
  } catch(e) { toast(e.message || 'Errore', true); }
}

function _flcForm(edit) {
  document.getElementById('modalFlcTitle').textContent = edit ? 'Modifica Flight Case' : 'Nuovo Flight Case';
  document.getElementById('flcMagGrp').style.display = edit ? 'none' : '';
  document.getElementById('flcSalvaBtn').textContent = edit ? 'Salva' : 'Crea flight case';
}
// menù dell'articolo contenuto (esclude bauli, FLC, FLCK e pezzi con varianti)
function _flcPopolaArticoli() {
  const pfx = ['BAU', 'FLC', 'FLCK'].map(p => D.categorie.find(c => c.prefisso === p)?.id);
  const artFiltrati = D.articoli.filter(a => !pfx.includes(a.cat_id) && !a.modello_id);
  document.getElementById('flcArtContenuto').innerHTML = '<option value="">— Seleziona articolo —</option>' +
    artFiltrati.map(a => `<option value="${a.id}" data-cat="${a.cat_id}">[${h(a.codice)}] ${h(a.nome)}${a.variante?' · '+h(a.variante):''}</option>`).join('');
  _riempiCatSel('flcArtCat', 'flcArtContenuto');
}
function openModalFlcNew() {
  _btEdit = null; _flcForm(false);
  document.getElementById('flcNome').value = '';
  document.getElementById('flcNote').value = '';
  document.getElementById('flcQtyMax').value = '1';
  const selMag = document.getElementById('flcMagId');
  selMag.innerHTML = '<option value="">— Seleziona magazzino —</option>' +
    getMagReali().map(m => `<option value="${m.id}">${m.icona||'🏭'} ${h(m.nome)}</option>`).join('');
  document.getElementById('flcArtGrp').style.display = '';
  _flcPopolaArticoli();
  openModal('modalFlc');
}
function openModalFlcEdit(id) {
  const a = getArt(id), fc = D.flightcase.find(x => x.id === id); if (!a || !fc) return;
  _btEdit = id; _flcForm(true);
  document.getElementById('flcNome').value = a.nome;
  document.getElementById('flcNote').value = a.note || '';
  document.getElementById('flcQtyMax').value = fc.qty_max;
  // l'articolo contenuto si cambia solo a case vuoto
  document.getElementById('flcArtGrp').style.display = fc.qty_caricata > 0 ? 'none' : '';
  _flcPopolaArticoli();
  document.getElementById('flcArtContenuto').value = fc.art_id_contenuto;
  openModal('modalFlc');
}

async function salvaFlc() {
  const nome = document.getElementById('flcNome').value.trim();
  const mag_id = document.getElementById('flcMagId').value;
  const art_id_contenuto = document.getElementById('flcArtContenuto').value;
  const qty_max = document.getElementById('flcQtyMax').value;
  const note = document.getElementById('flcNote').value.trim();
  if (!nome) { toast('Nome obbligatorio', true); return; }
  if (!_btEdit && !mag_id) { toast('Seleziona un magazzino', true); return; }
  if (!art_id_contenuto) { toast('Seleziona l\'articolo contenuto', true); return; }
  if (!qty_max || parseInt(qty_max) < 1) { toast('Capienza non valida', true); return; }
  try {
    if (_btEdit) {
      await apiFetch('PUT', `/bauli/${_btEdit}`, { nome, note, art_id_contenuto: +art_id_contenuto, qty_max: +qty_max });
      closeModal('modalFlc');
      await _btDopoModifica('Flight case modificato ✓');
      return;
    }
    await apiFetch('POST', '/flightcase', { nome, note, mag_id: +mag_id, art_id_contenuto: +art_id_contenuto, qty_max: +qty_max });
    closeModal('modalFlc');
    await _aggiornaBauliD();
    switchBauliTab('flc');
    toast('Flight case creato ✓');
  } catch(e) { toast(e.message || 'Errore', true); }
}

// ─── FLIGHTCASE K ───
const FLCK_COL = '#0e7490';
const getFlck = id => (D.flck || []).find(k => k.id === id);
const _svgCont = (c, s) => `<svg width="${s}" height="${s}" viewBox="0 0 48 48" fill="none" style="vertical-align:middle;margin-right:2px"><rect x="6" y="12" width="36" height="26" rx="2" stroke="${c}" stroke-width="3.5" fill="none"/><path d="M6 12l3-3h30l3 3" stroke="${c}" stroke-width="3" fill="none"/><line x1="6" y1="25" x2="42" y2="25" stroke="${c}" stroke-width="2" opacity=".5"/><circle cx="16" cy="25" r="2" fill="${c}" opacity=".5"/><circle cx="32" cy="25" r="2" fill="${c}" opacity=".5"/></svg>`;
const flckTot = k => (k.voci || []).reduce((n, v) => n + v.qty_caricata, 0);
const flckMax = k => (k.voci || []).reduce((n, v) => n + v.qty_max, 0);
function flckPillSm(k) {
  return ` <span style="font-size:9px;background:${FLCK_COL}15;color:${FLCK_COL};border:1px solid ${FLCK_COL}33;padding:1px 5px;border-radius:3px;font-family:'DM Mono',monospace;vertical-align:middle">FLCK${k ? ` · ${k.voci.length} voci · ${flckTot(k)}/${flckMax(k)}` : ''}</span>`;
}
function flckPillMag(k) {
  return `<span class="mag-bau-pill" style="background:${FLCK_COL}22;color:${FLCK_COL};border-color:${FLCK_COL}44">${_svgCont(FLCK_COL, 10)} flightcase K${k ? ` · ${k.voci.length} voci` : ''}</span>`;
}
function flckContenutoHtml(k) {          // elenco compatto del contenuto
  if (!k || !k.voci.length) return `<span style="font-size:12px;color:var(--ink3);font-style:italic">Nessun contenuto definito</span>`;
  return `<table class="pezzi-tab"><tbody>` + k.voci.map(v => {
    const a = getArt(v.art_id) || v;
    return `<tr><td style="width:70px">${codiceBadge(v.art_codice, v.art_cat_colore)}</td>
      <td><strong>${h(v.art_nome)}</strong>${a.modello_id && a.variante ? varChip(a) : ''}${noteBtn(v.art_id)}</td>
      <td style="text-align:right;white-space:nowrap;font-family:'DM Mono',monospace">${v.qty_caricata}/${v.qty_max}</td></tr>`;
  }).join('') + `</tbody></table>`;
}
function flckContenutoBox(k) {
  return `<div style="font-size:10px;color:${FLCK_COL};margin-bottom:4px;font-family:'DM Mono',monospace;letter-spacing:.5px">CONTENUTO</div>` + flckContenutoHtml(k);
}

let _flckCorrente = null;     // id del flightcase K aperto
function renderFlck() {
  const grid = document.getElementById('flckGrid');
  _bauliTabCounts();
  if (!_flckCorrente) { document.getElementById('flckDettaglio').style.display = 'none'; grid.style.display = ''; }
  _btRender(grid, (D.flck || []).map(k => ({
    nome: k.nome, cod: k.codice, sub: '', col: _btCol('FLCK', FLCK_COL),
    chip: k.voci.length ? `${k.voci.length} VOCI · ${flckTot(k)}/${flckMax(k)}` : 'VUOTO', ok: k.voci.length > 0,
    id: k.id, dupOk: !k.voci.some(v => v.qty_caricata > 0), onOpen: `apriFlck(${k.id})`, delOk: !!window.localFetch || totalArtReale(k.id) === 0, onDel: `eliminaFlck(${k.id})`
  })), 'Nessun flightcase K — clicca "+ Flightcase K" per crearne uno');
}
function apriFlck(id) {
  if (!getFlck(id)) return;
  _flckCorrente = id;
  document.getElementById('flckGrid').style.display = 'none';
  document.getElementById('flckDettaglio').style.display = '';
  renderFlckDettaglio();
}
function chiudiFlckDettaglio() {
  _flckCorrente = null;
  document.getElementById('flckDettaglio').style.display = 'none';
  document.getElementById('flckGrid').style.display = '';
  _aggiornaBauliD().then(() => renderFlck());
}
function renderFlckDettaglio() {
  const k = getFlck(_flckCorrente);
  if (!k) { chiudiFlckDettaglio(); return; }
  document.getElementById('flckDetNome').textContent = k.nome;
  document.getElementById('flckDetCodice').innerHTML = `<span style="font-family:'DM Mono',monospace;font-size:12px;color:var(--ink3);margin-left:8px">${h(k.codice)}</span>`;
  document.getElementById('flckDetBadge').innerHTML = k.voci.length
    ? `<span class="baule-badge compilato">${flckTot(k)} / ${flckMax(k)}</span>` : `<span class="baule-badge vuoto">vuoto</span>`;
  const magReale = D.stock.find(s => s.art_id === k.id && s.qty > 0 && !getMag(s.mag_id)?.virtuale);
  const magId = magReale?.mag_id;
  document.getElementById('flckStockInfo').innerHTML = magReale
    ? `📍 Il case è in <strong>${h(getMag(magId)?.nome || '—')}</strong> — si carica solo con articoli presenti nello stesso magazzino`
    : `⚠️ Il flightcase K non è in nessun magazzino reale: non si può caricare né scaricare`;
  const isAdmin = currentUser?.ruolo === 'admin';
  document.getElementById('flckVociList').innerHTML = k.voci.length ? k.voci.map(v => {
    const a = getArt(v.art_id) || v, pezzo = !!a.modello_id;
    const disp = magId ? getStock(v.art_id, magId) : 0;
    const nome = `<strong>${h(v.art_nome)}</strong>${pezzo ? ' ' + varSelect(a) : ''}${noteBtn(v.art_id)}`;
    const azioni = pezzo
      ? (v.qty_caricata > 0
          ? `<span class="var-chip">dentro</span> <button class="btn btn-ghost btn-xs" onclick="scaricaVoceFlck(${v.id},1)">↑ Scarica</button>`
          : `<span style="font-size:11px;color:var(--ink3)">${disp ? 'qui in magazzino' : 'fuori'}</span> <button class="btn btn-dark btn-xs" ${disp ? '' : 'disabled style="opacity:.4"'} onclick="caricaVoceFlck(${v.id},1)">↓ Carica</button>`)
      : _contQty('flckQ-' + v.id)
        + `<button class="btn btn-dark btn-xs" onclick="caricaVoceFlck(${v.id})">↓ Carica</button><button class="btn btn-ghost btn-xs" onclick="scaricaVoceFlck(${v.id})">↑ Scarica</button>`;
    const admin = `<span style="white-space:nowrap"><button class="btn btn-ghost btn-xs" onclick="eliminaVoceFlck(${v.id})" title="Togli dalla definizione">✕</button>`
      + (!pezzo ? ` <button class="btn btn-ghost btn-xs" onclick="modificaCapienzaFlck(${v.id})" title="Cambia capienza">✎</button>` : '') + '</span>';
    return _contRiga({ cod: v.art_codice, colore: v.art_cat_colore, nome, qty: v.qty_caricata, max: pezzo ? null : v.qty_max, disp: pezzo ? null : disp, azioni: azioni + ' ' + admin });
  }).join('') : `<div class="empty" style="padding:18px">Nessun contenuto: aggiungi articoli o pezzi con "+ Contenuto"</div>`;
}
async function _flckRefresh() {
  await _aggiornaBauliD();
  if (_flckCorrente) renderFlckDettaglio();
}
async function caricaVoceFlck(vid, pezzo) {
  const qty = pezzo ? 1 : parseInt(document.getElementById('flckQ-' + vid)?.value);
  if (isNaN(qty) || qty <= 0) { toast('Quantità non valida', true); return; }
  try { await apiFetch('POST', `/flck/voci/${vid}/carica`, { qty }); await _flckRefresh(); toast('Caricato nel case ✓'); } catch (e) {}
}
async function scaricaVoceFlck(vid, pezzo) {
  const qty = pezzo ? 1 : parseInt(document.getElementById('flckQ-' + vid)?.value);
  if (isNaN(qty) || qty <= 0) { toast('Quantità non valida', true); return; }
  try { await apiFetch('POST', `/flck/voci/${vid}/scarica`, { qty }); await _flckRefresh(); toast('Scaricato dal case ✓'); } catch (e) {}
}
async function eliminaVoceFlck(vid) {
  if (!await askConfirm('Togliere questo articolo dal contenuto del flightcase K?', { ok: 'Togli', danger: true })) return;
  try { await apiFetch('DELETE', `/flck/voci/${vid}`); await _flckRefresh(); toast('Rimosso ✓'); } catch (e) {}
}
async function modificaCapienzaFlck(vid) {
  const v = (getFlck(_flckCorrente)?.voci || []).find(x => x.id === vid); if (!v) return;
  const r = parseInt(await askPrompt(`Capienza massima di "${v.art_nome}" (attualmente caricati: ${v.qty_caricata})`, v.qty_max, { type: 'number' }));
  if (!r || r < 1) return;
  try { await apiFetch('PUT', `/flck/voci/${vid}`, { qty_max: r }); await _flckRefresh(); toast('Capienza aggiornata ✓'); } catch (e) {}
}
async function eliminaFlck(id) {
  const k = getFlck(id); if (!k) { toast('Elemento non trovato', true); return; }
  if (!window.localFetch && totalArtReale(id) > 0) { toast('Sposta prima nel cestino per poterlo eliminare', true); return; }
  if (!await askConfirm(`Eliminare definitivamente "${k.nome}" (flightcase K)?\nIl contenuto ancora dentro torna nello stock.\nOperazione irreversibile.`, { ok: 'Elimina', danger: true })) return;
  try {
    await apiFetch('DELETE', `/flck/${id}`);
    _flckCorrente = null;
    await Promise.all([loadPartial('spostamenti'), _aggiornaBauliD()]);
    renderFlck();
    toast(`"${k.nome}" eliminato ✓`);
  } catch (e) {}
}
function _flckForm(edit) {
  document.getElementById('flckTitle').textContent = edit ? 'Modifica Flightcase K' : 'Nuovo Flightcase K';
  document.getElementById('flckMagGrp').style.display = edit ? 'none' : '';
  document.getElementById('flckInfoNew').style.display = edit ? 'none' : '';
  document.getElementById('flckSalvaBtn').textContent = edit ? 'Salva' : 'Crea';
}
function openModalFlckNew() {
  _btEdit = null; _flckForm(false);
  document.getElementById('flckNome').value = '';
  document.getElementById('flckNote').value = '';
  document.getElementById('flckMagId').innerHTML = '<option value="">— Seleziona magazzino —</option>' +
    getMagReali().map(m => `<option value="${m.id}">${m.icona || '🏭'} ${h(m.nome)}</option>`).join('');
  openModal('modalFlckNew');
}
function openModalFlckEdit(id) {
  const a = getArt(id); if (!a) return;
  _btEdit = id; _flckForm(true);
  document.getElementById('flckNome').value = a.nome;
  document.getElementById('flckNote').value = a.note || '';
  openModal('modalFlckNew');
}
async function salvaFlckNew() {
  const nome = document.getElementById('flckNome').value.trim();
  const mag_id = document.getElementById('flckMagId').value;
  const note = document.getElementById('flckNote').value.trim();
  if (!nome) { toast('Nome obbligatorio', true); return; }
  if (!_btEdit && !mag_id) { toast('Seleziona un magazzino', true); return; }
  try {
    if (_btEdit) {
      await apiFetch('PUT', `/bauli/${_btEdit}`, { nome, note });
      closeModal('modalFlckNew');
      await _btDopoModifica('Flightcase K modificato ✓');
      return;
    }
    const r = await apiFetch('POST', '/flck', { nome, note, mag_id: +mag_id });
    closeModal('modalFlckNew');
    await Promise.all([loadPartial('spostamenti'), _aggiornaBauliD()]);
    switchBauliTab('flck');
    apriFlck(r.id);
    toast('Flightcase K creato ✓');
  } catch (e) {}
}
// ── aggiunta contenuto ──
function openModalFlckVoce() {
  const k = getFlck(_flckCorrente); if (!k) return;
  document.getElementById('flckVoceTipo').value = 'q';
  document.getElementById('flckVoceQtyMax').value = '1';
  const giaQ = new Set(k.voci.map(v => v.art_id));
  document.getElementById('flckVoceArt').innerHTML = '<option value="">— Seleziona articolo —</option>' +
    getArtNormali().filter(a => !a.modello_id && !giaQ.has(a.id))
      .map(a => `<option value="${a.id}" data-cat="${a.cat_id}">[${h(a.codice)}] ${h(a.nome)}</option>`).join('');
  _riempiCatSel('flckVoceArtCat', 'flckVoceArt');
  document.getElementById('flckVoceMod').innerHTML = '<option value="">— Seleziona modello —</option>' +
    (D.modelli || []).map(m => `<option value="${m.id}" data-cat="${m.cat_id}">${h(m.nome)}</option>`).join('');
  _riempiCatSel('flckVoceModCat', 'flckVoceMod');
  document.getElementById('flckVocePezzi').innerHTML = '';
  onFlckVoceTipo();
  openModal('modalFlckVoce');
}
function onFlckVoceTipo() {
  const q = document.getElementById('flckVoceTipo').value === 'q';
  document.getElementById('flckVoceQ').style.display = q ? '' : 'none';
  document.getElementById('flckVoceP').style.display = q ? 'none' : '';
}
function onFlckVoceMod() {
  const mid = +document.getElementById('flckVoceMod').value;
  const inK = new Set((D.flck || []).flatMap(k => k.voci.map(v => v.art_id)));
  const pezzi = D.articoli.filter(a => a.modello_id === mid && !inK.has(a.id));
  document.getElementById('flckVocePezzi').innerHTML = mid
    ? (pezzi.length ? pezzi.map(a => `<label class="flck-pz"><input type="checkbox" class="pz-chk" value="${a.id}"> <strong>${h(a.nome)}</strong> ${varChip(a)} <span style="font-size:11px;color:var(--ink3)">${dovePezzo(a)}</span></label>`).join('')
                    : '<div style="font-size:12px;color:var(--ink3)">Tutti i pezzi di questo modello sono già in un flightcase K</div>')
    : '';
}
async function salvaFlckVoce() {
  const k = getFlck(_flckCorrente); if (!k) return;
  const q = document.getElementById('flckVoceTipo').value === 'q';
  try {
    if (q) {
      const art_id = +document.getElementById('flckVoceArt').value, qty_max = parseInt(document.getElementById('flckVoceQtyMax').value);
      if (!art_id) { toast('Seleziona un articolo', true); return; }
      if (!(qty_max >= 1)) { toast('Capienza non valida', true); return; }
      await apiFetch('POST', `/flck/${k.id}/voci`, { art_id, qty_max });
    } else {
      const art_ids = [...document.querySelectorAll('#flckVocePezzi input:checked')].map(i => +i.value);
      if (!art_ids.length) { toast('Spunta almeno un pezzo', true); return; }
      await apiFetch('POST', `/flck/${k.id}/voci`, { art_ids });
    }
    closeModal('modalFlckVoce');
    await _flckRefresh();
    toast('Contenuto aggiunto ✓');
  } catch (e) {}
}

function toggleAside(force) {
  const min = (typeof force === 'boolean') ? force : !document.body.classList.contains('aside-min');
  document.body.classList.toggle('aside-min', min);
  const b = document.getElementById('asideToggle');
  if (b) { b.querySelector('.ni').textContent = min ? '»' : '«'; b.title = min ? 'Espandi menu' : 'Riduci menu'; }
  try { localStorage.setItem('wf-aside-min', min ? '1' : '0'); } catch (e) {}
}
(function initAside() {
  // tooltip con il nome della voce quando il menu è ridotto
  document.querySelectorAll('.nav-btn').forEach(b => {
    const l = [...b.querySelectorAll('span')].find(s => !s.classList.contains('ni') && !s.classList.contains('nav-badge'));
    if (l && !b.title) b.title = l.textContent.trim();
  });
  try { if (localStorage.getItem('wf-aside-min') === '1') toggleAside(true); } catch (e) {}
})();

// ─── TASTO INDIETRO: torna alla schermata precedente (sezione, dettaglio o finestra) ───
let _histIgnore = false;
function _histClose() {            // chiude, se c'è, il livello più in alto: finestra → dettaglio
  const ov = [...document.querySelectorAll('.overlay.open')].pop();
  if (ov) { closeModal(ov.id); return true; }
  if (curPage === 'liste' && _listaCorrente) { chiudiDettaglioLista(); return true; }
  if (curPage === 'bauli') {
    if (typeof _flckCorrente !== 'undefined' && _flckCorrente) { chiudiFlckDettaglio(); return true; }
    if (typeof _bauleCorrente !== 'undefined' && _bauleCorrente) { chiudiBauleDettaglio(); return true; }
  }
  return false;
}
window.addEventListener('popstate', e => {
  if (_histIgnore) { _histIgnore = false; return; }
  const st = e.state || {};
  if (_histClose()) { _histIgnore = true; history.forward(); return; }   // resta nella stessa sezione
  if (st.base) { _histIgnore = false; history.forward(); return; }      // mai tornare al login
  if (st.p && st.p !== curPage && document.getElementById('page-' + st.p)) goTo(st.p, true);
});
function initHistory() {
  const h0 = (location.hash || '').slice(1);
  const start = (h0 && document.getElementById('page-' + h0) && document.querySelector(`.nav-btn[onclick*="'${h0}'"]`)) ? h0 : 'dashboard';
  try {
    history.replaceState({ base: true }, '', location.pathname + location.search);
    history.pushState({ p: start }, '', '#' + start);
  } catch (e) {}
  if (start !== 'dashboard') goTo(start, true);
}

// ─── INIT ───
(async()=>{
  initDark();
  initTheme();
  initOnline();
  // trasferisci da html a body se necessario
  if (document.documentElement.classList.contains("dark-pre")) { document.body.classList.add("dark"); document.documentElement.classList.remove("dark-pre"); }
  _applyDarkClass();
  const ok = await initAuth();
  if (!ok) return;
  await load();
  renderDash();
  initHistory();
  playLoginSound();
})();

// tooltip sulle voci di menu: servono quando in topbar restano solo le icone
(function navTitoli() {
  const f = () => document.querySelectorAll('.nav-btn').forEach(b => {
    if (b.title) return;
    const l = b.querySelector('span:not(.ni):not(.nav-badge)');
    if (l) b.title = l.textContent.trim();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', f); else f();
})();

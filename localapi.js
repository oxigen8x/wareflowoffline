/* WareFlow Offline — livello dati locale (generato da build.py, non modificare a mano) */
(function () {
'use strict';
const DB_KEY = 'db';
const USER = { id: 1, username: 'iPad', ruolo: 'admin' };
let SQL, raw, db, timer = null, resetting = false;

// ── IndexedDB (persistenza del file .db) ──
const idb = () => new Promise((ok, ko) => {
  const r = indexedDB.open('wareflow-offline', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
});
const idbGet = async k => { const d = await idb(); return new Promise((ok, ko) => {
  const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => ok(q.result); q.onerror = () => ko(q.error); }); };
const idbDel = async k => { const d = await idb(); return new Promise((ok, ko) => {
  const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = ok; t.onerror = () => ko(t.error); }); };
const idbSet = async (k, v) => { const d = await idb(); return new Promise((ok, ko) => {
  const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = ok; t.onerror = () => ko(t.error); }); };

// export() di sql.js chiude e riapre il DB: i PRAGMA vanno reimpostati
function snapshot() { const b = raw.export(); raw.exec('PRAGMA foreign_keys = ON'); return b; }
const save = () => resetting ? Promise.resolve() : idbSet(DB_KEY, snapshot());
const scheduleSave = () => { clearTimeout(timer); timer = setTimeout(save, 300); };
addEventListener('pagehide', () => { if (timer) { clearTimeout(timer); timer = null; save(); } });
document.addEventListener('visibilitychange', () => { if (document.hidden && timer) { clearTimeout(timer); timer = null; save(); } });

// ── Shim con la stessa interfaccia di better-sqlite3 ──
function makeDb() {
  const norm = a => a.flat().map(v => v === undefined ? null : typeof v === 'boolean' ? +v : v);
  let depth = 0;
  return {
    exec: sql => { raw.exec(sql); },
    prepare: sql => ({
      run(...a) { raw.run(sql, norm(a)); return { changes: raw.getRowsModified(), lastInsertRowid: raw.exec('SELECT last_insert_rowid()')[0].values[0][0] }; },
      get(...a) { const s = raw.prepare(sql); try { s.bind(norm(a)); return s.step() ? s.getAsObject() : undefined; } finally { s.free(); } },
      all(...a) { const s = raw.prepare(sql), out = []; try { s.bind(norm(a)); while (s.step()) out.push(s.getAsObject()); } finally { s.free(); } return out; }
    }),
    transaction: fn => (...args) => {
      if (depth) return fn(...args);
      depth++; raw.exec('BEGIN');
      try { const r = fn(...args); raw.exec('COMMIT'); return r; }
      catch (e) { try { raw.exec('ROLLBACK'); } catch (_) {} throw e; }
      finally { depth--; }
    }
  };
}

// ── Mini router in stile Express ──
const routes = [];
const app = {};
['get', 'post', 'put', 'delete'].forEach(m => app[m] = (path, fn) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ m: m.toUpperCase(), re, keys, fn });
});
const touch = () => {};
const randomUUID = () => (crypto.randomUUID ? crypto.randomUUID() : 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2));

async function localFetch(method, url, body) {
  await window.localReady;
  const u = new URL(url, 'http://x');
  const path = u.pathname.replace(/^.*?(\/api\/)/, '/api/');
  const query = {}; u.searchParams.forEach((v, k) => query[k] = v);
  const r = routes.find(x => x.m === method && x.re.test(path));
  if (!r) throw new Error('Funzione non disponibile nella versione offline');
  const mm = path.match(r.re), params = {};
  r.keys.forEach((k, i) => params[k] = decodeURIComponent(mm[i + 1]));
  const req = { body: body ? JSON.parse(JSON.stringify(body)) : {}, params, query, method, path, session: { user: USER } };
  let status = 200, out;
  const res = { status(s) { status = s; return res; }, json(o) { out = o; return res; } };
  try { r.fn(req, res); } catch (e) { console.error(e); status = 500; out = { error: 'Errore durante l\'operazione' }; }
  if (method !== 'GET' && status < 400) scheduleSave();
  if (status >= 400) throw new Error((out && out.error) || ('Errore ' + status));
  return out;
}
window.localFetch = localFetch;
window.LOCALAPI_BUILD = 14;   // deve coincidere con APP_BUILD in index.html

function isValidColore(c) {
  return !c || /^#[0-9a-fA-F]{3,6}$/.test(c);
}

function safeErr(e, context) {
  console.error(`[${context}]`, e.message);
  if (e.message.includes('UNIQUE'))  return 'Elemento già esistente con questo nome o codice';
  if (e.message.includes('FOREIGN')) return 'Impossibile: elemento referenziato da altri dati';
  if (e.message.includes('Stock insufficiente')) return e.message; // already safe
  return 'Errore durante l\'operazione';
}

function prossimoNumero(prefisso) {
  const mx = t => db.prepare(`SELECT MAX(CAST(SUBSTR(codice, ?) AS INTEGER)) as max FROM ${t} WHERE codice LIKE ?`)
    .get(prefisso.length + 1, prefisso + '%')?.max || 0;
  return Math.max(mx('articoli'), mx('modelli')) + 1;   // anche i codici degli articoli con varianti contano
}

function stockDecrement(artId, magId, amount) {
  return db.prepare('UPDATE stock SET qty=qty-? WHERE art_id=? AND mag_id=? AND qty>=?').run(amount, artId, magId, amount).changes > 0;
}

// Funzioni non incluse offline: l'app all'avvio chiede comunque l'elenco liste
app.get('/api/liste', (_, res) => res.json([]));

app.get('/api/magazzini', (_, res) =>
  res.json(db.prepare('SELECT * FROM magazzini ORDER BY virtuale ASC, nome ASC').all()));

app.post('/api/magazzini', (req, res) => {
  const { nome, citta='', note='', colore='#2563eb', icona='🏭', classe='stabile' } = req.body;
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome obbligatorio' });
  if (!isValidColore(colore)) return res.status(400).json({ error: 'Colore non valido' });
  try {
    touch(); const r = db.prepare('INSERT INTO magazzini (nome,citta,note,colore,virtuale,icona,classe) VALUES (?,?,?,?,0,?,?)').run(nome.trim(),citta,note,colore,icona,classe);
    res.json({ id: r.lastInsertRowid, nome: nome.trim(), citta, note, colore, virtuale: 0, icona, classe });
  } catch { res.status(400).json({ error: 'Esiste già un magazzino con questo nome' }); }
});
app.put('/api/magazzini/:id', (req, res) => {
  touch();
  const { nome, citta='', note='', colore='#2563eb', icona='🏭', classe='stabile' } = req.body;
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome obbligatorio' });
  if (!isValidColore(colore)) return res.status(400).json({ error: 'Colore non valido' });
  if (db.prepare('SELECT virtuale FROM magazzini WHERE id=?').get(req.params.id)?.virtuale)
    return res.status(400).json({ error: 'Il magazzino virtuale non può essere modificato' });
  try { touch(); db.prepare('UPDATE magazzini SET nome=?,citta=?,note=?,colore=?,icona=?,classe=? WHERE id=?').run(nome.trim(),citta,note,colore,icona,classe,req.params.id); res.json({ ok:true }); }
  catch { res.status(400).json({ error: 'Esiste già un magazzino con questo nome' }); }
});
app.delete('/api/magazzini/:id', (req, res) => {
  touch();
  if (db.prepare('SELECT virtuale FROM magazzini WHERE id=?').get(req.params.id)?.virtuale)
    return res.status(400).json({ error: 'Il magazzino virtuale non può essere eliminato' });
  if (db.prepare('SELECT COUNT(*) as n FROM stock WHERE mag_id=? AND qty>0').get(req.params.id).n > 0)
    return res.status(400).json({ error: 'Il magazzino contiene ancora merce' });
  db.transaction(() => {
    db.prepare('UPDATE spostamenti SET mag_from=NULL WHERE mag_from=?').run(req.params.id);
    db.prepare('UPDATE spostamenti SET mag_to=NULL WHERE mag_to=?').run(req.params.id);
    db.prepare('DELETE FROM stock WHERE mag_id=?').run(req.params.id);
    db.prepare('DELETE FROM magazzini WHERE id=?').run(req.params.id);
  })(); res.json({ ok:true });
});

// ===================== CATEGORIE =====================
// ─── CATEGORIE ───
app.get('/api/categorie', (_, res) =>
  res.json(db.prepare('SELECT * FROM categorie ORDER BY nome').all()));
app.post('/api/categorie', (req, res) => {
  touch();
  const { nome, colore='#3b82f6', prefisso='' } = req.body;
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome obbligatorio' });
  if (!isValidColore(colore)) return res.status(400).json({ error: 'Colore non valido' });
  if (!prefisso?.trim()) return res.status(400).json({ error: 'Prefisso obbligatorio' });
  const pfx = prefisso.trim().toUpperCase();
  if (db.prepare('SELECT id FROM categorie WHERE prefisso=?').get(pfx)) return res.status(400).json({ error: `Prefisso "${pfx}" già usato` });
  try { const r = db.prepare('INSERT INTO categorie (nome,colore,prefisso) VALUES (?,?,?)').run(nome.trim(),colore,pfx); res.json({ id:r.lastInsertRowid, nome:nome.trim(), colore, prefisso:pfx }); }
  catch { res.status(400).json({ error: 'Esiste già una categoria con questo nome' }); }
});
app.put('/api/categorie/:id', (req, res) => {
  touch();
  const { nome, colore='#3b82f6', prefisso='' } = req.body;
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome obbligatorio' });
  if (!isValidColore(colore)) return res.status(400).json({ error: 'Colore non valido' });
  if (!prefisso?.trim()) return res.status(400).json({ error: 'Prefisso obbligatorio' });
  const pfx = prefisso.trim().toUpperCase();
  if (db.prepare('SELECT id FROM categorie WHERE prefisso=? AND id!=?').get(pfx,req.params.id)) return res.status(400).json({ error: `Prefisso "${pfx}" già usato` });
  try { db.prepare('UPDATE categorie SET nome=?,colore=?,prefisso=? WHERE id=?').run(nome.trim(),colore,pfx,req.params.id); res.json({ ok:true }); }
  catch { res.status(400).json({ error: 'Esiste già una categoria con questo nome' }); }
});
app.delete('/api/categorie/:id', (req, res) => {
  touch();
  const catPfx = db.prepare("SELECT prefisso FROM categorie WHERE id=?").get(req.params.id);
  if (catPfx?.prefisso === 'BAU')
    return res.status(400).json({ error: 'La categoria "Bauli speciali" non può essere eliminata' });
  if (catPfx?.prefisso === 'FLC')
    return res.status(400).json({ error: 'La categoria "Flight Case" non può essere eliminata' });
  if (catPfx?.prefisso === 'FLCK')
    return res.status(400).json({ error: 'La categoria "Flightcase K" non può essere eliminata' });
  if (db.prepare('SELECT COUNT(*) as n FROM articoli WHERE cat_id=?').get(req.params.id).n > 0)
    return res.status(400).json({ error: 'Categoria usata da articoli esistenti' });
  db.prepare('DELETE FROM categorie WHERE id=?').run(req.params.id); res.json({ ok:true });
});

// ===================== ARTICOLI =====================
// ─── ARTICOLI ───
app.get('/api/articoli/prossimo-codice/:cat_id', (req, res) => {
  const cat = db.prepare('SELECT prefisso FROM categorie WHERE id=?').get(req.params.cat_id);
  if (!cat) return res.status(404).json({ error: 'Categoria non trovata' });
  res.json({ codice: cat.prefisso + prossimoNumero(cat.prefisso), prefisso: cat.prefisso });
});
app.get('/api/articoli', (_, res) =>
  res.json(db.prepare(`SELECT a.*, c.nome as cat_nome, c.colore as cat_colore, c.prefisso as cat_prefisso
    FROM articoli a JOIN categorie c ON c.id=a.cat_id ORDER BY a.codice`).all()));
app.post('/api/articoli', (req, res) => {
  touch();
  const { nome, cat_id, um='pz', note='', codice } = req.body;
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome obbligatorio' });
  if (!cat_id) return res.status(400).json({ error: 'Categoria obbligatoria' });
  const catPfx = db.prepare("SELECT prefisso FROM categorie WHERE id=?").get(cat_id);
  if (['BAU','FLC','FLCK'].includes(catPfx?.prefisso))
    return res.status(400).json({ error: 'Usa la sezione Bauli per creare bauli e flight case' });
  if (!codice?.trim()) return res.status(400).json({ error: 'Codice obbligatorio' });
  if (db.prepare('SELECT id FROM articoli WHERE codice=?').get(codice.trim().toUpperCase())) return res.status(400).json({ error: `Codice "${codice}" già esistente` });
  try { const r = db.prepare('INSERT INTO articoli (codice,nome,cat_id,um,note) VALUES (?,?,?,?,?)').run(codice.trim().toUpperCase(),nome.trim(),cat_id,um,note); res.json({ id:r.lastInsertRowid, codice:codice.trim().toUpperCase(), nome:nome.trim(), cat_id, um, note }); }
  catch { res.status(400).json({ error: 'Esiste già un articolo con questo nome' }); }
});
app.put('/api/articoli/:id', (req, res) => {
  touch();
  const { nome, cat_id, um='pz', note='', codice } = req.body;
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome obbligatorio' });
  if (!cat_id) return res.status(400).json({ error: 'Categoria obbligatoria' });
  const catPfx = db.prepare("SELECT prefisso FROM categorie WHERE id=?").get(cat_id);
  if (['BAU','FLC','FLCK'].includes(catPfx?.prefisso))
    return res.status(400).json({ error: 'Non puoi spostare un articolo nelle categorie Bauli o Flight Case' });
  if (!codice?.trim()) return res.status(400).json({ error: 'Codice obbligatorio' });
  if (db.prepare('SELECT id FROM articoli WHERE codice=? AND id!=?').get(codice.trim().toUpperCase(),req.params.id)) return res.status(400).json({ error: `Codice "${codice}" già esistente` });
  try { db.prepare('UPDATE articoli SET codice=?,nome=?,cat_id=?,um=?,note=? WHERE id=?').run(codice.trim().toUpperCase(),nome.trim(),cat_id,um,note,req.params.id); res.json({ ok:true }); }
  catch { res.status(400).json({ error: 'Esiste già un articolo con questo nome' }); }
});
app.delete('/api/articoli/:id', (req, res) => {
  touch();
  if (db.prepare("SELECT 1 FROM articoli a JOIN categorie c ON c.id=a.cat_id WHERE a.id=? AND c.prefisso='FLCK'").get(req.params.id))
    return res.status(400).json({ error: 'Elimina il Flightcase K dalla sezione Bauli e Flight Case' });
  const inK = db.prepare('SELECT k.nome FROM flck_voci v JOIN articoli k ON k.id=v.flck_art_id WHERE v.art_id=? AND v.qty_caricata>0').get(req.params.id);
  if (inK) return res.status(400).json({ error: `È dentro il Flightcase K "${inK.nome}": scaricalo prima` });
  const inFlc = db.prepare('SELECT a.nome FROM flightcase_def f JOIN articoli a ON a.id=f.art_id WHERE f.art_id_contenuto=?').get(req.params.id);
  if (inFlc) return res.status(400).json({ error: 'È il contenuto del flight case "' + inFlc.nome + '": elimina prima il flight case' });
  try {
    db.transaction(() => {
      const righeIds = db.prepare('SELECT id FROM lista_righe WHERE art_id=?').all(req.params.id).map(r => r.id);
      for (const rigaId of righeIds) db.prepare('DELETE FROM lista_flag WHERE riga_id=?').run(rigaId);
      db.prepare('DELETE FROM lista_righe WHERE art_id=?').run(req.params.id);
      db.prepare('DELETE FROM baule_voci WHERE art_id=?').run(req.params.id);
      db.prepare('DELETE FROM flck_voci WHERE art_id=?').run(req.params.id);
      db.prepare('DELETE FROM flightcase_def WHERE art_id=? OR art_id_contenuto=?').run(req.params.id, req.params.id);
      db.prepare('DELETE FROM spostamenti WHERE art_id=?').run(req.params.id);
      db.prepare('DELETE FROM stock WHERE art_id=?').run(req.params.id);
      db.prepare('DELETE FROM articoli WHERE id=?').run(req.params.id);
    })(); res.json({ ok:true });
  } catch(e) {
    console.error('Errore eliminazione articolo:', e.message);
    res.status(500).json({ error: safeErr(e, 'DELETE articoli') });
  }
});

// ─── FLIGHTCASE K (contenitore con articoli diversi) ───
const flckCat = () => db.prepare("SELECT id FROM categorie WHERE prefisso='FLCK'").get();
function flckMag(flckId) {   // magazzino reale in cui si trova il flightcase K (o null)
  return db.prepare(`SELECT s.mag_id FROM stock s JOIN magazzini m ON m.id=s.mag_id WHERE s.art_id=? AND s.qty>0 AND m.virtuale=0`).get(flckId)?.mag_id ?? null;
}
const safeThrow = m => Object.assign(new Error(m), { safe: true });
const isCatSpeciale = artId => ['BAU', 'FLC', 'FLCK'].includes(db.prepare('SELECT c.prefisso FROM articoli a JOIN categorie c ON c.id=a.cat_id WHERE a.id=?').get(artId)?.prefisso);
app.get('/api/flck', (req, res) => {
  const cat = flckCat();
  if (!cat) return res.json([]);
  const casi = db.prepare('SELECT id, codice, nome, note FROM articoli WHERE cat_id=? ORDER BY nome').all(cat.id);
  const voci = db.prepare(`SELECT v.id, v.flck_art_id, v.art_id, v.qty_max, v.qty_caricata,
      a.nome as art_nome, a.codice as art_codice, a.um, a.note as art_note, a.modello_id, a.variante,
      c.colore as art_cat_colore
    FROM flck_voci v JOIN articoli a ON a.id=v.art_id JOIN categorie c ON c.id=a.cat_id
    ORDER BY a.nome`).all();
  res.json(casi.map(k => ({ ...k, voci: voci.filter(v => v.flck_art_id === k.id) })));
});
app.post('/api/flck', (req, res) => {
  touch();
  const cat = flckCat();
  if (!cat) return res.status(400).json({ error: 'Categoria Flightcase K non trovata. Riavvia il server.' });
  const { nome, note = '', mag_id } = req.body;
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome obbligatorio' });
  if (!mag_id) return res.status(400).json({ error: 'Magazzino obbligatorio' });
  const codice = 'FLCK' + prossimoNumero('FLCK');
  try {
    const uid = req.session.user.id, data = new Date().toISOString();
    let id;
    db.transaction(() => {
      const r = db.prepare('INSERT INTO articoli (codice,nome,cat_id,um,note) VALUES (?,?,?,?,?)').run(codice, nome.trim(), cat.id, 'pz', note);
      id = Number(r.lastInsertRowid);
      db.prepare('INSERT INTO stock (art_id,mag_id,qty) VALUES (?,?,1)').run(id, mag_id);
      db.prepare('INSERT INTO spostamenti (art_id,mag_from,mag_to,qty,tipo,note,data,user_id) VALUES (?,NULL,?,?,?,?,?,?)')
        .run(id, mag_id, 1, 'carico', `Creazione flightcase K: ${nome.trim()}`, data, uid);
    })();
    res.json({ ok: true, id, codice });
  } catch (e) { res.status(400).json({ error: safeErr(e, 'POST flck') }); }
});
app.post('/api/flck/:id/voci', (req, res) => {
  touch();
  const k = db.prepare('SELECT a.id FROM articoli a JOIN categorie c ON c.id=a.cat_id WHERE a.id=? AND c.prefisso=?').get(req.params.id, 'FLCK');
  if (!k) return res.status(404).json({ error: 'Flightcase K non trovato' });
  const ids = Array.isArray(req.body.art_ids) ? req.body.art_ids.map(Number) : [Number(req.body.art_id)];
  if (!ids.length || ids.some(x => !x)) return res.status(400).json({ error: 'Articolo obbligatorio' });
  const qm = parseInt(req.body.qty_max);
  try {
    db.transaction(() => {
      for (const id of ids) {
        const a = db.prepare('SELECT id, nome, modello_id FROM articoli WHERE id=?').get(id);
        if (!a) throw safeThrow('Articolo non trovato');
        if (isCatSpeciale(id)) throw safeThrow('Non si possono inserire bauli o flight case in un Flightcase K');
        const unico = !!a.modello_id;
        if (!unico && (isNaN(qm) || qm < 1)) throw safeThrow('Quantità massima non valida');
        const gia = db.prepare('SELECT k.nome FROM flck_voci v JOIN articoli k ON k.id=v.flck_art_id WHERE v.art_id=? AND (?=1 OR v.flck_art_id=?)').get(id, unico ? 1 : 0, k.id);
        if (gia) throw safeThrow(`"${a.nome}" è già previsto nel Flightcase K "${gia.nome}"`);
        db.prepare('INSERT INTO flck_voci (flck_art_id,art_id,qty_max,qty_caricata) VALUES (?,?,?,0)').run(k.id, id, unico ? 1 : qm);
      }
    })();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.safe ? e.message : safeErr(e, 'POST flck voci') }); }
});
app.put('/api/flck/voci/:id', (req, res) => {
  touch();
  const v = db.prepare('SELECT v.*, a.modello_id FROM flck_voci v JOIN articoli a ON a.id=v.art_id WHERE v.id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Voce non trovata' });
  if (v.modello_id) return res.status(400).json({ error: 'Un pezzo univoco ha sempre quantità 1' });
  const qm = parseInt(req.body.qty_max);
  if (isNaN(qm) || qm < 1) return res.status(400).json({ error: 'Quantità massima non valida' });
  if (qm < v.qty_caricata) return res.status(400).json({ error: `Non può essere inferiore alla quantità caricata (${v.qty_caricata})` });
  db.prepare('UPDATE flck_voci SET qty_max=? WHERE id=?').run(qm, v.id);
  res.json({ ok: true });
});
app.delete('/api/flck/voci/:id', (req, res) => {
  touch();
  const v = db.prepare('SELECT * FROM flck_voci WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Voce non trovata' });
  if (v.qty_caricata > 0) return res.status(400).json({ error: 'Scarica prima il contenuto dal flightcase K' });
  db.prepare('DELETE FROM flck_voci WHERE id=?').run(v.id);
  res.json({ ok: true });
});
app.post('/api/flck/voci/:id/carica', (req, res) => {
  touch();
  const v = db.prepare('SELECT v.*, a.modello_id FROM flck_voci v JOIN articoli a ON a.id=v.art_id WHERE v.id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Voce non trovata' });
  const q = v.modello_id ? 1 : parseInt(req.body.qty);
  if (isNaN(q) || q <= 0) return res.status(400).json({ error: 'Quantità non valida' });
  if (v.qty_caricata + q > v.qty_max) return res.status(400).json({ error: `Capienza superata (max ${v.qty_max}, già caricati ${v.qty_caricata})` });
  const magId = flckMag(v.flck_art_id);
  if (!magId) return res.status(400).json({ error: 'Il flightcase K non è in nessun magazzino reale' });
  const uid = req.session.user.id, data = new Date().toISOString();
  const kNome = db.prepare('SELECT nome FROM articoli WHERE id=?').get(v.flck_art_id)?.nome || '';
  try {
    db.transaction(() => {
      if (!stockDecrement(v.art_id, magId, q)) {
        const r = db.prepare('SELECT qty FROM stock WHERE art_id=? AND mag_id=?').get(v.art_id, magId);
        throw new Error(`Stock insufficiente: nello stesso magazzino ne risultano ${r?.qty || 0}`);
      }
      const u = db.prepare('UPDATE flck_voci SET qty_caricata=qty_caricata+? WHERE id=? AND qty_caricata+?<=qty_max').run(q, v.id, q);
      if (u.changes === 0) throw new Error('Capienza superata');
      db.prepare('INSERT INTO spostamenti (art_id,mag_from,mag_to,qty,tipo,note,data,user_id) VALUES (?,?,?,?,?,?,?,?)')
        .run(v.art_id, magId, null, q, 'scarico', `Caricato in: ${kNome}`, data, uid);
    })();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: safeErr(e, 'flck-carica') }); }
});
app.post('/api/flck/voci/:id/scarica', (req, res) => {
  touch();
  const v = db.prepare('SELECT v.*, a.modello_id FROM flck_voci v JOIN articoli a ON a.id=v.art_id WHERE v.id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Voce non trovata' });
  const q = v.modello_id ? 1 : parseInt(req.body.qty);
  if (isNaN(q) || q <= 0) return res.status(400).json({ error: 'Quantità non valida' });
  if (q > v.qty_caricata) return res.status(400).json({ error: `Nel case ce ne sono solo ${v.qty_caricata}` });
  const magId = flckMag(v.flck_art_id);
  if (!magId) return res.status(400).json({ error: 'Il flightcase K non è in nessun magazzino reale' });
  const uid = req.session.user.id, data = new Date().toISOString();
  const kNome = db.prepare('SELECT nome FROM articoli WHERE id=?').get(v.flck_art_id)?.nome || '';
  db.transaction(() => {
    db.prepare('INSERT INTO stock (art_id,mag_id,qty) VALUES (?,?,?) ON CONFLICT(art_id,mag_id) DO UPDATE SET qty=qty+excluded.qty').run(v.art_id, magId, q);
    db.prepare('UPDATE flck_voci SET qty_caricata=qty_caricata-? WHERE id=?').run(q, v.id);
    db.prepare('INSERT INTO spostamenti (art_id,mag_from,mag_to,qty,tipo,note,data,user_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(v.art_id, null, magId, q, 'carico', `Scaricato da: ${kNome}`, data, uid);
  })();
  res.json({ ok: true });
});
app.delete('/api/flck/:id', (req, res) => {
  touch();
  const k = db.prepare('SELECT a.id, a.nome FROM articoli a JOIN categorie c ON c.id=a.cat_id WHERE a.id=? AND c.prefisso=?').get(req.params.id, 'FLCK');
  if (!k) return res.status(404).json({ error: 'Flightcase K non trovato' });
    try {
    const uid = req.session.user.id, data = new Date().toISOString();
    db.transaction(() => {
      // il contenuto ancora dentro torna nello stock, dove si trova il case
      const dove = db.prepare('SELECT mag_id FROM stock WHERE art_id=? AND qty>0').get(k.id)?.mag_id;
      for (const v of db.prepare('SELECT * FROM flck_voci WHERE flck_art_id=? AND qty_caricata>0').all(k.id)) {
        if (!dove) throw new Error('Flightcase K senza magazzino');
        db.prepare('INSERT INTO stock (art_id,mag_id,qty) VALUES (?,?,?) ON CONFLICT(art_id,mag_id) DO UPDATE SET qty=qty+excluded.qty').run(v.art_id, dove, v.qty_caricata);
        db.prepare('INSERT INTO spostamenti (art_id,mag_from,mag_to,qty,tipo,note,data,user_id) VALUES (?,?,?,?,?,?,?,?)')
          .run(v.art_id, null, dove, v.qty_caricata, 'carico', `Estratto da: ${k.nome} (eliminato)`, data, uid);
      }
      db.prepare('DELETE FROM flck_voci WHERE flck_art_id=?').run(k.id);
      const righeIds = db.prepare('SELECT id FROM lista_righe WHERE art_id=?').all(k.id).map(r => r.id);
      for (const rigaId of righeIds) db.prepare('DELETE FROM lista_flag WHERE riga_id=?').run(rigaId);
      db.prepare('DELETE FROM lista_righe WHERE art_id=?').run(k.id);
      db.prepare('DELETE FROM spostamenti WHERE art_id=?').run(k.id);
      db.prepare('DELETE FROM stock WHERE art_id=?').run(k.id);
      db.prepare('DELETE FROM articoli WHERE id=?').run(k.id);
    })();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: safeErr(e, 'DELETE flck') }); }
});

// ─── MODELLI (pezzi univoci con varianti) ───
const isUnico = id => !!db.prepare('SELECT 1 FROM articoli WHERE id=? AND modello_id IS NOT NULL').get(id);
function pulisciVarianti(v) {
  const out = [], visti = new Set();
  for (const x of (Array.isArray(v) ? v : [])) {
    const t = String(x ?? '').trim().slice(0, 40);
    if (t && !visti.has(t.toLowerCase())) { visti.add(t.toLowerCase()); out.push(t); }
  }
  return out.slice(0, 30);
}
const varDi = m => { try { return JSON.parse(m.varianti || '[]'); } catch { return []; } };
// Crea n pezzi univoci "Nome #k" con codice "CODICE-k". Il contatore k non riparte mai (i numeri tolti non si riusano).
function creaPezzi(modelloId, n, variante) {
  const m = db.prepare('SELECT * FROM modelli WHERE id=?').get(modelloId);
  const pfx = db.prepare('SELECT prefisso FROM categorie WHERE id=?').get(m.cat_id).prefisso;
  let codice = m.codice;
  if (!codice) { codice = pfx + prossimoNumero(pfx); db.prepare('UPDATE modelli SET codice=? WHERE id=?').run(codice, m.id); }
  let k = m.prossimo || 1;
  const ins = db.prepare('INSERT INTO articoli (codice,nome,cat_id,um,note,modello_id,variante) VALUES (?,?,?,?,?,?,?)');
  const ids = [];
  for (let i = 0; i < n; i++, k++) {
    const nome = `${m.nome} #${k}`;
    if (db.prepare('SELECT 1 FROM articoli WHERE nome=? OR codice=?').get(nome, `${codice}-${k}`)) throw new Error('UNIQUE: ' + nome);
    ids.push(Number(ins.run(`${codice}-${k}`, nome, m.cat_id, 'pz', m.note || '', m.id, variante).lastInsertRowid));
  }
  db.prepare('UPDATE modelli SET prossimo=? WHERE id=?').run(k, m.id);
  return ids;
}
app.get('/api/modelli', (_, res) =>
  res.json(db.prepare('SELECT * FROM modelli ORDER BY nome').all().map(m => ({ ...m, varianti: varDi(m) }))));
// Crea l'articolo generico: nome, categoria, elenco varianti. I pezzi nascono al carico.
app.post('/api/modelli', (req, res) => {
  touch();
  const { nome, cat_id, note = '' } = req.body;
  const varianti = pulisciVarianti(req.body.varianti);
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome obbligatorio' });
  if (!cat_id) return res.status(400).json({ error: 'Categoria obbligatoria' });
  if (!varianti.length) return res.status(400).json({ error: 'Indica almeno una variante' });
  const cat = db.prepare('SELECT prefisso FROM categorie WHERE id=?').get(cat_id);
  if (!cat) return res.status(400).json({ error: 'Categoria non trovata' });
  if (['BAU', 'FLC', 'FLCK'].includes(cat.prefisso)) return res.status(400).json({ error: 'Categoria non consentita per i pezzi con varianti' });
  if (!cat.prefisso) return res.status(400).json({ error: 'La categoria scelta non ha un prefisso codice' });
  try {
    const codice = cat.prefisso + prossimoNumero(cat.prefisso);
    const r = db.prepare('INSERT INTO modelli (nome,cat_id,um,note,varianti,codice,prossimo) VALUES (?,?,?,?,?,?,1)').run(nome.trim(), cat_id, 'pz', note, JSON.stringify(varianti), codice);
    res.json({ ok: true, id: Number(r.lastInsertRowid), codice });
  } catch (e) { res.status(400).json({ error: safeErr(e, 'POST modelli') }); }
});
// Carico: crea i pezzi (con la variante scelta per ciascun gruppo) e li mette nel magazzino
app.post('/api/modelli/:id/carica', (req, res) => {
  touch();
  const m = db.prepare('SELECT * FROM modelli WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Articolo non trovato' });
  const { mag_id, note = '' } = req.body;
  if (!mag_id || !db.prepare('SELECT 1 FROM magazzini WHERE id=?').get(mag_id)) return res.status(400).json({ error: 'Magazzino non valido' });
  const vs = varDi(m);
  const righe = (Array.isArray(req.body.righe) ? req.body.righe : []).map(r => ({ variante: String(r.variante ?? '').trim(), qty: parseInt(r.qty) }));
  if (!righe.length || righe.some(r => !(r.qty >= 1) || !vs.includes(r.variante))) return res.status(400).json({ error: 'Scegli la variante e la quantità' });
  const tot = righe.reduce((n, r) => n + r.qty, 0);
  if (tot > 200) return res.status(400).json({ error: 'Al massimo 200 pezzi per volta' });
  const uid = req.session.user.id, data = new Date().toISOString();
  try {
    let ids = [];
    db.transaction(() => {
      for (const r of righe) ids = ids.concat(creaPezzi(m.id, r.qty, r.variante));
      for (const id of ids) {
        db.prepare('INSERT INTO stock (art_id,mag_id,qty) VALUES (?,?,1)').run(id, mag_id);
        db.prepare('INSERT INTO spostamenti (art_id,mag_from,mag_to,qty,tipo,note,data,user_id) VALUES (?,NULL,?,1,?,?,?,?)').run(id, mag_id, 'carico', note, data, uid);
      }
    })();
    res.json({ ok: true, pezzi: ids });
  } catch (e) { res.status(400).json({ error: safeErr(e, 'POST modelli carica') }); }
});
app.post('/api/modelli/:id/pezzi', (req, res) => {
  touch();
  const m = db.prepare('SELECT * FROM modelli WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Modello non trovato' });
  const n = parseInt(req.body.n);
  if (isNaN(n) || n < 1 || n > 200) return res.status(400).json({ error: 'Numero di pezzi non valido (1–200)' });
  const vs = varDi(m);
  const iniz = vs.includes(req.body.variante) ? req.body.variante : (vs[0] || '');
  try {
    let ids;
    db.transaction(() => { ids = creaPezzi(m.id, n, iniz); })();
    res.json({ ok: true, pezzi: ids });
  } catch (e) { res.status(400).json({ error: safeErr(e, 'POST modelli pezzi') }); }
});
app.put('/api/modelli/:id', (req, res) => {
  touch();
  const m = db.prepare('SELECT * FROM modelli WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Modello non trovato' });
  const varianti = pulisciVarianti(req.body.varianti);
  if (!varianti.length) return res.status(400).json({ error: 'Indica almeno una variante' });
  const usate = db.prepare("SELECT DISTINCT variante FROM articoli WHERE modello_id=? AND variante!=''").all(m.id).map(r => r.variante);
  const mancanti = usate.filter(u => !varianti.includes(u));
  if (mancanti.length) return res.status(400).json({ error: 'Variante in uso su alcuni pezzi: ' + mancanti.join(', ') });
  db.prepare('UPDATE modelli SET varianti=? WHERE id=?').run(JSON.stringify(varianti), m.id);
  res.json({ ok: true });
});
app.delete('/api/modelli/:id', (req, res) => {
  touch();
  if (db.prepare('SELECT 1 FROM articoli WHERE modello_id=?').get(req.params.id)) return res.status(400).json({ error: 'Ci sono ancora pezzi di questo articolo: eliminali prima' });
  db.prepare('DELETE FROM modelli WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.put('/api/articoli/:id/variante', (req, res) => {
  touch();
  const a = db.prepare('SELECT a.id, a.modello_id FROM articoli a WHERE a.id=?').get(req.params.id);
  if (!a || !a.modello_id) return res.status(400).json({ error: 'Questo articolo non ha varianti' });
  const m = db.prepare('SELECT * FROM modelli WHERE id=?').get(a.modello_id);
  const v = String(req.body.variante ?? '').trim();
  if (!varDi(m).includes(v)) return res.status(400).json({ error: 'Variante non valida per questo modello' });
  db.prepare('UPDATE articoli SET variante=? WHERE id=?').run(v, a.id);
  res.json({ ok: true });
});

// ===================== STOCK =====================
// ─── STOCK ───
app.get('/api/stock', (_, res) =>
  res.json(db.prepare(`SELECT s.art_id, s.mag_id, s.qty,
    a.codice, a.nome as art_nome, a.um, a.note as art_note, a.modello_id, a.variante,
    c.nome as cat_nome, c.colore, c.prefisso,
    m.nome as mag_nome, m.virtuale
    FROM stock s JOIN articoli a ON a.id=s.art_id JOIN categorie c ON c.id=a.cat_id JOIN magazzini m ON m.id=s.mag_id
    WHERE s.qty>0 ORDER BY m.virtuale ASC, a.codice, m.nome`).all()));
app.post('/api/stock/carica', (req, res) => {
  touch();
  const { art_id, mag_id, qty, note='' } = req.body;
  if (!art_id||!mag_id) return res.status(400).json({ error: 'Campi obbligatori mancanti' });
  const q = parseInt(qty); if (isNaN(q)||q<=0) return res.status(400).json({ error: 'Quantità non valida' });
  const artCat = db.prepare("SELECT c.prefisso FROM articoli a JOIN categorie c ON c.id=a.cat_id WHERE a.id=?").get(art_id);
  if (['BAU','FLC','FLCK'].includes(artCat?.prefisso))
    return res.status(400).json({ error: 'Il carico di bauli e flight case avviene dalla sezione dedicata' });
  if (isUnico(art_id)) {
    if (q !== 1) return res.status(400).json({ error: 'Pezzo univoco: si carica un pezzo alla volta (quantità 1)' });
    const dove = db.prepare('SELECT m.nome FROM stock s JOIN magazzini m ON m.id=s.mag_id WHERE s.art_id=? AND s.qty>0').get(art_id);
    if (dove) return res.status(400).json({ error: `Questo pezzo è già presente in "${dove.nome}": spostalo invece di caricarlo` });
    const inK = db.prepare('SELECT k.nome FROM flck_voci v JOIN articoli k ON k.id=v.flck_art_id WHERE v.art_id=? AND v.qty_caricata>0').get(art_id);
    if (inK) return res.status(400).json({ error: `Questo pezzo è dentro il Flightcase K "${inK.nome}": scaricalo da lì` });
  }
  const uid = req.session.user.id;
  db.transaction(() => {
    db.prepare(`INSERT INTO stock (art_id,mag_id,qty) VALUES (?,?,?) ON CONFLICT(art_id,mag_id) DO UPDATE SET qty=qty+excluded.qty`).run(art_id,mag_id,q);
    db.prepare('INSERT INTO spostamenti (art_id,mag_from,mag_to,qty,tipo,note,data,user_id) VALUES (?,NULL,?,?,?,?,?,?)').run(art_id,mag_id,q,'carico',note,new Date().toISOString(),uid);
  })(); res.json({ ok:true });
});
app.post('/api/stock/scarica', (req, res) => {
  touch();
  const { art_id, mag_id, qty, note='' } = req.body;
  if (!art_id||!mag_id||!qty) return res.status(400).json({ error: 'Campi obbligatori mancanti' });
  const q = parseInt(qty); if (isNaN(q)||q<=0) return res.status(400).json({ error: 'Quantità non valida' });
  const uid = req.session.user.id;
  try {
    db.transaction(() => {
      if (!stockDecrement(art_id, mag_id, q)) {
        const row = db.prepare('SELECT qty FROM stock WHERE art_id=? AND mag_id=?').get(art_id, mag_id);
        throw new Error(`Stock insufficiente: disponibili solo ${row?.qty||0} pz`);
      }
      db.prepare('INSERT INTO spostamenti (art_id,mag_from,mag_to,qty,tipo,note,data,user_id) VALUES (?,?,NULL,?,?,?,?,?)').run(art_id,mag_id,q,'scarico',note,new Date().toISOString(),uid);
    })();
    res.json({ ok:true });
  } catch(e) { res.status(400).json({ error: safeErr(e, 'scarica') }); }
});

// ===================== SPOSTAMENTI =====================
// ─── SPOSTAMENTI ───
app.get('/api/spostamenti', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 200, 500);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const rows = db.prepare(`
    SELECT s.*, a.codice, a.nome as art_nome, a.um, a.variante,
      mf.nome as from_nome, mt.nome as to_nome, u.username as user_nome
    FROM spostamenti s JOIN articoli a ON a.id=s.art_id
    LEFT JOIN magazzini mf ON mf.id=s.mag_from
    LEFT JOIN magazzini mt ON mt.id=s.mag_to
    LEFT JOIN utenti u ON u.id=s.user_id
    ORDER BY s.id DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
  const { total } = db.prepare('SELECT COUNT(*) as total FROM spostamenti').get();
  res.json({ rows, total, limit, offset });
});
app.post('/api/spostamenti', (req, res) => {
  touch();
  const { art_id, mag_from, mag_to, qty, data, note='' } = req.body;
  if (!art_id||!mag_from||!mag_to||!qty) return res.status(400).json({ error: 'Campi obbligatori mancanti' });
  if (mag_from===mag_to) return res.status(400).json({ error: 'Origine e destinazione devono essere diversi' });
  const q = parseInt(qty); if (isNaN(q)||q<=0) return res.status(400).json({ error: 'Quantità non valida' });
  const uid = req.session.user.id;
  const ts = data||new Date().toISOString();
  const fc = db.prepare('SELECT * FROM flightcase_def WHERE art_id=?').get(art_id);
  try {
    db.transaction(() => {
      if (!stockDecrement(art_id, mag_from, q)) {
        const row = db.prepare('SELECT qty FROM stock WHERE art_id=? AND mag_id=?').get(art_id, mag_from);
        const art = db.prepare('SELECT nome FROM articoli WHERE id=?').get(art_id);
        const mag = db.prepare('SELECT nome FROM magazzini WHERE id=?').get(mag_from);
        throw new Error(`Stock insufficiente: disponibili solo ${row?.qty||0} pz di "${art?.nome}" in "${mag?.nome}"`);
      }
      db.prepare(`INSERT INTO stock (art_id,mag_id,qty) VALUES (?,?,?) ON CONFLICT(art_id,mag_id) DO UPDATE SET qty=qty+excluded.qty`).run(art_id,mag_to,q);
      const batchId = null;
      db.prepare('INSERT INTO spostamenti (art_id,mag_from,mag_to,qty,tipo,note,data,user_id,batch_id) VALUES (?,?,?,?,?,?,?,?,?)').run(art_id,mag_from,mag_to,q,'spostamento',note,ts,uid,batchId);
      // Se è un Flightcase K, registra nello storico lo spostamento del contenuto caricato
      for (const v of db.prepare('SELECT art_id, qty_caricata FROM flck_voci WHERE flck_art_id=? AND qty_caricata>0').all(art_id))
        db.prepare('INSERT INTO spostamenti (art_id,mag_from,mag_to,qty,tipo,note,data,user_id,batch_id) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(v.art_id, mag_from, mag_to, v.qty_caricata * q, 'spostamento', `Contenuto di: ${note||db.prepare('SELECT nome FROM articoli WHERE id=?').get(art_id)?.nome||'Flightcase K'}`, ts, uid, null);
      // Se è un FLC con contenuto caricato, sposta anche gli articoli contenuti
      if (fc && fc.qty_caricata > 0) {
        const qtyContenuto = fc.qty_caricata * q; // q case × contenuto per case
        // Lo stock degli articoli contenuti non è nel magazzino (è stato scaricato al carico nel FLC)
        // Quindi non serve spostare stock, ma registriamo nello storico per tracciabilità
        db.prepare('INSERT INTO spostamenti (art_id,mag_from,mag_to,qty,tipo,note,data,user_id,batch_id) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(fc.art_id_contenuto, mag_from, mag_to, qtyContenuto, 'spostamento', `Contenuto di: ${note||db.prepare('SELECT nome FROM articoli WHERE id=?').get(art_id)?.nome||'FLC'}`, ts, uid, null);
      }
    })();
    res.json({ ok:true });
  } catch(e) {
    res.status(400).json({ error: safeErr(e, 'spostamento') });
  }
});


// ─── BATCH SPOSTAMENTI (tour/svuota) ───
app.post('/api/spostamenti/batch', (req, res) => {
  touch();
  const { spostamenti, nota_batch } = req.body;
  if (!Array.isArray(spostamenti) || !spostamenti.length)
    return res.status(400).json({ error: 'Nessuno spostamento' });
  // Validate each item
  for (const s of spostamenti) {
    const q = parseInt(s.qty);
    if (!s.art_id || !s.mag_from || !s.mag_to || isNaN(q) || q <= 0)
      return res.status(400).json({ error: 'Dati spostamento non validi' });
    s.qty = q; // normalise to integer
  }
  const batchId = randomUUID();
  const uid = req.session.user.id;
  const data = new Date().toISOString();
  const ins = db.prepare('INSERT INTO spostamenti (art_id,mag_from,mag_to,qty,tipo,note,data,user_id,batch_id) VALUES (?,?,?,?,?,?,?,?,?)');
  try {
    db.transaction(() => {
      for (const s of spostamenti) {
        if (!stockDecrement(s.art_id, s.mag_from, s.qty)) {
          throw new Error(`Stock insufficiente: art ${s.art_id}`);
        }
        db.prepare(`INSERT INTO stock (art_id,mag_id,qty) VALUES (?,?,?) ON CONFLICT(art_id,mag_id) DO UPDATE SET qty=qty+excluded.qty`).run(s.art_id, s.mag_to, s.qty);
        ins.run(s.art_id, s.mag_from, s.mag_to, s.qty, 'spostamento', nota_batch||'', data, uid, batchId);
      }
    })();
    res.json({ ok: true, batch_id: batchId, n: spostamenti.length });
  } catch(e) {
    res.status(400).json({ error: safeErr(e, 'batch') });
  }
});

// (utenti online integrato in POST /api/ping)

// ─── BAULI ───

// GET tutti i bauli con conteggio voci
app.get('/api/bauli', (req, res) => {
  const cat = db.prepare("SELECT id FROM categorie WHERE prefisso='BAU'").get();
  if (!cat) return res.json([]);
  const bauli = db.prepare(`
    SELECT a.id, a.codice, a.nome, a.note,
      (SELECT COUNT(*) FROM baule_voci WHERE art_id=a.id) as n_voci
    FROM articoli a WHERE a.cat_id=? ORDER BY a.nome
  `).all(cat.id);
  res.json(bauli);
});

// GET voci di un baule
app.get('/api/bauli/:id/voci', (req, res) => {
  const voci = db.prepare('SELECT * FROM baule_voci WHERE art_id=? ORDER BY id').all(req.params.id);
  res.json(voci);
});

// POST nuovo baule (tutti gli utenti)
app.post('/api/bauli', (req, res) => {
  touch();
  const cat = db.prepare("SELECT id, prefisso FROM categorie WHERE prefisso='BAU'").get();
  if (!cat) return res.status(400).json({ error: 'Categoria Bauli non trovata' });
  const { nome, note='', mag_id } = req.body;
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome obbligatorio' });
  if (!mag_id)       return res.status(400).json({ error: 'Magazzino obbligatorio' });
  const row = db.prepare(`SELECT MAX(CAST(SUBSTR(codice,?) AS INTEGER)) as max FROM articoli WHERE codice LIKE ?`)
    .get(cat.prefisso.length+1, cat.prefisso+'%');
  const codice = cat.prefisso + ((row?.max||0)+1);
  try {
    const uid = req.session.user.id;
    const data = new Date().toISOString();
    db.transaction(() => {
      const r = db.prepare('INSERT INTO articoli (codice,nome,cat_id,um,note) VALUES (?,?,?,?,?)')
        .run(codice, nome.trim(), cat.id, 'pz', note);
      const artId = r.lastInsertRowid;
      // Stock qty=1 (baule è sempre unitario)
      db.prepare(`INSERT INTO stock (art_id,mag_id,qty) VALUES (?,?,1)
        ON CONFLICT(art_id,mag_id) DO UPDATE SET qty=qty+1`).run(artId, mag_id);
      // Registra come carico nello storico
      db.prepare('INSERT INTO spostamenti (art_id,mag_from,mag_to,qty,tipo,note,data,user_id) VALUES (?,NULL,?,?,?,?,?,?)')
        .run(artId, mag_id, 1, 'carico', `Creazione baule: ${nome.trim()}`, data, uid);
    })();
    res.json({ ok: true, codice });
  } catch(e) {
    res.status(400).json({ error: safeErr(e, 'POST bauli') });
  }
});

// POST nuova voce al baule
app.post('/api/bauli/:id/voci', (req, res) => {
  touch();
  const { nome, qty=1 } = req.body;
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome obbligatorio' });
  const r = db.prepare('INSERT INTO baule_voci (art_id, nome, qty) VALUES (?,?,?)')
    .run(req.params.id, nome.trim(), parseInt(qty)||1);
  res.json({ id: r.lastInsertRowid });
});

// PUT modifica voce
app.put('/api/bauli/voci/:id', (req, res) => {
  touch();
  const { nome, qty } = req.body;
  const v = db.prepare('SELECT * FROM baule_voci WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Voce non trovata' });
  db.prepare('UPDATE baule_voci SET nome=?, qty=? WHERE id=?')
    .run(nome?.trim()||v.nome, parseInt(qty)||v.qty, req.params.id);
  res.json({ ok: true });
});

// DELETE voce dal baule
app.delete('/api/bauli/voci/:id', (req, res) => {
  touch();
  db.prepare('DELETE FROM baule_voci WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// DELETE baule o flight case (solo admin)
app.delete('/api/bauli/:id', (req, res) => {
  touch();
  const fcDel = db.prepare('SELECT * FROM flightcase_def WHERE art_id=?').get(req.params.id);
  const uidDel = req.session.user.id;
  try {
    db.transaction(() => {
      const righeIds = db.prepare('SELECT id FROM lista_righe WHERE art_id=?').all(req.params.id).map(r => r.id);
      for (const rigaId of righeIds) db.prepare('DELETE FROM lista_flag WHERE riga_id=?').run(rigaId);
      db.prepare('DELETE FROM lista_righe WHERE art_id=?').run(req.params.id);
      if (fcDel && fcDel.qty_caricata > 0) {   // i pezzi contenuti tornano in stock dove si trova il case
        const loc = db.prepare('SELECT mag_id FROM stock WHERE art_id=? AND qty>0 ORDER BY mag_id LIMIT 1').get(req.params.id);
        if (loc) {
          const nomeFc = db.prepare('SELECT nome FROM articoli WHERE id=?').get(req.params.id)?.nome || '';
          db.prepare('INSERT INTO stock (art_id,mag_id,qty) VALUES (?,?,?) ON CONFLICT(art_id,mag_id) DO UPDATE SET qty=qty+excluded.qty').run(fcDel.art_id_contenuto, loc.mag_id, fcDel.qty_caricata);
          db.prepare('INSERT INTO spostamenti (art_id,mag_from,mag_to,qty,tipo,note,data,user_id) VALUES (?,?,?,?,?,?,?,?)')
            .run(fcDel.art_id_contenuto, null, loc.mag_id, fcDel.qty_caricata, 'carico', 'Scaricato da: ' + nomeFc + ' (eliminato)', new Date().toISOString(), uidDel);
        }
      }
      db.prepare('DELETE FROM baule_voci WHERE art_id=?').run(req.params.id);
      db.prepare('DELETE FROM flightcase_def WHERE art_id=?').run(req.params.id);
      db.prepare('DELETE FROM spostamenti WHERE art_id=?').run(req.params.id);
      db.prepare('DELETE FROM stock WHERE art_id=?').run(req.params.id);
      db.prepare('DELETE FROM articoli WHERE id=?').run(req.params.id);
    })();
    res.json({ ok: true });
  } catch(e) {
    console.error('Errore eliminazione baule/FLC:', e.message);
    res.status(500).json({ error: safeErr(e, 'DELETE bauli') });
  }
});

// ─── FLIGHT CASE ───

// GET tutti i flight case con definizione e info articolo contenuto
app.get('/api/flightcase', (req, res) => {
  const cat = db.prepare("SELECT id FROM categorie WHERE prefisso='FLC'").get();
  if (!cat) return res.json([]);
  const flc = db.prepare(`
    SELECT a.id, a.codice, a.nome, a.note,
      fc.art_id_contenuto, fc.qty_max, fc.qty_caricata,
      ac.nome as art_contenuto_nome, ac.codice as art_contenuto_codice,
      cc.nome as art_contenuto_cat, cc.colore as art_contenuto_cat_colore
    FROM articoli a
    LEFT JOIN flightcase_def fc ON fc.art_id=a.id
    LEFT JOIN articoli ac ON ac.id=fc.art_id_contenuto
    LEFT JOIN categorie cc ON cc.id=ac.cat_id
    WHERE a.cat_id=? ORDER BY a.nome
  `).all(cat.id);
  res.json(flc);
});

// GET flight case che contengono un dato articolo (per suggerimento liste)
app.get('/api/flightcase/per-articolo/:art_id', (req, res) => {
  const flc = db.prepare(`
    SELECT a.id, a.codice, a.nome, fc.qty_max
    FROM flightcase_def fc
    JOIN articoli a ON a.id=fc.art_id
    WHERE fc.art_id_contenuto=?
  `).all(req.params.art_id);
  res.json(flc);
});

// POST nuovo flight case
app.post('/api/flightcase', (req, res) => {
  touch();
  const cat = db.prepare("SELECT id, prefisso FROM categorie WHERE prefisso='FLC'").get();
  if (!cat) return res.status(400).json({ error: 'Categoria Flight Case non trovata. Riavvia il server.' });
  const { nome, note='', mag_id, art_id_contenuto, qty_max } = req.body;
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome obbligatorio' });
  if (!mag_id) return res.status(400).json({ error: 'Magazzino obbligatorio' });
  if (!art_id_contenuto) return res.status(400).json({ error: 'Articolo contenuto obbligatorio' });
  if (isUnico(art_id_contenuto))
    return res.status(400).json({ error: 'I pezzi univoci con varianti non vanno in un flight case: usa un Flightcase K' });
  const qm = parseInt(qty_max); if (isNaN(qm) || qm < 1) return res.status(400).json({ error: 'Capienza non valida' });
  const row = db.prepare(`SELECT MAX(CAST(SUBSTR(codice,?) AS INTEGER)) as max FROM articoli WHERE codice LIKE ?`)
    .get(cat.prefisso.length+1, cat.prefisso+'%');
  const codice = cat.prefisso + ((row?.max||0)+1);
  try {
    const uid = req.session.user.id;
    const data = new Date().toISOString();
    db.transaction(() => {
      const r = db.prepare('INSERT INTO articoli (codice,nome,cat_id,um,note) VALUES (?,?,?,?,?)')
        .run(codice, nome.trim(), cat.id, 'pz', note);
      const artId = r.lastInsertRowid;
      db.prepare('INSERT INTO flightcase_def (art_id, art_id_contenuto, qty_max, qty_caricata) VALUES (?,?,?,0)').run(artId, art_id_contenuto, qm);
      db.prepare(`INSERT INTO stock (art_id,mag_id,qty) VALUES (?,?,1)
        ON CONFLICT(art_id,mag_id) DO UPDATE SET qty=qty+1`).run(artId, mag_id);
      db.prepare('INSERT INTO spostamenti (art_id,mag_from,mag_to,qty,tipo,note,data,user_id) VALUES (?,NULL,?,?,?,?,?,?)')
        .run(artId, mag_id, 1, 'carico', `Creazione flight case: ${nome.trim()}`, data, uid);
    })();
    res.json({ ok: true, codice });
  } catch(e) {
    console.error('Errore creazione FLC:', e.message);
    res.status(400).json({ error: safeErr(e, 'POST flightcase') });
  }
});

// PUT modifica definizione flight case
app.put('/api/flightcase/:id', (req, res) => {
  touch();
  const { art_id_contenuto, qty_max } = req.body;
  const fc = db.prepare('SELECT * FROM flightcase_def WHERE art_id=?').get(req.params.id);
  if (!fc) return res.status(404).json({ error: 'Flight case non trovato' });
  const newArt = art_id_contenuto || fc.art_id_contenuto;
  if (isUnico(newArt))
    return res.status(400).json({ error: 'I pezzi univoci con varianti non vanno in un flight case: usa un Flightcase K' });
  const newQty = parseInt(qty_max) || fc.qty_max;
  if (newQty < 1) return res.status(400).json({ error: 'Capienza non valida' });
  if (newQty < fc.qty_caricata) return res.status(400).json({ error: `Capienza non può essere inferiore alla quantità caricata (${fc.qty_caricata})` });
  db.prepare('UPDATE flightcase_def SET art_id_contenuto=?, qty_max=? WHERE art_id=?')
    .run(newArt, newQty, req.params.id);
  res.json({ ok: true });
});

// POST carica articoli dentro un flight case
app.post('/api/flightcase/:id/carica', (req, res) => {
  touch();
  const { qty } = req.body;
  const q = parseInt(qty); if (isNaN(q) || q <= 0) return res.status(400).json({ error: 'Quantità non valida' });
  const fc = db.prepare('SELECT * FROM flightcase_def WHERE art_id=?').get(req.params.id);
  if (!fc) return res.status(404).json({ error: 'Flight case non trovato' });
  if (fc.qty_caricata + q > fc.qty_max) return res.status(400).json({ error: `Capienza massima superata (max ${fc.qty_max}, già caricati ${fc.qty_caricata})` });
  const fcStock = db.prepare(`SELECT s.mag_id, s.qty FROM stock s JOIN magazzini m ON m.id=s.mag_id WHERE s.art_id=? AND s.qty>0 AND m.virtuale=0`).all(req.params.id);
  if (!fcStock.length) return res.status(400).json({ error: 'Il flight case non è in nessun magazzino reale' });
  const magId = fcStock[0].mag_id;
  const uid = req.session.user.id;
  const data = new Date().toISOString();
  const artNome = db.prepare('SELECT nome FROM articoli WHERE id=?').get(fc.art_id_contenuto)?.nome || '';
  const fcNome = db.prepare('SELECT nome FROM articoli WHERE id=?').get(+req.params.id)?.nome || '';
  try {
  db.transaction(() => {
    // Atomic: rimuovi articoli dallo stock solo se disponibili
    if (!stockDecrement(fc.art_id_contenuto, magId, q)) {
      const artStock = db.prepare('SELECT qty FROM stock WHERE art_id=? AND mag_id=?').get(fc.art_id_contenuto, magId);
      throw new Error(`Stock insufficiente: disponibili ${artStock?.qty||0} nello stesso magazzino`);
    }
    // Atomic: aggiorna qty_caricata solo se non sfora
    const upd = db.prepare('UPDATE flightcase_def SET qty_caricata=qty_caricata+? WHERE art_id=? AND qty_caricata+?<=qty_max').run(q, req.params.id, q);
    if (upd.changes === 0) throw new Error('Capienza massima superata');
    // Registra nello storico
    db.prepare('INSERT INTO spostamenti (art_id,mag_from,mag_to,qty,tipo,note,data,user_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(fc.art_id_contenuto, magId, null, q, 'scarico', `Caricato in: ${fcNome}`, data, uid);
  })();
  res.json({ ok: true });
  } catch(e) { res.status(400).json({ error: safeErr(e, 'flightcase-carica') }); }
});

// POST scarica articoli da un flight case
app.post('/api/flightcase/:id/scarica', (req, res) => {
  touch();
  const { qty } = req.body;
  const q = parseInt(qty); if (isNaN(q) || q <= 0) return res.status(400).json({ error: 'Quantità non valida' });
  const fc = db.prepare('SELECT * FROM flightcase_def WHERE art_id=?').get(req.params.id);
  if (!fc) return res.status(404).json({ error: 'Flight case non trovato' });
  if (q > fc.qty_caricata) return res.status(400).json({ error: `Nel case ci sono solo ${fc.qty_caricata} pezzi` });
  // Il FLC deve essere in un magazzino reale
  const fcStock = db.prepare(`SELECT s.mag_id FROM stock s JOIN magazzini m ON m.id=s.mag_id WHERE s.art_id=? AND s.qty>0 AND m.virtuale=0`).all(req.params.id);
  if (!fcStock.length) return res.status(400).json({ error: 'Il flight case non è in nessun magazzino reale' });
  const magId = fcStock[0].mag_id;
  const uid = req.session.user.id;
  const data = new Date().toISOString();
  const fcNome = db.prepare('SELECT nome FROM articoli WHERE id=?').get(+req.params.id)?.nome || '';
  db.transaction(() => {
    // Rimetti articoli nello stock libero
    db.prepare(`INSERT INTO stock (art_id,mag_id,qty) VALUES (?,?,?) ON CONFLICT(art_id,mag_id) DO UPDATE SET qty=qty+excluded.qty`)
      .run(fc.art_id_contenuto, magId, q);
    // Aggiorna qty_caricata
    db.prepare('UPDATE flightcase_def SET qty_caricata=qty_caricata-? WHERE art_id=?').run(q, req.params.id);
    // Registra nello storico
    db.prepare('INSERT INTO spostamenti (art_id,mag_from,mag_to,qty,tipo,note,data,user_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(fc.art_id_contenuto, null, magId, q, 'carico', `Scaricato da: ${fcNome}`, data, uid);
  })();
  res.json({ ok: true });
});



// ── Avvio: carica (o crea) il database ──
window.localReady = (async () => {
  SQL = await initSqlJs({ locateFile: f => f });
  const saved = await idbGet(DB_KEY);
  raw = saved ? new SQL.Database(saved) : new SQL.Database();
  raw.exec('PRAGMA foreign_keys = ON');
  db = makeDb();
  db.exec(`
  CREATE TABLE IF NOT EXISTS utenti (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    ruolo         TEXT NOT NULL DEFAULT 'utente',
    attivo        INTEGER NOT NULL DEFAULT 1,
    creato_il     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS magazzini (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL UNIQUE,
    citta TEXT DEFAULT '', note TEXT DEFAULT '',
    colore TEXT DEFAULT '#2563eb', virtuale INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS categorie (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL UNIQUE,
    colore TEXT DEFAULT '#3b82f6', prefisso TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS articoli (
    id INTEGER PRIMARY KEY AUTOINCREMENT, codice TEXT NOT NULL UNIQUE,
    nome TEXT NOT NULL UNIQUE, cat_id INTEGER NOT NULL REFERENCES categorie(id),
    um TEXT DEFAULT 'pz', note TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS stock (
    art_id INTEGER NOT NULL REFERENCES articoli(id),
    mag_id INTEGER NOT NULL REFERENCES magazzini(id),
    qty INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (art_id, mag_id)
  );
  CREATE TABLE IF NOT EXISTS spostamenti (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    art_id INTEGER NOT NULL REFERENCES articoli(id),
    mag_from INTEGER REFERENCES magazzini(id),
    mag_to INTEGER REFERENCES magazzini(id),
    qty INTEGER NOT NULL, tipo TEXT NOT NULL DEFAULT 'spostamento',
    note TEXT DEFAULT '', data TEXT NOT NULL,
    user_id INTEGER REFERENCES utenti(id)
  );
  CREATE TABLE IF NOT EXISTS baule_voci (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    art_id    INTEGER NOT NULL REFERENCES articoli(id) ON DELETE CASCADE,
    nome      TEXT    NOT NULL,
    qty       INTEGER NOT NULL DEFAULT 1,
    creato_il TEXT    DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS flightcase_def (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    art_id           INTEGER NOT NULL UNIQUE REFERENCES articoli(id) ON DELETE CASCADE,
    art_id_contenuto INTEGER NOT NULL REFERENCES articoli(id),
    qty_max          INTEGER NOT NULL DEFAULT 1,
    qty_caricata     INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS liste_carico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    note TEXT DEFAULT '',
    mag_dest_id INTEGER REFERENCES magazzini(id),
    stato TEXT NOT NULL DEFAULT 'inattiva',
    creato_da INTEGER REFERENCES utenti(id),
    creato_il TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS lista_righe (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lista_id INTEGER NOT NULL REFERENCES liste_carico(id) ON DELETE CASCADE,
    art_id INTEGER NOT NULL REFERENCES articoli(id),
    qty_richiesta INTEGER NOT NULL DEFAULT 1,
    note_riga TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS lista_flag (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    riga_id INTEGER NOT NULL REFERENCES lista_righe(id) ON DELETE CASCADE,
    mag_id INTEGER NOT NULL REFERENCES magazzini(id),
    qty_presa INTEGER NOT NULL DEFAULT 0,
    UNIQUE(riga_id, mag_id)
  );
`);

// Migrazioni per DB esistenti
function migrate(sql, desc) {
  try {
    db.exec(sql);
  } catch(e) {
    if (!e.message.includes('duplicate column name') && !e.message.includes('already exists')) {
      console.warn(`Migrazione fallita (${desc}):`, e.message);
    }
  }
}

migrate(`ALTER TABLE magazzini ADD COLUMN virtuale INTEGER DEFAULT 0`, 'magazzini.virtuale');
migrate(`ALTER TABLE magazzini ADD COLUMN colore TEXT DEFAULT '#2563eb'`, 'magazzini.colore');
migrate(`ALTER TABLE categorie ADD COLUMN prefisso TEXT NOT NULL DEFAULT ''`, 'categorie.prefisso');
migrate(`ALTER TABLE articoli ADD COLUMN codice TEXT NOT NULL DEFAULT ''`, 'articoli.codice');
migrate(`ALTER TABLE spostamenti ADD COLUMN user_id INTEGER REFERENCES utenti(id)`, 'spostamenti.user_id');
migrate(`ALTER TABLE magazzini ADD COLUMN icona TEXT DEFAULT '🏭'`, 'magazzini.icona');
migrate(`ALTER TABLE magazzini ADD COLUMN classe TEXT DEFAULT 'stabile'`, 'magazzini.classe');
migrate(`ALTER TABLE spostamenti ADD COLUMN batch_id TEXT DEFAULT NULL`, 'spostamenti.batch_id');
migrate(`ALTER TABLE liste_carico ADD COLUMN tipo TEXT NOT NULL DEFAULT 'normale'`, 'liste_carico.tipo');
migrate(`ALTER TABLE flightcase_def ADD COLUMN qty_caricata INTEGER NOT NULL DEFAULT 0`, 'flightcase_def.qty_caricata');
migrate(`ALTER TABLE articoli ADD COLUMN modello_id INTEGER DEFAULT NULL`, 'articoli.modello_id');
migrate(`ALTER TABLE articoli ADD COLUMN variante TEXT NOT NULL DEFAULT ''`, 'articoli.variante');
migrate(`CREATE TABLE IF NOT EXISTS flck_voci (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flck_art_id INTEGER NOT NULL REFERENCES articoli(id) ON DELETE CASCADE,
  art_id INTEGER NOT NULL REFERENCES articoli(id),
  qty_max INTEGER NOT NULL DEFAULT 1,
  qty_caricata INTEGER NOT NULL DEFAULT 0,
  UNIQUE(flck_art_id, art_id)
)`, 'flck_voci');
migrate(`CREATE TABLE IF NOT EXISTS modelli (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL UNIQUE,
  cat_id INTEGER NOT NULL REFERENCES categorie(id),
  um TEXT DEFAULT 'pz', note TEXT DEFAULT '', varianti TEXT NOT NULL DEFAULT '[]'
)`, 'modelli');
migrate(`ALTER TABLE modelli ADD COLUMN codice TEXT`, 'modelli.codice');
migrate(`ALTER TABLE modelli ADD COLUMN prossimo INTEGER NOT NULL DEFAULT 1`, 'modelli.prossimo');
try {   // il contatore dei pezzi riparte da dopo l'ultimo numero già usato
  for (const m of db.prepare('SELECT id FROM modelli').all()) {
    let k = 0;
    for (const e of db.prepare('SELECT nome FROM articoli WHERE modello_id=?').all(m.id)) { const mm = /#(\d+)$/.exec(e.nome); if (mm) k = Math.max(k, parseInt(mm[1])); }
    db.prepare('UPDATE modelli SET prossimo=MAX(prossimo,?) WHERE id=?').run(k + 1, m.id);
  }
} catch (e) { console.warn('Migrazione modelli:', e.message); }
try { db.exec(`UPDATE liste_carico SET tipo='veloce' WHERE tipo='provvisoria'`); } catch(e) { console.warn('Migrazione tipo lista:', e.message); }

// Migration: ensure ON DELETE CASCADE on critical FK relationships
// SQLite cannot ALTER COLUMN constraints, so we add application-level cascade via triggers
try {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_art_del_stock AFTER DELETE ON articoli BEGIN
      DELETE FROM stock WHERE art_id=OLD.id;
      DELETE FROM baule_voci WHERE art_id=OLD.id;
      DELETE FROM flightcase_def WHERE art_id=OLD.id;
      UPDATE spostamenti SET art_id=NULL WHERE art_id=OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_mag_del_stock AFTER DELETE ON magazzini BEGIN
      DELETE FROM stock WHERE mag_id=OLD.id;
      UPDATE spostamenti SET mag_from=NULL WHERE mag_from=OLD.id;
      UPDATE spostamenti SET mag_to=NULL WHERE mag_to=OLD.id;
      UPDATE liste_carico SET mag_dest_id=NULL WHERE mag_dest_id=OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_cat_del_art AFTER DELETE ON categorie BEGIN
      DELETE FROM articoli WHERE cat_id=OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_user_del_ref AFTER DELETE ON utenti BEGIN
      UPDATE spostamenti SET user_id=NULL WHERE user_id=OLD.id;
      UPDATE liste_carico SET creato_da=NULL WHERE creato_da=OLD.id;
    END;
  `);
} catch(e) { console.warn('Migration triggers:', e.message); }

// Indexes for frequently queried columns
try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_spostamenti_art ON spostamenti(art_id);
    CREATE INDEX IF NOT EXISTS idx_spostamenti_data ON spostamenti(data DESC);
    CREATE INDEX IF NOT EXISTS idx_spostamenti_batch ON spostamenti(batch_id);
    CREATE INDEX IF NOT EXISTS idx_spostamenti_magfrom ON spostamenti(mag_from);
    CREATE INDEX IF NOT EXISTS idx_spostamenti_magto ON spostamenti(mag_to);
    CREATE INDEX IF NOT EXISTS idx_lista_righe_lista ON lista_righe(lista_id);
    CREATE INDEX IF NOT EXISTS idx_lista_flag_riga ON lista_flag(riga_id);
    CREATE INDEX IF NOT EXISTS idx_baule_voci_art ON baule_voci(art_id);
    CREATE INDEX IF NOT EXISTS idx_flightcase_art ON flightcase_def(art_id);
    CREATE INDEX IF NOT EXISTS idx_flightcase_contenuto ON flightcase_def(art_id_contenuto);
    CREATE INDEX IF NOT EXISTS idx_articoli_cat ON articoli(cat_id);
  `);
} catch(e) { console.warn('Migration indexes:', e.message); }


  db.exec("INSERT OR IGNORE INTO utenti (id,username,password_hash,ruolo) VALUES (1,'iPad','-','admin')");
  if (!db.prepare('SELECT id FROM magazzini WHERE virtuale=1').get())
    db.prepare("INSERT INTO magazzini (nome,citta,virtuale) VALUES ('Cestino','',1)").run();
  if (!db.prepare("SELECT id FROM categorie WHERE prefisso='BAU'").get())
    db.prepare('INSERT OR IGNORE INTO categorie (nome,colore,prefisso) VALUES (?,?,?)').run('Bauli speciali', '#92400e', 'BAU');
  if (!db.prepare("SELECT id FROM categorie WHERE prefisso='FLC'").get())
    db.prepare('INSERT OR IGNORE INTO categorie (nome,colore,prefisso) VALUES (?,?,?)').run('Flight Case', '#6b4c6e', 'FLC');
  if (!db.prepare("SELECT id FROM categorie WHERE prefisso='FLCK'").get())
    db.prepare('INSERT OR IGNORE INTO categorie (nome,colore,prefisso) VALUES (?,?,?)').run('Flightcase K', '#0e7490', 'FLCK');
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (_) {}
  await save();
})();

// ── Elimina il database corrente (ripartenza da zero) ──
window.eliminaDb = async () => {
  if (!confirm('Eliminare TUTTO il database di questo iPad?\n\nArticoli, magazzini, bauli e flight case verranno cancellati per sempre.\nSe non hai ancora esportato un backup, premi Annulla ed esporta prima.')) return;
  const t = prompt('Per confermare scrivi ELIMINA');
  if (t === null || t.trim().toUpperCase() !== 'ELIMINA') { alert('Annullato: il database non è stato toccato.'); return; }
  resetting = true; clearTimeout(timer); timer = null;
  try { await idbDel(DB_KEY); }
  catch (e) { resetting = false; alert('Impossibile eliminare il database: ' + (e.message || e)); return; }
  location.reload();
};

// ── Backup: esporta / importa il file .db ──
window.exportaDb = async () => {
  await window.localReady;
  if (document.getElementById('expDbOv')) return;
  const base = 'wareflow-' + new Date().toISOString().slice(0, 10);
  const ov = document.createElement('div');
  ov.id = 'expDbOv';
  ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(26,24,20,.55);display:flex;align-items:center;justify-content:center;padding:20px;font-family:"DM Sans",system-ui,sans-serif';
  ov.innerHTML = '<div style="background:#fff;color:#1a1814;border-radius:14px;padding:20px;width:100%;max-width:360px;box-shadow:0 12px 40px rgba(0,0,0,.35)">' +
    '<div style="font-size:17px;font-weight:700;margin-bottom:12px">Esporta database</div>' +
    '<label style="font-size:12px;color:#6b6358;display:block;margin-bottom:6px">Nome del file</label>' +
    '<div style="display:flex;align-items:center;gap:6px"><input id="expDbName" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" style="flex:1;min-width:0;font-size:16px;padding:10px 12px;border:1px solid #cfc8ba;border-radius:8px"><span style="font-size:14px;color:#6b6358">.db</span></div>' +
    '<div id="expDbMsg" style="font-size:12px;color:#b45309;margin-top:10px;display:none"></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">' +
    '<button id="expDbNo" type="button" style="padding:10px 16px;border-radius:8px;border:1px solid #cfc8ba;background:#fff;font-size:14px;font-weight:600">Annulla</button>' +
    '<button id="expDbOk" type="button" style="padding:10px 18px;border-radius:8px;border:0;background:#1a1814;color:#fff;font-size:14px;font-weight:700">Salva</button></div></div>';
  document.body.appendChild(ov);
  const inp = ov.querySelector('#expDbName'), msg = ov.querySelector('#expDbMsg'), ok = ov.querySelector('#expDbOk');
  inp.value = base; inp.focus(); inp.select();
  const close = () => ov.remove();
  const scarica = file => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const nomeFile = () => {
    let n = inp.value.replace(/\.(db|sqlite3?)$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
    return (n || base) + '.db';
  };
  ov.querySelector('#expDbNo').onclick = close;
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  let modoScarica = false;
  ok.onclick = async () => {
    const file = new File([snapshot()], nomeFile(), { type: 'application/octet-stream' });
    if (modoScarica) { scarica(file); close(); return; }
    let canShare = false;
    try { canShare = !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) {}
    if (!canShare) { scarica(file); close(); return; }          // nessuna condivisione disponibile: un solo download
    try { await navigator.share({ files: [file], title: file.name }); close(); }
    catch (e) {
      if (e && e.name === 'AbortError') { close(); return; }      // annullato dall'utente
      msg.textContent = 'La condivisione non è riuscita. Premi "Scarica" per salvare il file.';   // niente download automatico: un solo file
      msg.style.display = 'block'; ok.textContent = 'Scarica'; modoScarica = true;
    }
  };
};
window.importaDb = async inp => {
  const f = inp.files[0]; inp.value = ''; if (!f) return;
  try {
    await window.localReady;
    const buf = new Uint8Array(await f.arrayBuffer());
    const t = new SQL.Database(buf);
    const n = t.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('articoli','categorie','magazzini','stock')");
    t.close();
    if (!n.length || n[0].values.length !== 4) throw new Error('File non valido: non è un database WareFlow');
    if (!confirm('Importare "' + f.name + '"?\nTutti i dati presenti su questo iPad verranno sostituiti.')) return;
    await idbSet(DB_KEY, buf); location.reload();
  } catch (e) { alert(e.message || 'Errore importazione'); }
};
})();

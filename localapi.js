/* WareFlow Offline — livello dati locale (generato da build.py, non modificare a mano) */
(function () {
'use strict';
const DB_KEY = 'db';
const USER = { id: 1, username: 'iPad', ruolo: 'admin' };
let SQL, raw, db, timer = null;

// ── IndexedDB (persistenza del file .db) ──
const idb = () => new Promise((ok, ko) => {
  const r = indexedDB.open('wareflow-offline', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
});
const idbGet = async k => { const d = await idb(); return new Promise((ok, ko) => {
  const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => ok(q.result); q.onerror = () => ko(q.error); }); };
const idbSet = async (k, v) => { const d = await idb(); return new Promise((ok, ko) => {
  const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = ok; t.onerror = () => ko(t.error); }); };

// export() di sql.js chiude e riapre il DB: i PRAGMA vanno reimpostati
function snapshot() { const b = raw.export(); raw.exec('PRAGMA foreign_keys = ON'); return b; }
const save = () => idbSet(DB_KEY, snapshot());
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
  const row = db.prepare(`
    SELECT MAX(CAST(SUBSTR(codice, ?) AS INTEGER)) as max
    FROM articoli WHERE codice LIKE ?
  `).get(prefisso.length + 1, prefisso + '%');
  return (row?.max || 0) + 1;
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
  if (catPfx?.prefisso === 'BAU' || catPfx?.prefisso === 'FLC')
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
  if (catPfx?.prefisso === 'BAU' || catPfx?.prefisso === 'FLC')
    return res.status(400).json({ error: 'Non puoi spostare un articolo nelle categorie Bauli o Flight Case' });
  if (!codice?.trim()) return res.status(400).json({ error: 'Codice obbligatorio' });
  if (db.prepare('SELECT id FROM articoli WHERE codice=? AND id!=?').get(codice.trim().toUpperCase(),req.params.id)) return res.status(400).json({ error: `Codice "${codice}" già esistente` });
  try { db.prepare('UPDATE articoli SET codice=?,nome=?,cat_id=?,um=?,note=? WHERE id=?').run(codice.trim().toUpperCase(),nome.trim(),cat_id,um,note,req.params.id); res.json({ ok:true }); }
  catch { res.status(400).json({ error: 'Esiste già un articolo con questo nome' }); }
});
app.delete('/api/articoli/:id', (req, res) => {
  touch();
  const inFlc = db.prepare('SELECT a.nome FROM flightcase_def f JOIN articoli a ON a.id=f.art_id WHERE f.art_id_contenuto=?').get(req.params.id);
  if (inFlc) return res.status(400).json({ error: 'È il contenuto del flight case "' + inFlc.nome + '": elimina prima il flight case' });
  try {
    db.transaction(() => {
      const righeIds = db.prepare('SELECT id FROM lista_righe WHERE art_id=?').all(req.params.id).map(r => r.id);
      for (const rigaId of righeIds) db.prepare('DELETE FROM lista_flag WHERE riga_id=?').run(rigaId);
      db.prepare('DELETE FROM lista_righe WHERE art_id=?').run(req.params.id);
      db.prepare('DELETE FROM baule_voci WHERE art_id=?').run(req.params.id);
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

// ===================== STOCK =====================
// ─── STOCK ───
app.get('/api/stock', (_, res) =>
  res.json(db.prepare(`SELECT s.art_id, s.mag_id, s.qty,
    a.codice, a.nome as art_nome, a.um, a.note as art_note,
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
  if (artCat?.prefisso === 'BAU' || artCat?.prefisso === 'FLC')
    return res.status(400).json({ error: 'Il carico di bauli e flight case avviene dalla sezione dedicata' });
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
    SELECT s.*, a.codice, a.nome as art_nome, a.um,
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
  const stockReale = db.prepare(`
    SELECT COUNT(*) as n FROM stock s
    JOIN magazzini m ON m.id=s.mag_id
    WHERE s.art_id=? AND s.qty>0 AND m.virtuale=0
  `).get(req.params.id);
  if (stockReale.n > 0)
    return res.status(400).json({ error: 'Sposta prima nel cestino prima di eliminare' });
  try {
    db.transaction(() => {
      const righeIds = db.prepare('SELECT id FROM lista_righe WHERE art_id=?').all(req.params.id).map(r => r.id);
      for (const rigaId of righeIds) db.prepare('DELETE FROM lista_flag WHERE riga_id=?').run(rigaId);
      db.prepare('DELETE FROM lista_righe WHERE art_id=?').run(req.params.id);
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
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (_) {}
  await save();
})();

// ── Backup: esporta / importa il file .db ──
window.exportaDb = async () => {
  await window.localReady;
  const name = 'wareflow-' + new Date().toISOString().slice(0, 10) + '.db';
  const file = new File([snapshot()], name, { type: 'application/octet-stream' });
  try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; } }
  catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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

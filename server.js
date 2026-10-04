const express = require('express'), multer = require('multer'), Database = require('better-sqlite3');
const crypto = require('crypto'), fs = require('fs'), path = require('path');

const PORT = process.env.PORT || 3000;
const PASS = process.env.ADMIN_PASSWORD || 'admin123';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const UP = path.join(DATA, 'uploads');
// Pagamento online (Mercado Pago). Sem MP_ACCESS_TOKEN o botão "Pagar online" não aparece.
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const MP_INSTALLMENTS = Math.min(12, Math.max(1, parseInt(process.env.MP_MAX_INSTALLMENTS, 10) || 12));
const MP_BOLETO = process.env.MP_ALLOW_BOLETO === '1';
fs.mkdirSync(UP, { recursive: true });
if (!process.env.ADMIN_PASSWORD) console.warn('⚠️  Defina ADMIN_PASSWORD! Usando a senha padrão "admin123".');

// ---------- Banco de dados ----------
const db = new Database(path.join(DATA, 'vitrine.db'));
db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '', price TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS images(id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, filename TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
INSERT OR IGNORE INTO settings VALUES('title','NCR iPhone'),('whatsapp','');
`);

db.prepare("UPDATE settings SET value='NCR iPhone' WHERE key='title' AND value='Vitrine de iPhones'").run();
if (!db.prepare('PRAGMA table_info(products)').all().some(c => c.name === 'installments')) db.exec("ALTER TABLE products ADD COLUMN installments TEXT DEFAULT ''");
if (!db.prepare('PRAGMA table_info(products)').all().some(c => c.name === 'cond')) db.exec("ALTER TABLE products ADD COLUMN cond TEXT DEFAULT ''");
const condOf = v => (v === 'novo' || v === 'semi') ? v : '';
// ---------- Autenticação (cookie assinado) ----------
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const hash = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));
const token = () => { const exp = String(Date.now() + 7 * 864e5); return exp + '.' + sign(exp); };
const valid = t => { if (!t) return false; const [e, s] = t.split('.'); return !!s && Number(e) > Date.now() && safeEq(s, sign(e)); };
const getSid = req => (req.headers.cookie || '').split(';').map(c => c.trim().split('=')).find(([k]) => k === 'sid')?.[1];
const auth = (req, res, next) => valid(getSid(req)) ? next() : res.status(401).json({ error: 'Não autorizado' });

// ---------- Upload ----------
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({ destination: UP, filename: (r, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + EXT[f.mimetype]) }),
  limits: { fileSize: 8 * 1024 * 1024, files: 12 },
  fileFilter: (r, f, cb) => EXT[f.mimetype] ? cb(null, true) : cb(new Error('Use fotos JPG, PNG ou WebP.'))
});
const rmFile = n => fs.unlink(path.join(UP, n), () => {});
const rmUploaded = files => (files || []).forEach(f => rmFile(f.filename));
const addImgs = (id, files) => { const ins = db.prepare('INSERT INTO images(product_id,filename) VALUES(?,?)'); (files || []).forEach(f => ins.run(id, f.filename)); };

function list() {
  const m = {};
  db.prepare('SELECT id,product_id,filename FROM images ORDER BY id').all().forEach(i => (m[i.product_id] ??= []).push({ id: i.id, url: '/uploads/' + i.filename }));
  return db.prepare('SELECT * FROM products ORDER BY id DESC').all().map(p => ({ ...p, images: m[p.id] || [] }));
}
const settings = () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]));

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });

// público
app.get('/api/products', (req, res) => res.json(list()));
app.get('/api/settings', (req, res) => res.json(settings()));

// login
const tries = new Map();
app.post('/api/login', (req, res) => {
  const t = tries.get(req.ip) || { n: 0, at: Date.now() };
  if (Date.now() - t.at > 9e5) { t.n = 0; t.at = Date.now(); }
  if (t.n >= 10) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
  if (!safeEq(req.body.password || '', PASS)) { t.n++; tries.set(req.ip, t); return res.status(401).json({ error: 'Senha incorreta' }); }
  tries.delete(req.ip);
  res.setHeader('Set-Cookie', `sid=${token()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ ok: true }));

// admin
app.put('/api/settings', auth, (req, res) => {
  const up = db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)');
  up.run('title', String(req.body.title || '').trim().slice(0, 80) || 'NCR iPhone');
  up.run('whatsapp', String(req.body.whatsapp || '').replace(/\D/g, ''));
  res.json(settings());
});

app.post('/api/products', auth, upload.array('images', 12), (req, res) => {
  const { name = '', description = '', price = '', installments = '', cond = '' } = req.body;
  if (!name.trim()) { rmUploaded(req.files); return res.status(400).json({ error: 'Informe o nome do produto.' }); }
  const id = db.prepare('INSERT INTO products(name,description,price,installments,cond) VALUES(?,?,?,?,?)').run(name.trim(), description.trim(), price.trim(), installments.trim().slice(0, 600), condOf(cond)).lastInsertRowid;
  addImgs(id, req.files);
  res.json({ id, cond: condOf(cond) });
});

app.post('/api/products/import', auth, (req, res) => {
  const blocks = String(req.body.text || '').split(/\n\s*\n/).map(b => b.split('\n').map(l => l.trim()).filter(Boolean)).filter(b => b.length);
  const ins = db.prepare('INSERT INTO products(name,description,price,installments,cond) VALUES(?,?,?,?,?)');
  let count = 0;
  db.transaction(() => blocks.slice(0, 200).forEach(lines => {
    const name = lines.shift().replace(/^(?:[-•*#]+|\d+[.)])\s*/, '').slice(0, 120);
    if (!name) return;
    const pi = lines.findIndex(l => /^(r\$|pre[çc]o|valor)/i.test(l));
    const price = pi >= 0 ? lines.splice(pi, 1)[0].replace(/^(pre[çc]o|valor)\s*:?\s*/i, '').slice(0, 40) : '';
    const ci = lines.findIndex(l => /^(semi[\s-]?novo|novo)s?$/i.test(l));
    const cond = ci >= 0 ? (/^semi/i.test(lines.splice(ci, 1)[0]) ? 'semi' : 'novo') : '';
    const inst = lines.filter(l => /^(parcel|\d{1,2}\s*x\b)/i.test(l));
    ins.run(name, lines.filter(l => !inst.includes(l)).join('\n').slice(0, 2000), price, inst.join('\n').slice(0, 600), cond); count++;
  }))();
  res.json({ count });
});

app.put('/api/products/:id', auth, upload.array('images', 12), (req, res) => {
  const id = +req.params.id;
  if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(id)) { rmUploaded(req.files); return res.status(404).json({ error: 'Produto não encontrado.' }); }
  const { name = '', description = '', price = '', installments = '', cond = '' } = req.body;
  if (!name.trim()) { rmUploaded(req.files); return res.status(400).json({ error: 'Informe o nome do produto.' }); }
  db.prepare('UPDATE products SET name=?,description=?,price=?,installments=?,cond=? WHERE id=?').run(name.trim(), description.trim(), price.trim(), installments.trim().slice(0, 600), condOf(cond), id);
  let remove = []; try { remove = JSON.parse(req.body.remove || '[]'); } catch {}
  remove.forEach(imgId => {
    const r = db.prepare('SELECT filename FROM images WHERE id=? AND product_id=?').get(+imgId, id);
    if (r) { rmFile(r.filename); db.prepare('DELETE FROM images WHERE id=?').run(+imgId); }
  });
  addImgs(id, req.files);
  res.json({ ok: true, cond: condOf(cond) });
});

app.delete('/api/products/:id', auth, (req, res) => {
  const id = +req.params.id;
  db.prepare('SELECT filename FROM images WHERE product_id=?').all(id).forEach(r => rmFile(r.filename));
  db.prepare('DELETE FROM products WHERE id=?').run(id);
  res.json({ ok: true });
});

// ---------- Links personalizados ----------
db.exec(`CREATE TABLE IF NOT EXISTS links(slug TEXT PRIMARY KEY, greeting TEXT DEFAULT '', whatsapp TEXT DEFAULT '', product_ids TEXT DEFAULT '', views INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
const slugify = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function viewOf(slug, count) {
  const s = settings();
  if (!slug) return { title: s.title, greeting: '', whatsapp: s.whatsapp, pay: !!MP_TOKEN, products: list() };
  const l = db.prepare('SELECT * FROM links WHERE slug=?').get(slug);
  if (!l) return null;
  if (count) db.prepare('UPDATE links SET views=views+1 WHERE slug=?').run(slug);
  const ids = l.product_ids ? l.product_ids.split(',').map(Number) : null;
  return { title: s.title, greeting: l.greeting, whatsapp: l.whatsapp || s.whatsapp, pay: !!MP_TOKEN, products: list().filter(p => !ids || ids.includes(p.id)) };
}
app.get('/api/view', (q, r) => r.json(viewOf('', true)));
app.get('/api/view/:slug', (q, r) => { const v = viewOf(slugify(q.params.slug), true); v ? r.json(v) : r.status(404).json({ error: 'Link inválido ou removido.' }); });

// página com pré-visualização (Open Graph) para quando o link for colado no WhatsApp
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
function page(req, res, slug) {
  const v = viewOf(slug, false), base = req.protocol + '://' + req.get('host');
  const img = v && v.products.find(p => p.images.length)?.images[0].url;
  const og = v ? `<meta property="og:title" content="${esc(v.title)}"><meta property="og:description" content="${esc(v.greeting || 'Confira os iPhones disponíveis')}">${img ? `<meta property="og:image" content="${base + img}">` : ''}` : '';
  res.status(v ? 200 : 404).type('html').send(INDEX.replace('<!--OG-->', og));
}
app.get('/', (q, r) => page(q, r, ''));
app.get('/v/:slug', (q, r) => page(q, r, slugify(q.params.slug)));

app.get('/api/links', auth, (q, r) => r.json(db.prepare('SELECT * FROM links ORDER BY created_at DESC').all()));
app.post('/api/links', auth, (q, r) => {
  const b = q.body, slug = slugify(b.slug) || crypto.randomBytes(3).toString('hex');
  const ids = (Array.isArray(b.product_ids) ? b.product_ids : []).map(Number).filter(Number.isInteger).join(',');
  db.prepare(`INSERT INTO links(slug,greeting,whatsapp,product_ids) VALUES(?,?,?,?) ON CONFLICT(slug) DO UPDATE SET greeting=excluded.greeting,whatsapp=excluded.whatsapp,product_ids=excluded.product_ids`)
    .run(slug, String(b.greeting || '').trim().slice(0, 200), String(b.whatsapp || '').replace(/\D/g, ''), ids);
  r.json({ slug });
});
app.delete('/api/links/:slug', auth, (q, r) => { db.prepare('DELETE FROM links WHERE slug=?').run(q.params.slug); r.json({ ok: true }); });

// ---------- Pagamento online (Mercado Pago · Checkout Pro) ----------
db.exec(`CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE NOT NULL, slug TEXT DEFAULT '', customer TEXT DEFAULT '', phone TEXT DEFAULT '',
  items TEXT NOT NULL, total REAL NOT NULL, status TEXT DEFAULT 'pending', mp_payment_id TEXT DEFAULT '', mp_method TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, paid_at TEXT DEFAULT '')`);

// "R$ 5.999" -> 5999 | "R$ 5.999,90" -> 5999.9 | texto sem número -> null (o preço SEMPRE é lido no servidor)
const priceNum = s => {
  const m = String(s || '').match(/\d[\d.]*(?:,\d{1,2})?/); if (!m) return null;
  const t = m[0], n = /^\d+\.\d{1,2}$/.test(t) ? parseFloat(t) : parseFloat(t.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const mpFetch = (p, opt = {}) => fetch('https://api.mercadopago.com' + p, { ...opt, headers: { Authorization: 'Bearer ' + MP_TOKEN, 'Content-Type': 'application/json' } });
const baseUrl = req => PUBLIC_URL || (req.protocol + '://' + req.get('host'));

const payTries = new Map();
app.post('/api/checkout', async (req, res) => {
  if (!MP_TOKEN) return res.status(503).json({ error: 'O pagamento online não está ativado.' });
  const t = payTries.get(req.ip) || { n: 0, at: Date.now() };
  if (Date.now() - t.at > 9e5) { t.n = 0; t.at = Date.now(); }
  if (++t.n > 20) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
  payTries.set(req.ip, t);

  const slug = slugify(req.body.slug), v = viewOf(slug, false);
  if (!v) return res.status(404).json({ error: 'Link inválido ou removido.' });
  const items = [];
  for (const a of (Array.isArray(req.body.items) ? req.body.items : []).slice(0, 30)) {
    const p = v.products.find(x => x.id === Number(a.id)), qty = Math.floor(Number(a.qty));
    if (!p || !(qty >= 1 && qty <= 99)) continue;
    const unit = priceNum(p.price);
    if (unit == null) return res.status(400).json({ error: `"${p.name}" está sem preço definido. Envie o interesse pelo WhatsApp.` });
    items.push({ id: p.id, name: p.name, qty, unit });
  }
  if (!items.length) return res.status(400).json({ error: 'Seu carrinho está vazio.' });

  const total = Math.round(items.reduce((s, i) => s + i.unit * i.qty, 0) * 100) / 100;
  const ref = crypto.randomBytes(8).toString('hex');
  const customer = String(req.body.name || '').trim().slice(0, 80), phone = String(req.body.phone || '').replace(/\D/g, '').slice(0, 15);
  const base = baseUrl(req), back = r => `${base}/pedido.html?ref=${ref}&r=${r}`;
  const pref = {
    items: items.map(i => ({ id: String(i.id), title: i.name.slice(0, 250), quantity: i.qty, unit_price: i.unit, currency_id: 'BRL' })),
    external_reference: ref, statement_descriptor: 'NCR IPHONE',
    back_urls: { success: back('ok'), pending: back('pending'), failure: back('fail') },
    payment_methods: { installments: MP_INSTALLMENTS, excluded_payment_types: MP_BOLETO ? [] : [{ id: 'ticket' }] }
  };
  if (customer) pref.payer = { name: customer };
  if (base.startsWith('https://')) { pref.auto_return = 'approved'; pref.notification_url = base + '/api/mp/webhook'; }
  try {
    const r = await mpFetch('/checkout/preferences', { method: 'POST', body: JSON.stringify(pref) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.init_point) { console.error('Mercado Pago recusou a preferência:', r.status, JSON.stringify(j)); return res.status(502).json({ error: 'Não foi possível iniciar o pagamento. Tente de novo ou envie pelo WhatsApp.' }); }
    db.prepare('INSERT INTO orders(ref,slug,customer,phone,items,total) VALUES(?,?,?,?,?,?)').run(ref, slug, customer, phone, JSON.stringify(items), total);
    res.json({ url: j.init_point, ref });
  } catch (e) {
    console.error('Mercado Pago:', e.message);
    res.status(502).json({ error: 'Não foi possível iniciar o pagamento. Tente de novo ou envie pelo WhatsApp.' });
  }
});

// Nunca confiamos no que chega no webhook: o pagamento é sempre consultado de volta na API do Mercado Pago.
async function syncPayment(id) {
  const r = await mpFetch('/v1/payments/' + encodeURIComponent(id));
  if (!r.ok) throw new Error('consulta do pagamento falhou (' + r.status + ')');
  const p = await r.json();
  const o = db.prepare('SELECT * FROM orders WHERE ref=?').get(String(p.external_reference || ''));
  if (!o) return;
  let status = o.status;
  if (p.status === 'approved') status = 'paid';
  else if (['refunded', 'charged_back'].includes(p.status)) status = 'refunded';
  else if (['rejected', 'cancelled'].includes(p.status)) { if (o.status !== 'paid') status = 'failed'; }
  else if (o.status !== 'paid') status = 'pending';
  if (status === 'paid' && Number(p.transaction_amount) + 0.005 < o.total) status = 'check';
  db.prepare("UPDATE orders SET status=?, mp_payment_id=?, mp_method=?, paid_at=CASE WHEN ?='paid' AND paid_at='' THEN CURRENT_TIMESTAMP ELSE paid_at END WHERE ref=?")
    .run(status, String(p.id), p.payment_type_id || '', status, o.ref);
}
app.post('/api/mp/webhook', (req, res) => {
  res.sendStatus(200);
  const q = req.query || {}, b = req.body || {}, type = b.type || q.type || q.topic;
  const id = (b.data && b.data.id) || q['data.id'] || (q.topic === 'payment' ? q.id : null);
  if (MP_TOKEN && type === 'payment' && id) syncPayment(id).catch(e => console.error('Webhook:', e.message));
});

// status do pedido (usado pela página /pedido.html). Se o cliente voltou do Mercado Pago com payment_id, confirma na hora.
app.get('/api/order/:ref', async (req, res) => {
  const get = () => db.prepare('SELECT * FROM orders WHERE ref=?').get(String(req.params.ref).slice(0, 32));
  let o = get();
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const pid = String(req.query.payment_id || '').replace(/\D/g, '');
  if (MP_TOKEN && pid && o.status !== 'paid') { try { await syncPayment(pid); o = get(); } catch (e) { console.error('Pedido:', e.message); } }
  const v = viewOf(o.slug, false);
  res.json({ ref: o.ref, slug: o.slug, status: o.status, method: o.mp_method, customer: o.customer, total: o.total, items: JSON.parse(o.items), whatsapp: (v && v.whatsapp) || settings().whatsapp });
});
app.get('/api/orders', auth, (q, r) => r.json(db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 100').all().map(o => ({ ...o, items: JSON.parse(o.items) }))));

app.use('/uploads', express.static(UP, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => res.status(400).json({ error: err.message || 'Erro' }));

app.listen(PORT, () => console.log(`Vitrine: http://localhost:${PORT}  |  Admin: http://localhost:${PORT}/admin.html`));

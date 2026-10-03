const express = require('express'), multer = require('multer'), Database = require('better-sqlite3');
const crypto = require('crypto'), fs = require('fs'), path = require('path');

const PORT = process.env.PORT || 3000;
const PASS = process.env.ADMIN_PASSWORD || 'admin123';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const UP = path.join(DATA, 'uploads');
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
  limits: { fileSize: 8 * 1024 * 1024, files: 8 },
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

app.post('/api/products', auth, upload.array('images', 8), (req, res) => {
  const { name = '', description = '', price = '' } = req.body;
  if (!name.trim()) { rmUploaded(req.files); return res.status(400).json({ error: 'Informe o nome do produto.' }); }
  const id = db.prepare('INSERT INTO products(name,description,price) VALUES(?,?,?)').run(name.trim(), description.trim(), price.trim()).lastInsertRowid;
  addImgs(id, req.files);
  res.json({ id });
});

app.post('/api/products/import', auth, (req, res) => {
  const blocks = String(req.body.text || '').split(/\n\s*\n/).map(b => b.split('\n').map(l => l.trim()).filter(Boolean)).filter(b => b.length);
  const ins = db.prepare('INSERT INTO products(name,description,price) VALUES(?,?,?)');
  let count = 0;
  db.transaction(() => blocks.slice(0, 200).forEach(lines => {
    const name = lines.shift().replace(/^(?:[-•*#]+|\d+[.)])\s*/, '').slice(0, 120);
    if (!name) return;
    const pi = lines.findIndex(l => /^(r\$|pre[çc]o|valor)/i.test(l));
    const price = pi >= 0 ? lines.splice(pi, 1)[0].replace(/^(pre[çc]o|valor)\s*:?\s*/i, '').slice(0, 40) : '';
    ins.run(name, lines.join('\n').slice(0, 2000), price); count++;
  }))();
  res.json({ count });
});

app.put('/api/products/:id', auth, upload.array('images', 8), (req, res) => {
  const id = +req.params.id;
  if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(id)) { rmUploaded(req.files); return res.status(404).json({ error: 'Produto não encontrado.' }); }
  const { name = '', description = '', price = '' } = req.body;
  if (!name.trim()) { rmUploaded(req.files); return res.status(400).json({ error: 'Informe o nome do produto.' }); }
  db.prepare('UPDATE products SET name=?,description=?,price=? WHERE id=?').run(name.trim(), description.trim(), price.trim(), id);
  let remove = []; try { remove = JSON.parse(req.body.remove || '[]'); } catch {}
  remove.forEach(imgId => {
    const r = db.prepare('SELECT filename FROM images WHERE id=? AND product_id=?').get(+imgId, id);
    if (r) { rmFile(r.filename); db.prepare('DELETE FROM images WHERE id=?').run(+imgId); }
  });
  addImgs(id, req.files);
  res.json({ ok: true });
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
  if (!slug) return { title: s.title, greeting: '', whatsapp: s.whatsapp, products: list() };
  const l = db.prepare('SELECT * FROM links WHERE slug=?').get(slug);
  if (!l) return null;
  if (count) db.prepare('UPDATE links SET views=views+1 WHERE slug=?').run(slug);
  const ids = l.product_ids ? l.product_ids.split(',').map(Number) : null;
  return { title: s.title, greeting: l.greeting, whatsapp: l.whatsapp || s.whatsapp, products: list().filter(p => !ids || ids.includes(p.id)) };
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

app.use('/uploads', express.static(UP, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => res.status(400).json({ error: err.message || 'Erro' }));

app.listen(PORT, () => console.log(`Vitrine: http://localhost:${PORT}  |  Admin: http://localhost:${PORT}/admin.html`));

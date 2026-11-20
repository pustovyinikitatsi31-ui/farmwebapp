'use strict';
// Green Farm — практикум №2: Express + вбудована SQLite (node:sqlite) + JWT
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'database.db');

/* ------------------------------------------------------------------ */
/* 1. База даних: 4 пов'язані таблиці                                  */
/* ------------------------------------------------------------------ */
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    phone         TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS categories (
    category_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS products (
    product_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES categories (category_id),
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    price       REAL NOT NULL CHECK (price > 0),
    unit        TEXT NOT NULL DEFAULT 'шт',
    image       TEXT
);
CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    product_id    INTEGER NOT NULL REFERENCES products (product_id),
    quantity      INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
    unit_price    REAL NOT NULL,
    address       TEXT NOT NULL,
    delivery_date TEXT NOT NULL,
    comment       TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'done', 'cancelled')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category_id);
`);

// початкові дані (лише при першому запуску)
if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
    const addCat = db.prepare('INSERT INTO categories (name) VALUES (?)');
    const cat = {};
    ['Молочна продукція', 'Мед', 'Яйця', 'Овочі', 'Фрукти'].forEach(function (n) {
        cat[n] = Number(addCat.run(n).lastInsertRowid);
    });
    const addProd = db.prepare(
        'INSERT INTO products (category_id, name, description, price, unit, image) VALUES (?, ?, ?, ?, ?, ?)'
    );
    [
        ['Молочна продукція', 'Фермерське молоко', 'Свіже натуральне молоко.', 40, 'л', 'img/milk.jpg'],
        ['Молочна продукція', 'Домашній сир', 'Сир власного виробництва.', 180, 'кг', 'img/cheese.jpg'],
        ['Мед', 'Натуральний мед', 'Мед із власної пасіки.', 250, 'банка', 'img/honey.jpg'],
        ['Яйця', 'Домашні яйця', 'Яйця від курей вільного вигулу.', 70, 'десяток', 'img/eggs.jpg'],
        ['Овочі', 'Органічні помідори', 'Свіжі овочі без нітратів.', 90, 'кг', 'img/tomato.jpg'],
        ['Фрукти', 'Садові яблука', 'Яблука з фермерського саду.', 35, 'кг', 'img/apple.jpg']
    ].forEach(function (p) {
        addProd.run(cat[p[0]], p[1], p[2], p[3], p[4], p[5]);
    });
}

/* ------------------------------------------------------------------ */
/* 2. Допоміжні функції та валідація                                   */
/* ------------------------------------------------------------------ */
class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9]{10,13}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// bcrypt враховує лише перші 72 байти пароля
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10);

function parseId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Некоректний id');
    return id;
}

function todayUtc() {
    return new Date().toISOString().slice(0, 10);
}

function validDate(s) {
    if (!DATE_RE.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function checkUser(b) {
    const name = str(b.name);
    const email = str(b.email).toLowerCase();
    const phone = str(b.phone);
    const password = typeof b.password === 'string' ? b.password : '';
    if (name.length < 2) throw new HttpError(400, "Ім'я: мінімум 2 символи");
    if (name.length > 100) throw new HttpError(400, "Ім'я: максимум 100 символів");
    if (!EMAIL_RE.test(email) || email.length > 120) throw new HttpError(400, 'Email: некоректний формат');
    if (!PHONE_RE.test(phone)) throw new HttpError(400, 'Телефон: від 10 до 13 цифр');
    if (password.length < 6) throw new HttpError(400, 'Пароль: мінімум 6 символів');
    if (password.length > 72) throw new HttpError(400, 'Пароль: максимум 72 символи');
    return { name, email, phone, password };
}

function checkOrder(b, partial) {
    const out = {};
    if (!partial || b.product_id !== undefined) {
        const productId = Number(b.product_id);
        if (!Number.isInteger(productId) || productId < 1) throw new HttpError(400, 'Товар: оберіть товар зі списку');
        const product = db.prepare('SELECT product_id, price FROM products WHERE product_id = ?').get(productId);
        if (!product) throw new HttpError(400, 'Товар: не знайдено');
        out.product_id = product.product_id;
        out.unit_price = product.price;
    }
    const quantity = Number(b.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
        throw new HttpError(400, 'Кількість: ціле число від 1 до 100');
    }
    out.quantity = quantity;
    const address = str(b.address);
    if (address.length < 10) throw new HttpError(400, 'Адреса: мінімум 10 символів');
    if (address.length > 200) throw new HttpError(400, 'Адреса: максимум 200 символів');
    out.address = address;
    const date = str(b.delivery_date);
    if (!validDate(date)) throw new HttpError(400, 'Дата: формат РРРР-ММ-ДД');
    if (date < todayUtc()) throw new HttpError(400, 'Дата: не може бути в минулому');
    out.delivery_date = date;
    const comment = b.comment === undefined || b.comment === null ? '' : str(b.comment);
    if (comment.length > 300) throw new HttpError(400, 'Коментар: максимум 300 символів');
    out.comment = comment;
    return out;
}

function checkProduct(b) {
    const name = str(b.name);
    if (name.length < 2 || name.length > 100) throw new HttpError(400, 'Назва: від 2 до 100 символів');
    const price = Number(b.price);
    if (!Number.isFinite(price) || price <= 0 || price > 100000) throw new HttpError(400, 'Ціна: число більше 0 і не більше 100000');
    const categoryId = Number(b.category_id);
    if (!Number.isInteger(categoryId) || !db.prepare('SELECT 1 FROM categories WHERE category_id = ?').get(categoryId)) {
        throw new HttpError(400, 'Категорія: не знайдено');
    }
    const description = b.description === undefined || b.description === null ? '' : str(b.description);
    if (description.length > 500) throw new HttpError(400, 'Опис: максимум 500 символів');
    const unit = str(b.unit) || 'шт';
    if (unit.length > 20) throw new HttpError(400, 'Одиниця: максимум 20 символів');
    const image = b.image === undefined || b.image === null || b.image === '' ? null : str(b.image);
    if (image !== null && (image.length > 200 || !/^img\/[\w.\-]+$/.test(image))) {
        throw new HttpError(400, 'Зображення: шлях виду img/назва.jpg');
    }
    return { name, price, category_id: categoryId, description, unit, image };
}

function makeToken(user) {
    return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '2h' });
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role });

/* ------------------------------------------------------------------ */
/* 3. Автентифікація (JWT у заголовку Authorization: Bearer …)         */
/* ------------------------------------------------------------------ */
function auth(req, res, next) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return next(new HttpError(401, 'Потрібна авторизація'));
    let payload;
    try {
        payload = jwt.verify(m[1], JWT_SECRET);
    } catch (e) {
        return next(new HttpError(401, 'Токен недійсний або прострочений'));
    }
    const user = db.prepare('SELECT id, name, email, phone, role FROM users WHERE id = ?').get(payload.sub);
    if (!user) return next(new HttpError(401, 'Користувача не знайдено'));
    req.user = user;
    next();
}

function adminOnly(req, res, next) {
    if (req.user.role !== 'admin') return next(new HttpError(403, 'Недостатньо прав'));
    next();
}

/* ------------------------------------------------------------------ */
/* 4. Клієнтський JS: віддається за маршрутом /app.js — don't touch    */
/* ------------------------------------------------------------------ */
const CLIENT_JS = `
function getToken() { try { return localStorage.getItem("token"); } catch (e) { return null; } }
function setToken(t) { localStorage.setItem("token", t); }
function logout() { localStorage.removeItem("token"); location.href = "index.html"; }
function esc(v) {
    return String(v).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
}
function today() { return new Date().toISOString().slice(0, 10); }
function show(el, text, type) { el.textContent = text; el.className = type || ""; }
`;

/* ------------------------------------------------------------------ */
/* 5. Маршрути                                                         */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json({ limit: '50kb' }));

app.get('/app.js', function (req, res) {
    res.type('application/javascript').send(CLIENT_JS);
});

/* --- автентифікація --- */
app.post('/api/register', function (req, res) {
    const u = checkUser(req.body || {});
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(u.email)) {
        throw new HttpError(409, 'Такий email уже зареєстровано');
    }
    const role = ADMIN_EMAIL && u.email === ADMIN_EMAIL ? 'admin' : 'user';
    const hash = bcrypt.hashSync(u.password, 10); // пароль зберігається лише у вигляді хешу
    const info = db
        .prepare('INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)')
        .run(u.name, u.email, u.phone, hash, role);
    const user = { id: Number(info.lastInsertRowid), name: u.name, email: u.email, phone: u.phone, role };
    res.status(201).json({ token: makeToken(user), user: publicUser(user) });
});

app.post('/api/login', function (req, res) {
    const b = req.body || {};
    const email = str(b.email).toLowerCase();
    const password = typeof b.password === 'string' ? b.password : '';
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Email: некоректний формат');
    if (!password) throw new HttpError(400, 'Пароль: обовʼязкове поле');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // порівнюємо хеш і для неіснуючого користувача, щоб відповідь не виказувала, чи є такий email
    const ok = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, 'Невірний email або пароль');
    res.json({ token: makeToken(user), user: publicUser(user) });
});

app.get('/api/me', auth, function (req, res) {
    res.json(publicUser(req.user));
});

/* --- категорії --- */
app.get('/api/categories', function (req, res) {
    res.json(db.prepare('SELECT category_id, name FROM categories ORDER BY category_id').all());
});

/* --- товари: повний CRUD (зміни — лише для адміністратора) --- */
const PRODUCT_SELECT = `
    SELECT p.product_id, p.name, p.description, p.price, p.unit, p.image,
           p.category_id, c.name AS category
    FROM products p JOIN categories c ON c.category_id = p.category_id`;

app.get('/api/products', function (req, res) {
    if (req.query.category !== undefined) {
        const categoryId = parseId(req.query.category);
        return res.json(db.prepare(PRODUCT_SELECT + ' WHERE p.category_id = ? ORDER BY p.product_id').all(categoryId));
    }
    res.json(db.prepare(PRODUCT_SELECT + ' ORDER BY p.product_id').all());
});

app.get('/api/products/:id', function (req, res) {
    const product = db.prepare(PRODUCT_SELECT + ' WHERE p.product_id = ?').get(parseId(req.params.id));
    if (!product) throw new HttpError(404, 'Товар не знайдено');
    res.json(product);
});

app.post('/api/products', auth, adminOnly, function (req, res) {
    const p = checkProduct(req.body || {});
    if (db.prepare('SELECT 1 FROM products WHERE name = ?').get(p.name)) {
        throw new HttpError(409, 'Товар із такою назвою вже існує');
    }
    const info = db
        .prepare('INSERT INTO products (category_id, name, description, price, unit, image) VALUES (?, ?, ?, ?, ?, ?)')
        .run(p.category_id, p.name, p.description, p.price, p.unit, p.image);
    const created = db.prepare(PRODUCT_SELECT + ' WHERE p.product_id = ?').get(Number(info.lastInsertRowid));
    res.status(201).json(created);
});

app.put('/api/products/:id', auth, adminOnly, function (req, res) {
    const id = parseId(req.params.id);
    if (!db.prepare('SELECT 1 FROM products WHERE product_id = ?').get(id)) throw new HttpError(404, 'Товар не знайдено');
    const p = checkProduct(req.body || {});
    if (db.prepare('SELECT 1 FROM products WHERE name = ? AND product_id <> ?').get(p.name, id)) {
        throw new HttpError(409, 'Товар із такою назвою вже існує');
    }
    db.prepare(
        'UPDATE products SET category_id = ?, name = ?, description = ?, price = ?, unit = ?, image = ? WHERE product_id = ?'
    ).run(p.category_id, p.name, p.description, p.price, p.unit, p.image, id);
    res.json(db.prepare(PRODUCT_SELECT + ' WHERE p.product_id = ?').get(id));
});

app.delete('/api/products/:id', auth, adminOnly, function (req, res) {
    const id = parseId(req.params.id);
    if (!db.prepare('SELECT 1 FROM products WHERE product_id = ?').get(id)) throw new HttpError(404, 'Товар не знайдено');
    if (db.prepare('SELECT 1 FROM orders WHERE product_id = ?').get(id)) {
        throw new HttpError(409, 'Товар не можна видалити: він є у замовленнях');
    }
    db.prepare('DELETE FROM products WHERE product_id = ?').run(id);
    res.status(204).end();
});

/* --- замовлення: повний CRUD --- */
const ORDER_SELECT = `
    SELECT o.id, o.user_id, u.email AS user_email, o.product_id, p.name AS product_name,
           o.quantity, o.unit_price, o.quantity * o.unit_price AS total,
           o.address, o.delivery_date, o.comment, o.status, o.created_at
    FROM orders o
    JOIN products p ON p.product_id = o.product_id
    JOIN users u ON u.id = o.user_id`;

function loadOrder(req) {
    const order = db.prepare(ORDER_SELECT + ' WHERE o.id = ?').get(parseId(req.params.id));
    if (!order) throw new HttpError(404, 'Замовлення не знайдено');
    if (order.user_id !== req.user.id && req.user.role !== 'admin') {
        throw new HttpError(403, 'Це замовлення належить іншому користувачу');
    }
    return order;
}

app.get('/api/orders', auth, function (req, res) {
    const rows =
        req.user.role === 'admin'
            ? db.prepare(ORDER_SELECT + ' ORDER BY o.id DESC').all()
            : db.prepare(ORDER_SELECT + ' WHERE o.user_id = ? ORDER BY o.id DESC').all(req.user.id);
    res.json(rows);
});

app.get('/api/orders/:id', auth, function (req, res) {
    res.json(loadOrder(req));
});

app.post('/api/orders', auth, function (req, res) {
    const o = checkOrder(req.body || {}, false);
    const info = db
        .prepare(
            `INSERT INTO orders (user_id, product_id, quantity, unit_price, address, delivery_date, comment)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(req.user.id, o.product_id, o.quantity, o.unit_price, o.address, o.delivery_date, o.comment);
    const created = db.prepare(ORDER_SELECT + ' WHERE o.id = ?').get(Number(info.lastInsertRowid));
    res.status(201).json(created);
});

app.put('/api/orders/:id', auth, function (req, res) {
    const current = loadOrder(req);
    const b = req.body || {};
    if (b.status !== undefined) {
        // статус змінює лише адміністратор
        if (req.user.role !== 'admin') throw new HttpError(403, 'Статус змінює лише адміністратор');
        if (!['new', 'done', 'cancelled'].includes(b.status)) throw new HttpError(400, 'Статус: new, done або cancelled');
    } else if (current.status !== 'new') {
        throw new HttpError(409, 'Редагувати можна лише нове замовлення');
    }
    const o = checkOrder(
        {
            product_id: b.product_id === undefined ? current.product_id : b.product_id,
            quantity: b.quantity,
            address: b.address,
            delivery_date: b.delivery_date,
            comment: b.comment
        },
        false
    );
    // ціну фіксуємо на момент створення, якщо товар не змінювався
    const unitPrice = o.product_id === current.product_id ? current.unit_price : o.unit_price;
    db.prepare(
        `UPDATE orders SET product_id = ?, quantity = ?, unit_price = ?, address = ?, delivery_date = ?,
                           comment = ?, status = ? WHERE id = ?`
    ).run(o.product_id, o.quantity, unitPrice, o.address, o.delivery_date, o.comment, b.status || current.status, current.id);
    res.json(db.prepare(ORDER_SELECT + ' WHERE o.id = ?').get(current.id));
});

app.delete('/api/orders/:id', auth, function (req, res) {
    const order = loadOrder(req);
    db.prepare('DELETE FROM orders WHERE id = ?').run(order.id);
    res.status(204).end();
});

/* --- сторінки та статика (лише дозволені файли) --- */
app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get(/^\/([a-z]+)\.html$/, function (req, res, next) {
    const page = req.params[0];
    if (!['index', 'catalog', 'cheese', 'about', 'order', 'cabinet', 'register'].includes(page)) return next();
    res.sendFile(path.join(__dirname, page + '.html'));
});
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/img', express.static(path.join(__dirname, 'img')));

/* --- 404 та обробка помилок --- */
app.use('/api', function (req, res) {
    res.status(404).json({ error: 'Ресурс не знайдено' });
});
app.use(function (req, res) {
    res.status(404).type('text/plain; charset=utf-8').send('Сторінку не знайдено');
});
app.use(function (err, req, res, next) { // eslint-disable-line no-unused-vars
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некоректний JSON у тілі запиту' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Тіло запиту завелике' });
    console.error(err);
    res.status(500).json({ error: 'Внутрішня помилка сервера' });
});

app.listen(PORT, function () {
    console.log('Green Farm: http://localhost:' + PORT);
});

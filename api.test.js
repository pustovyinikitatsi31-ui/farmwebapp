'use strict';
// Автоматичні тести REST API Green Farm (9 тестів, замість ручного Postman).
// Спочатку запустіть сервер (npm start), потім: npm run test:api
// Адреса сервера за замовчуванням http://localhost:3000 (змінна BASE_URL).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const email = 'autotest_' + Date.now() + '@example.com';
const user = { name: 'Автотест', email, phone: '380671234567', password: 'secret123' };
let token;
let orderId;


const LOG_FILE = 'api-log.txt';
fs.writeFileSync(LOG_FILE, '');
function hide(obj) { // не показуємо паролі й токени повністю
    return JSON.parse(JSON.stringify(obj, function (key, value) {
        if (key === 'password') return '***';
        if (key === 'token' && typeof value === 'string') return value.slice(0, 15) + '...';
        return value;
    }));
}
function log(method, url, reqBody, status, resBody) {
    const lines = ['', method + ' ' + url];
    if (reqBody) lines.push('Тіло запиту: ' + JSON.stringify(hide(reqBody)));
    lines.push('Статус-код: ' + status);
    if (Array.isArray(resBody) && resBody.length > 1) { // довгі масиви скорочуємо
        resBody = { 'всього елементів': resBody.length, 'перший елемент': resBody[0] };
    }
    lines.push('Відповідь: ' + (resBody ? JSON.stringify(hide(resBody), null, 2) : '(порожня)'));
    const text = lines.join('\n');
    console.log(text);
    fs.appendFileSync(LOG_FILE, text + '\n');
}

async function api(method, url, body, tok) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (tok) headers.Authorization = 'Bearer ' + tok;
    const res = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    log(method, url, body, res.status, json);
    return { status: res.status, json };
}

function order(extra) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 3);
    return { product_id: 1, quantity: 2, address: 'Київ, вул. Хрещатик, 1', delivery_date: d.toISOString().slice(0, 10), ...extra };
}

test('1. GET /api/products → 200 і масив товарів з полями', async () => {
    const r = await api('GET', '/api/products');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json) && r.json.length > 0);
    for (const f of ['product_id', 'name', 'price', 'unit', 'category']) assert.ok(f in r.json[0]);
});

test('2. GET /api/products/999999 → 404 з полем error', async () => {
    const r = await api('GET', '/api/products/999999');
    assert.equal(r.status, 404);
    assert.equal(typeof r.json.error, 'string');
});

test('3. POST /api/register (коректні дані) → 201, токен, без пароля', async () => {
    const r = await api('POST', '/api/register', user);
    assert.equal(r.status, 201);
    assert.equal(typeof r.json.token, 'string');
    assert.equal(r.json.user.email, email);
    assert.equal('password_hash' in r.json.user, false);
    token = r.json.token;
});

test('4. POST /api/register (повторний email) → 409', async () => {
    const r = await api('POST', '/api/register', user);
    assert.equal(r.status, 409);
});

test('5. POST /api/login (неправильний пароль) → 401', async () => {
    const r = await api('POST', '/api/login', { email, password: 'wrong-password' });
    assert.equal(r.status, 401);
});

test('6. GET /api/me: без токена → 401, з токеном → 200', async () => {
    assert.equal((await api('GET', '/api/me')).status, 401);
    const r = await api('GET', '/api/me', null, token);
    assert.equal(r.status, 200);
    assert.equal(r.json.email, email);
});

test('7. POST /api/orders (коректні дані) → 201, сума = кількість × ціна', async () => {
    const r = await api('POST', '/api/orders', order(), token);
    assert.equal(r.status, 201);
    assert.equal(r.json.status, 'new');
    assert.equal(r.json.total, r.json.quantity * r.json.unit_price);
    orderId = r.json.id;
});

test('8. POST /api/orders (кількість 0) → 400, без токена → 401', async () => {
    const bad = await api('POST', '/api/orders', order({ quantity: 0 }), token);
    assert.equal(bad.status, 400);
    assert.equal(typeof bad.json.error, 'string');
    assert.equal((await api('POST', '/api/orders', order())).status, 401);
});

test('9. DELETE /api/orders/:id → 204, повторний GET → 404', async () => {
    const r = await api('DELETE', '/api/orders/' + orderId, null, token);
    assert.equal(r.status, 204);
    assert.equal((await api('GET', '/api/orders/' + orderId, null, token)).status, 404);
});

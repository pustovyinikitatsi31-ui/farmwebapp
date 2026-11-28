'use strict';
// Unit-тести серверної логіки Green Farm (6 тестів).
// server.js не змінюється: його код (до рядка "const app = express();")
// виконується у vm з БД у пам'яті, звідти беруться справжні функції.
// Сервер запускати не потрібно. Запуск: npm run test:unit
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const SERVER = path.join(__dirname, 'server.js');
const source = fs.readFileSync(SERVER, 'utf8');
const code = source.slice(0, source.indexOf('const app = express();'));
const sandbox = {
    require: createRequire(SERVER),
    process: { env: { ...process.env, JWT_SECRET: 'test-secret', DB_FILE: ':memory:' } },
    console,
    __dirname
};
vm.createContext(sandbox);
const S = vm.runInContext(
    code + ';({ parseId, validDate, checkUser, checkOrder, checkProduct, makeToken, publicUser, auth, adminOnly, db, JWT_SECRET })',
    sandbox,
    { filename: SERVER }
);
const jwt = createRequire(SERVER)('jsonwebtoken');

// Журнал: виводиться в термінал і зберігається у файл unit-log.txt
const LOG_FILE = 'unit-log.txt';
fs.writeFileSync(LOG_FILE, '');
function log(line) {
    console.log(line);
    fs.appendFileSync(LOG_FILE, line + '\n');
}
// тест із заголовком у журналі
function it(name, fn) {
    test(name, () => {
        log('\n' + name);
        fn();
    });
}
// показує успішний результат виклику
function ok_(call, value) {
    const text = JSON.stringify(value, (k, v) => (k === 'password' ? '***' : v));
    log('  ' + call + ' → OK: ' + text);
    return value;
}
// виконує виклик, друкує статус-код і текст помилки, повертає статус
function status(fn, label) {
    const call = label || fn.toString().replace(/^\(\)\s*=>\s*/, '').replace(/\s+/g, ' ');
    try {
        fn();
    } catch (e) {
        log('  ' + call + ' → ' + e.status + ': ' + e.message);
        return e.status;
    }
    log('  ' + call + ' → OK (помилки немає)');
    return 'без помилки';
}
function daysFromNow(n) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

it('1. checkUser: коректні дані проходять, некоректні дають 400', () => {
    const ok = { name: '  Іван ', email: 'IVAN@Example.com', phone: '380671234567', password: 'secret123' };
    const u = ok_('S.checkUser(ok)', S.checkUser(ok));
    assert.equal(u.name, 'Іван');
    assert.equal(u.email, 'ivan@example.com');

    assert.equal(status(() => S.checkUser({ ...ok, name: 'І' })), 400);
    assert.equal(status(() => S.checkUser({ ...ok, email: 'ivan@' })), 400);
    assert.equal(status(() => S.checkUser({ ...ok, phone: '12345' })), 400);
    assert.equal(status(() => S.checkUser({ ...ok, password: '12345' })), 400);
});

it('2. checkOrder: кількість 1–100, адреса, дата не в минулому', () => {
    const ok = { product_id: 1, quantity: 2, address: 'Київ, вул. Хрещатик, 1', delivery_date: daysFromNow(3) };
    const o = ok_('S.checkOrder(ok)', S.checkOrder(ok, false));
    assert.equal(o.unit_price, 40); // ціна береться з БД (Фермерське молоко)

    assert.equal(S.checkOrder({ ...ok, quantity: 100 }, false).quantity, 100); // межа
    assert.equal(status(() => S.checkOrder({ ...ok, quantity: 0 }, false)), 400);
    assert.equal(status(() => S.checkOrder({ ...ok, quantity: 101 }, false)), 400);
    assert.equal(status(() => S.checkOrder({ ...ok, address: 'коротка' }, false)), 400);
    assert.equal(status(() => S.checkOrder({ ...ok, delivery_date: daysFromNow(-1) }, false)), 400);
    assert.equal(status(() => S.checkOrder({ ...ok, product_id: 999999 }, false)), 400);
});

it('3. checkProduct: ціна > 0, категорія існує, шлях до фото img/...', () => {
    const ok = { name: 'Козяче молоко', price: 60, category_id: 1, image: 'img/goat.jpg' };
    assert.equal(ok_('S.checkProduct(ok)', S.checkProduct(ok)).price, 60);
    assert.equal(S.checkProduct({ name: 'Без фото', price: 5, category_id: 1 }).unit, 'шт'); // значення за замовчуванням

    assert.equal(status(() => S.checkProduct({ ...ok, price: 0 })), 400);
    assert.equal(status(() => S.checkProduct({ ...ok, category_id: 999 })), 400);
    assert.equal(status(() => S.checkProduct({ ...ok, image: 'http://evil.com/a.jpg' })), 400);
});

it('4. parseId та validDate', () => {
    assert.equal(ok_("S.parseId('5')", S.parseId('5')), 5);
    for (const bad of ['0', '-1', 'abc', '1.5']) {
        assert.equal(status(() => S.parseId(bad), 'S.parseId(' + JSON.stringify(bad) + ')'), 400);
    }
    assert.equal(S.validDate('2028-02-29'), true);  // високосний рік
    assert.equal(S.validDate('2027-02-29'), false);
    assert.equal(S.validDate('2030-13-01'), false);
    assert.equal(S.validDate('10.12.2030'), false);
});

it('5. makeToken та publicUser: токен JWT на 2 години, пароль не віддається', () => {
    const payload = ok_('JWT makeToken({ id: 7, role: admin })', jwt.verify(S.makeToken({ id: 7, role: 'admin' }), S.JWT_SECRET));
    assert.equal(payload.sub, 7);
    assert.equal(payload.role, 'admin');
    assert.equal(payload.exp - payload.iat, 7200);
    assert.throws(() => jwt.verify(S.makeToken({ id: 7, role: 'user' }), 'чужий-ключ'));

    const u = S.publicUser({ id: 1, name: 'А', email: 'a@b.c', phone: '1234567890', role: 'user', password_hash: 'XXX' });
    ok_('S.publicUser(...)', u);
    assert.equal('password_hash' in u, false);
});

it('6. auth та adminOnly: перевірка токена і ролі', () => {
    const info = S.db
        .prepare('INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, ?, ?)')
        .run('Тест', 'unit@example.com', '380671234567', 'hash');
    const id = Number(info.lastInsertRowid);
    const run = (header, note) => {
        const req = { headers: header ? { authorization: header } : {} };
        let arg = 'next не викликано';
        S.auth(req, {}, (e) => { arg = e; });
        log('  auth(' + (note || 'без заголовка') + ') → ' +
            (arg && arg.status ? arg.status + ': ' + arg.message : 'OK, req.user = ' + JSON.stringify(req.user)));
        return { req, arg };
    };

    assert.equal(run().arg.status, 401);                                 
    assert.equal(run('Bearer abc.def.ghi', 'сміттєвий токен').arg.status, 401);              
    assert.equal(run('Bearer ' + S.makeToken({ id: 99999, role: 'user' }), 'токен неіснуючого користувача').arg.status, 401); 

    const good = run('Bearer ' + S.makeToken({ id, role: 'user' }), 'дійсний токен');
    assert.equal(good.arg, undefined);                                     // next() без помилки
    assert.equal(good.req.user.email, 'unit@example.com');

    let denied;
    S.adminOnly({ user: { role: 'user' } }, {}, (e) => { denied = e; });
    log('  adminOnly(role=user) → ' + denied.status + ': ' + denied.message);
    assert.equal(denied.status, 403);                                      // звичайний користувач — 403
    let allowed = 'next не викликано';
    S.adminOnly({ user: { role: 'admin' } }, {}, (e) => { allowed = e; });
    log('  adminOnly(role=admin) → OK (next() без помилки)');
    assert.equal(allowed, undefined);                                      // адмін проходить
});

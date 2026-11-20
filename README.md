# Green Farm — практикум №2

Фермерський магазин: клієнтська частина (практикум №1) переведена зі статичних даних
на динамічні запити до власного REST API, плюс серверна частина на Node.js з SQLite.

---

## 1. Що зроблено

### Клієнтська частина

| Сторінка | Було (статично) | Стало (через fetch) |
|---|---|---|
| `index.html` | три картки-переваги | додано блок «Хіти продажів»: перші 3 товари з `GET /api/products` |
| `catalog.html` | список товарів у розмітці | увесь каталог будується з `GET /api/products` |
| `cheese.html` | ціна «180 грн» вписана в HTML | ціна й опис беруться з бази (`GET /api/products`, пошук за назвою) |
| `order.html` | форма без даних | `GET /api/me` + `GET /api/products` заповнюють поля й список товарів; замовлення йде через `POST /api/orders` |
| `cabinet.html` | відсутня | `GET /api/me` (профіль) і `GET /api/orders` (замовлення), видалення через `DELETE /api/orders/:id` |
| `register.html` | форма нікуди не відправлялась | `POST /api/register` та `POST /api/login`, токен у `localStorage` |

На кожній сторінці є три стани: **завантаження** («Завантаження…»), **помилка** (текст від сервера
або «Немає зв'язку з сервером» + кнопка «Спробувати ще раз») і **порожній результат**
(«У вас ще немає замовлень», «У каталозі поки немає товарів»). Кнопки блокуються на час запиту,
тексти з бази вставляються через `esc()` (захист від XSS), при відповіді `401` токен видаляється
і користувача перекидає на вхід.

`app.js` віддається сервером за маршрутом `/app.js` і містить лише допоміжні функції:
`getToken()`, `setToken()`, `show()`, `esc()`, `today()`, `logout()`. Запити до API —
у скриптах сторінок.

### Серверна частина

* **Node.js + Express**, база даних **SQLite** (вбудований модуль `node:sqlite`);
* **REST API** з повним CRUD для товарів і замовлень;
* **JWT** (HS256, 2 години), паролі лише у вигляді хешу **bcrypt**;
* валідація на сервері з повідомленнями про помилки, коди відповідей 200, 201, 204, 400, 401, 403, 404, 409, 500.

---

## 2. Запуск

Потрібен **Node.js 22.13 або новіший**.

```bash
npm install
npm start
```

Далі відкрити <http://localhost:3000>.

База `database.db` створюється автоматично в папці проєкту, 5 категорій і 6 товарів додаються
при першому запуску. Щоб почати з нуля — видаліть файл `database.db`.

| Змінна | Навіщо |
|---|---|
| `JWT_SECRET` | стабільний ключ підпису токенів (інакше при кожному старті генерується випадковий) |
| `ADMIN_EMAIL` | email користувача, який при реєстрації отримує роль адміністратора (керування товарами) |
| `PORT` | порт сервера (за замовчуванням 3000) |
| `DB_FILE` | шлях до файлу бази (за замовчуванням `database.db`) |

---

## 3. База даних

Чотири пов'язані таблиці, 3НФ.

```
categories 1 ──< products 1 ──< orders >── 1 users
```

| Таблиця | Ключі |
|---|---|
| `users` (`id`, `name`, `email`, `phone`, `password_hash`, `role`, `created_at`) | PK `id`, UNIQUE `email` |
| `categories` (`category_id`, `name`) | PK `category_id`, UNIQUE `name` |
| `products` (`product_id`, `category_id`, `name`, `description`, `price`, `unit`, `image`) | PK `product_id`, FK `category_id` |
| `orders` (`id`, `user_id`, `product_id`, `quantity`, `unit_price`, `address`, `delivery_date`, `comment`, `status`, `created_at`) | PK `id`, FK `user_id` (CASCADE), FK `product_id` |

Відхилення від 3НФ: `orders.unit_price` зберігає ціну на момент замовлення, щоб зміна ціни товару
не змінювала суму старих замовлень.

---

## 4. API

| Метод | URL | Опис | Доступ |
|---|---|---|---|
| POST | `/api/register` | реєстрація, повертає токен | усі |
| POST | `/api/login` | вхід, повертає токен | усі |
| GET | `/api/me` | профіль | токен |
| GET | `/api/categories` | категорії | усі |
| GET | `/api/products` | товари (`?category=id`) | усі |
| GET | `/api/products/:id` | один товар | усі |
| POST | `/api/products` | створити товар | admin |
| PUT | `/api/products/:id` | оновити товар | admin |
| DELETE | `/api/products/:id` | видалити товар | admin |
| GET | `/api/orders` | мої замовлення (admin — усі) | токен |
| GET | `/api/orders/:id` | одне замовлення | власник, admin |
| POST | `/api/orders` | створити замовлення | токен |
| PUT | `/api/orders/:id` | оновити замовлення (admin — також статус) | власник, admin |
| DELETE | `/api/orders/:id` | видалити замовлення | власник, admin |

Токен передається в заголовку `Authorization: Bearer <token>`.

Приклад помилки сервера, яку показує клієнт:

```json
{ "error": "Адреса: мінімум 10 символів" }
```

### Тестування

Колекція Postman: `postman/green-farm.postman_collection.json` (Import → запускати запити по порядку;
токени зберігаються автоматично). Для запитів адміністратора зареєструйте користувача з email
із `ADMIN_EMAIL`.

---

## 5. Структура

```
green-farm/
├── server.js          # Express + node:sqlite + JWT, віддає сторінки та /app.js
├── package.json       # express, bcryptjs, jsonwebtoken
├── index.html         # головна (+ товари з API)
├── catalog.html       # каталог з API
├── cheese.html        # сторінка сиру (ціна з API)
├── order.html         # форма замовлення
├── cabinet.html       # кабінет + вихід
├── register.html      # реєстрація і вхід
├── about.html         # статична сторінка
├── css/style.css
├── img/*.jpg
└── postman/green-farm.postman_collection.json
```

`app.js` не лежить окремим файлом: сервер віддає його за маршрутом `/app.js`
(рядок `CLIENT_JS` у `server.js`).

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  charge_id TEXT
);

CREATE TABLE receipt_queue (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id),
  sent_at TIMESTAMP
);

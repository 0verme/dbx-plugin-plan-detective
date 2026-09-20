-- PostgreSQL fixture seed for Phase 1 preparation.
--
-- Throwaway test schema only. No production data, no credentials, no business
-- identifiers. The plans committed next to this file were captured from a local
-- PostgreSQL instance seeded by this script (see README.md "Fixture provenance").
--
-- Run with:
--   psql -h <host> -U <user> -d <test-db> -v ON_ERROR_STOP=1 -f setup.sql
-- then re-capture the plans listed in README.md.

DROP TABLE IF EXISTS pd_fix_orders;
DROP TABLE IF EXISTS pd_fix_customers;

CREATE TABLE pd_fix_customers (
  id   integer PRIMARY KEY,
  name text    NOT NULL,
  city text    NOT NULL
);

CREATE TABLE pd_fix_orders (
  id          integer       PRIMARY KEY,
  customer_id integer       NOT NULL,
  status      text          NOT NULL,
  total       numeric(10, 2) NOT NULL,
  created_at  timestamp     NOT NULL
);

INSERT INTO pd_fix_customers (id, name, city)
SELECT
  i,
  'customer_' || lpad(i::text, 3, '0') || CASE WHEN i % 7 = 0 THEN '_alpha' ELSE '_beta' END,
  CASE
    WHEN i % 10 < 6 THEN 'beijing'
    WHEN i % 10 < 9 THEN 'shanghai'
    ELSE 'guangzhou'
  END
FROM generate_series(1, 200) AS i;

INSERT INTO pd_fix_orders (id, customer_id, status, total, created_at)
SELECT
  i,
  (i % 200) + 1,
  CASE
    WHEN i % 50 = 0 THEN 'cancelled'
    WHEN i % 10 = 0 THEN 'pending'
    ELSE 'paid'
  END,
  round((i % 500) * 6.5 + 10, 2),
  timestamp '2026-01-01 00:00:00' + (i % 30) * interval '1 day' + i * interval '1 second'
FROM generate_series(1, 4000) AS i;

CREATE INDEX pd_fix_orders_customer_idx ON pd_fix_orders (customer_id);

ANALYZE pd_fix_customers;
ANALYZE pd_fix_orders;

-- ---------------------------------------------------------------------------
-- Larger table used by the offline-core fixture set (large scans, sorts,
-- bitmap / index-only scans, forced merge join, nested loop with a large
-- inner estimate).
-- 200,000 rows of synthetic data; no production values.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS pd_fix_events;

CREATE TABLE pd_fix_events (
  id          bigint        PRIMARY KEY,
  customer_id integer       NOT NULL,
  status      text          NOT NULL,
  total       numeric(12, 2) NOT NULL,
  occurred_at timestamp     NOT NULL
);

INSERT INTO pd_fix_events (id, customer_id, status, total, occurred_at)
SELECT
  i,
  (i % 200) + 1,
  CASE
    WHEN i % 100 < 90 THEN 'paid'
    WHEN i % 100 < 97 THEN 'pending'
    ELSE 'cancelled'
  END,
  round((i % 1000) * 3.25 + 5, 2),
  timestamp '2026-01-01 00:00:00' + (i % 90) * interval '1 day' + i * interval '1 second'
FROM generate_series(1, 200000) AS i;

CREATE INDEX pd_fix_events_customer_idx ON pd_fix_events (customer_id);

VACUUM (ANALYZE) pd_fix_events;

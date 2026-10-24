-- G6 I2 (C263): the alert DIGEST. One row per digest DM: the items it names are frozen at build time, and so is its
-- input, so a held or timed-out send repeats with the same input and idempotency key (like inbox_deliveries).
-- Not an inbox_deliveries row on purpose: withdrawing one item must never cancel the digest of the others.
-- Forward-only; 0001-0004 are never edited. (Renumbered from 0004 to 0005 before release: IN-2 took 0004.)
CREATE TABLE inbox_digests (
  id TEXT PRIMARY KEY,
  window_from INTEGER NOT NULL,
  window_to INTEGER NOT NULL,
  item_ids TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('buzz', 'channel')),
  op TEXT NOT NULL,
  input TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'held', 'failed')),
  hold_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX inbox_digests_due ON inbox_digests (status, next_at);
-- item_get finds the digest of an item among the windows that ended after the item was asked
CREATE INDEX inbox_digests_window ON inbox_digests (window_to);

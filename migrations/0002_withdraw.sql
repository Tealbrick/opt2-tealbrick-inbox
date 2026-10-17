-- inbox_withdraw (OD-1): the raiser may close its own open item. Forward-only; 0001 is never edited.
--
-- `from_product` is the VERIFIED product of an app that raised the item (ctx.caller.product, from the verified grant);
-- NULL for items raised by an agent and for EVERY row that exists before this migration (their product was never
-- recorded). A NULL product can never match an app caller, so such a row cannot be withdrawn by an app (fail closed);
-- an agent's rows keep working because `from_id` already holds the agent id.
ALTER TABLE inbox_items ADD COLUMN from_product TEXT;

-- A withdrawn item is closed as status 'expired' (the agent reads `expired`); these columns tell it from a timeout.
ALTER TABLE inbox_items ADD COLUMN withdrawn_at INTEGER;
ALTER TABLE inbox_items ADD COLUMN withdrawn_reason TEXT;

-- The owner-visible history of an item and the audit of inbox_withdraw: one row per effective withdraw, and one row per
-- refused attempt (throttled in src/store.ts). `item_id` has no foreign key: a refused attempt may name an id that does
-- not exist. The actor is the VERIFIED caller (type, instance id, product); `actor_name` is display text only.
CREATE TABLE inbox_activity (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('withdrawn', 'withdraw_refused')),
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_product TEXT,
  actor_name TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX inbox_activity_item ON inbox_activity (item_id, created_at, id);
CREATE INDEX inbox_activity_actor ON inbox_activity (actor_id, kind, created_at);

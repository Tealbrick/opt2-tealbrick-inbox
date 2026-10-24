-- IN-2 (C322(9), C331(3)): answer an approval from a Slack or Telegram DM button. Forward-only; 0001–0003 are never edited.
--
-- `family` is the hold family the asker declared (C284 D4 names, plus 'none' = no held family). NULL = not declared:
-- such an item never gets DM buttons (fail closed), and every row that exists before this migration is NULL.
ALTER TABLE inbox_items ADD COLUMN family TEXT CHECK (family IN ('destructive', 'money', 'first_contact', 'identity', 'public_link', 'none'));

-- One row per DM alert that carries buttons. The button values are signed (HMAC, key in the app secrets) over this row's
-- binding: item, item version, recipient (Connect account as given in the alert setting + the person id), expiry. The
-- row makes a token single-use (`used_at`, guarded UPDATE); the value itself is never stored.
CREATE TABLE inbox_dm_tokens (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inbox_items (id),
  item_version INTEGER NOT NULL,
  account TEXT NOT NULL,
  person TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX inbox_dm_tokens_item ON inbox_dm_tokens (item_id);

-- The token a channel alert carries (NULL: no buttons). A send that falls back to text only retires it.
ALTER TABLE inbox_deliveries ADD COLUMN token_id TEXT;

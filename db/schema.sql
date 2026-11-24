-- cf-tempmail D1 schema
CREATE TABLE IF NOT EXISTS mailboxes (
  address     TEXT PRIMARY KEY,            -- full address, lowercase
  epin_hash   TEXT,                        -- sha256 hex of PIN, NULL = no PIN
  created_at  INTEGER NOT NULL,            -- unix ms
  expires_at  INTEGER NOT NULL             -- unix ms
);

CREATE TABLE IF NOT EXISTS mails (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  address     TEXT NOT NULL,               -- recipient mailbox address, lowercase
  sender      TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL DEFAULT '',
  text_body   TEXT NOT NULL DEFAULT '',
  html_body   TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL             -- unix ms
);

CREATE INDEX IF NOT EXISTS idx_mails_address_id ON mails(address, id DESC);
CREATE INDEX IF NOT EXISTS idx_mailboxes_expires ON mailboxes(expires_at);

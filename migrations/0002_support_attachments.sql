-- Attachments for support tickets/messages. Files live in R2
-- (bucket matthew-peiper-support-uploads); this table holds metadata only.
CREATE TABLE IF NOT EXISTS support_attachments (
  id           TEXT PRIMARY KEY,
  ticket_id    TEXT NOT NULL,
  message_id   TEXT,
  r2_key       TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  uploaded_by  TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_attachments_ticket
  ON support_attachments (ticket_id);
CREATE INDEX IF NOT EXISTS idx_support_attachments_message
  ON support_attachments (message_id);

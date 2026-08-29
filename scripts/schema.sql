-- Matthew Peiper site — D1 schema
-- Contact submissions (same shape Command Center Forms reads)
CREATE TABLE IF NOT EXISTS "ec_contact_submissions" (
  "id" text primary key,
  "slug" text,
  "status" text default 'draft',
  "author_id" text,
  "primary_byline_id" text,
  "created_at" text default (datetime('now')),
  "updated_at" text default (datetime('now')),
  "published_at" text,
  "scheduled_at" text,
  "deleted_at" text,
  "version" integer default 1,
  "live_revision_id" text,
  "draft_revision_id" text,
  "locale" text default 'en' not null,
  "translation_group" text,
  "name" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "project" TEXT,
  "message" TEXT,
  is_spam INTEGER NOT NULL DEFAULT 0,
  spam_reason TEXT,
  constraint "ec_contact_submissions_slug_locale_unique" unique ("slug", "locale")
);

-- Support portal tables
CREATE TABLE IF NOT EXISTS support_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  page_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  staging_url TEXT NOT NULL DEFAULT '',
  approved_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created ON support_tickets(created_at);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id, created_at);

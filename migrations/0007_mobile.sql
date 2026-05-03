-- Migration 0007: factory-mobile auth + push + intake session schema. Additive (IF NOT EXISTS), safe to re-apply. Refs architect spec outputs/20260503_104148/architect_factory-mobile_20260503_104149.md D-9.
-- No v3/v4 table or column is dropped or renamed.
--
-- Additions:
--   mobile_device         — registered Expo push tokens + per-device push prefs
--   mobile_refresh_token  — opaque refresh-token store for JWT rotation
--   mobile_jwt_kid        — signing-key rotation history (KID → HS256 key)
--   mobile_push_log       — push delivery audit log per signal + device
--   intake_session        — index of brainstorm sessions keyed by session_id
--   mobile_allowlist      — (provider, sub) tuple allowlist for Apple/Google auth

-- ---------------------------------------------------------------------------
-- 1. mobile_device — one row per registered Expo device, upserted on push/register.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mobile_device (
  device_id     TEXT    PRIMARY KEY,
  expo_token    TEXT    NOT NULL UNIQUE,
  platform      TEXT    NOT NULL CHECK(platform IN ('ios','android')),
  sub_id        TEXT    NOT NULL,             -- Apple or Google sub claim
  auth_provider TEXT    NOT NULL CHECK(auth_provider IN ('apple','google')),
  push_prefs    TEXT    NOT NULL DEFAULT '{}', -- JSON: {pipeline_finished:bool, ...}
  registered_at INTEGER NOT NULL,             -- Unix epoch ms
  last_seen_at  INTEGER NOT NULL,             -- Unix epoch ms; updated on every auth
  active        INTEGER NOT NULL DEFAULT 1    -- 0 = soft-deleted on sign-out
);

CREATE INDEX IF NOT EXISTS idx_mobile_device_active
  ON mobile_device (active, last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- 2. mobile_refresh_token — single-use opaque refresh tokens, rotated on every use.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mobile_refresh_token (
  token_id    TEXT    PRIMARY KEY,
  device_id   TEXT    NOT NULL,               -- → mobile_device.device_id
  secret_hash TEXT    NOT NULL,               -- PBKDF2-SHA256 hash of the opaque token secret
  exp         INTEGER NOT NULL,               -- Unix epoch ms; 30-day window
  used        INTEGER NOT NULL DEFAULT 0      -- 1 once consumed; never reused
);

CREATE INDEX IF NOT EXISTS idx_mobile_refresh_exp
  ON mobile_refresh_token (exp);

-- ---------------------------------------------------------------------------
-- 3. mobile_jwt_kid — KID → signing-key rotation history for HS256 access tokens.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mobile_jwt_kid (
  kid         TEXT    PRIMARY KEY,
  signing_key TEXT    NOT NULL,               -- base64-encoded 32-byte key
  created_at  INTEGER NOT NULL,               -- Unix epoch ms
  retired_at  INTEGER                         -- null while active; set on rotation
);

-- ---------------------------------------------------------------------------
-- 4. mobile_push_log — push delivery audit log; one row per device per signal fire.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mobile_push_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,               -- Unix epoch ms
  signal      TEXT    NOT NULL,               -- pipeline_finished | blocker_active | new_p0_comm | intent_aged | brainstorm_silent
  device_id   TEXT    NOT NULL,               -- → mobile_device.device_id
  expo_status TEXT    NOT NULL,               -- ok | error | retry | dropped
  error_msg   TEXT                            -- null on success
);

CREATE INDEX IF NOT EXISTS idx_mobile_push_log_ts
  ON mobile_push_log (ts DESC);

-- ---------------------------------------------------------------------------
-- 5. intake_session — index of brainstorm sessions; D1 derived index only.
-- Authoritative source is ~/factory/sessions/active/<session_id>.md on disk.
-- session_id format: YYYYMMDDTHHMMSSZ (e.g. "20260503T144146Z").
-- Daemon ingester writes/updates rows; migration 0008 will drop brainstorm_session.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intake_session (
  session_id  TEXT    PRIMARY KEY,            -- YYYYMMDDTHHMMSSZ
  status      TEXT    NOT NULL CHECK(status IN ('active','archived')),
  started_at  INTEGER NOT NULL,               -- Unix epoch ms
  last_msg_at INTEGER NOT NULL,               -- Unix epoch ms
  msg_count   INTEGER NOT NULL DEFAULT 0,
  title       TEXT                            -- first user message, truncated
);

CREATE INDEX IF NOT EXISTS idx_intake_session_status
  ON intake_session (status, last_msg_at DESC);

-- ---------------------------------------------------------------------------
-- 6. mobile_allowlist — (provider, sub) tuple allowlist per D-5 critic note.
-- Prevents cross-provider sub collision; seeded at runtime by devops once
-- Sai's Apple and Google sub claims are known — NOT seeded here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mobile_allowlist (
  provider TEXT    NOT NULL CHECK(provider IN ('apple','google')),
  sub      TEXT    NOT NULL,
  label    TEXT,                              -- human-readable e.g. "Sai iPhone"
  added_at INTEGER NOT NULL,                 -- Unix epoch ms
  PRIMARY KEY (provider, sub)
);

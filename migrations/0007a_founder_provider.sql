-- Migration 0007a: widen mobile_device.auth_provider CHECK constraint to include 'founder'.
-- Additive (drop+recreate CHECK only). Refs architect spec ADR D-5 amendment.
--
-- Background: Migration 0007 created mobile_device with
--   CHECK(auth_provider IN ('apple','google'))
-- Founder-mode synthetic ctx sets provider='founder' — D1 rejects the insert/update.
-- This migration recreates the constraint to include 'founder'.
--
-- SQLite does not support ALTER TABLE DROP CONSTRAINT, so we:
--   1. Rename the existing table.
--   2. Create the new table with the widened constraint.
--   3. Copy all rows.
--   4. Drop the renamed table.
--
-- Safe to re-run: CREATE TABLE IF NOT EXISTS on the new table + DROP IF EXISTS on the old.
-- Note: D1 wraps each migration in its own implicit transaction; explicit
-- BEGIN/COMMIT are unsupported (error 7500) and have been removed.

-- Step 1: Rename existing table
ALTER TABLE mobile_device RENAME TO mobile_device_old;

-- Step 2: Recreate with widened CHECK (adds 'founder')
CREATE TABLE IF NOT EXISTS mobile_device (
  device_id     TEXT    PRIMARY KEY,
  expo_token    TEXT    NOT NULL UNIQUE,
  platform      TEXT    NOT NULL CHECK(platform IN ('ios','android')),
  sub_id        TEXT    NOT NULL,
  auth_provider TEXT    NOT NULL CHECK(auth_provider IN ('apple','google','founder')),
  push_prefs    TEXT    NOT NULL DEFAULT '{}',
  registered_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_mobile_device_active
  ON mobile_device (active, last_seen_at DESC);

-- Step 3: Copy existing rows
INSERT INTO mobile_device
  SELECT device_id, expo_token, platform, sub_id, auth_provider,
         push_prefs, registered_at, last_seen_at, active
  FROM mobile_device_old;

-- Step 4: Drop old table
DROP TABLE mobile_device_old;

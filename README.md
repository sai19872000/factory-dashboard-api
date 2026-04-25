# factory-dashboard-api

Cloudflare Worker API for the Sai Ram Labs factory dashboard.

**Routes**:
- `POST /ingest` — bearer-auth'd; daemon pushes factory snapshots here
- `GET /snapshot` — CF Access JWT-gated; SPA reads current snapshot
- `GET /healthz` — public; liveness check for monitoring

## Deploy

```bash
# 1. Install dependencies
npm install

# 2. Create KV namespace (production + preview)
wrangler kv:namespace create FACTORY_DASHBOARD
wrangler kv:namespace create FACTORY_DASHBOARD --preview

# Update wrangler.toml with the returned IDs

# 3. Set secrets
wrangler secret put INGEST_TOKEN           # 32-byte URL-safe token
wrangler secret put CF_ACCESS_AUD_SNAPSHOT # from CF Access app config
wrangler secret put CF_ACCESS_TEAM_DOMAIN  # e.g. yourteam.cloudflareaccess.com

# 4. Deploy
wrangler deploy
```

## CF Access AUD discovery

In the Cloudflare Zero Trust dashboard → Access → Applications → Factory Dashboard → Edit → copy the **Application Audience (AUD) Tag**.

## Secret generation

```bash
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
```

## Local dev

```bash
# Copy .dev.vars.example to .dev.vars and fill in values
wrangler dev
```

## Run tests

```bash
npm test
```

## KV keys

| Key | TTL | Contents |
|-----|-----|----------|
| `factory:snapshot:current` | 600 s | Latest `SnapshotV1` JSON |
| `factory:snapshot:meta` | none | `{ last_push_at, daemon_id, push_count }` |

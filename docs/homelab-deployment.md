# Homelab deployment

The production working copy lives at:

```text
/mnt/storage/apps/mkd-price-aggregator
```

Connect with `ssh homelab`. The application runs as its own Docker Compose project,
with separate web, worker, PostgreSQL, and Cloudflare Tunnel containers. Migrations
run as a short-lived container before web/worker startup. Its volumes and tunnel
are separate from the other applications on this host.

Public address: [https://prices.gocheski.com](https://prices.gocheski.com).

## Resources and access

| Service | Memory cap | CPU cap |
| --- | --- | --- |
| PostgreSQL | 6 GB | 4 |
| Worker | 3 GB | 4 |
| Web | 1.5 GB | 2 |
| Migrations | 1 GB | 2 |
| Cloudflare connector | 128 MB | 0.5 |

These are maximum allowances, not memory reservations. PostgreSQL has 1.5 GB shared
buffers, 16 MB work memory, and 128 maximum connections. Import concurrency remains
controlled separately through Tasks; a larger container does not authorize work.

Web binds only to `127.0.0.1:3010` and PostgreSQL to `127.0.0.1:55433` on the host.
The Cloudflare connector reaches `http://web:3000` on the private Compose network.
The allowed login/write origin is `https://prices.gocheski.com`, configured through
`NEXTSIGNAL_AUTH__ALLOWED_ORIGINS`.
Secure and HTTP-only session cookies are enabled.

The dedicated tunnel is named `mkd-price-aggregator`. Its locally managed ingress
configuration is `.data/cloudflared/config.yml`; its private credentials are
`.data/cloudflared/credentials.json`. These files are excluded from Git, Docker
builds, and source sync. The host's existing Cloudflare service is unchanged.

## Credentials

Fresh database credentials, administrator password, and session secret are stored
only on the homelab in `.env.production.local`, with permissions `0600`. The login
username is `admin`. To show the generated password in your own SSH terminal:

```sh
cd /mnt/storage/apps/mkd-price-aggregator
sed -n 's/^NEXTSIGNAL_AUTH__PASSWORD=//p' .env.production.local
```

No development secrets or AI Gateway key were copied. Configure a Gateway key
privately on the server before deliberately permitting AI through Tasks.

## Start, stop, and inspect

Run these commands from the deployment directory:

```sh
docker compose --env-file .env.production.local -f compose.yaml -f compose.cloudflare.yaml up -d --wait
docker compose --env-file .env.production.local -f compose.yaml -f compose.cloudflare.yaml ps
docker compose --env-file .env.production.local -f compose.yaml -f compose.cloudflare.yaml logs --tail 100 worker
docker compose --env-file .env.production.local -f compose.yaml -f compose.cloudflare.yaml logs --tail 100 cloudflared
docker compose --env-file .env.production.local -f compose.yaml -f compose.cloudflare.yaml stop
```

Stopping preserves the database and saved settings. Do not use `down -v` for a
normal stop; that removes the project's persistent volumes.

For a code update, copy the current source changes, then:

```sh
docker compose --env-file .env.production.local -f compose.yaml -f compose.cloudflare.yaml build
docker compose --env-file .env.production.local -f compose.yaml -f compose.cloudflare.yaml up -d --wait
```

Keep `.env.production.local`, `.data/`, and Docker volumes out of source transfers.
Never replace server secrets with the development environment.

## Initial verification

This deployment started with a new PostgreSQL volume. All 29 migrations applied.
Health, login, protected dashboard reads, worker heartbeat, and secure-cookie checks
passed. Catalogs, listings, prices, store products, tasks, and AI requests were all
zero after startup. Only application metadata and operational logs were initialized.

The DNS record for `prices.gocheski.com` points to the dedicated tunnel. Public
HTTPS health, login, protected dashboard reads, allowed-origin handling, and
rejection of writes from another origin were verified through that hostname.
All four persistent containers are healthy. No import or model request was started
by these checks.

Imports, categorization, and matching start in **Manual only** mode. AI and Qwen
clarification are off, and no stores are selected for scheduled imports. Starting
or restarting the worker does not start an import, matching campaign, or AI call.

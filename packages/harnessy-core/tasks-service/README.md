# Hosted task store

This service is the always-on primary copy of the Harnessy task store. The
Mac keeps `~/.harnessy/portal/tasks.json` as a cache and uses
`harnessy jarvis tasks sync` to exchange changes.

The document `revision` field is the optimistic-concurrency token. It is
separate from the schema `version` field, which stays at 1. A write with a
stale revision receives HTTP 409.

## Auth

All routes except `GET /health` and `GET /v1/health` require a bearer token.
Store the token in a file with mode 0600. Do not put the token in this
repository. The Mac reads `~/.config/harnessy/tasks-sync.token`. The sync
config at `~/.config/harnessy/tasks-sync.json` holds the endpoint URL and
the token file path only.

## Deploy

Build the image for `linux/amd64` (the VPS architecture) from the repository root, load it on the VPS, and start this
compose file in a new directory such as `/opt/harnessy-tasks`. The compose
file attaches the container to the existing Coolify `coolify` network with
Traefik labels. It does not change the Coolify proxy or existing apps.

Copy `docker-compose.yml` and a `tasks.token` file (mode 0600) into that
directory. Before the first start, create the data directory so Docker does
not create a root-owned mount that the non-root service (uid/gid 1003) cannot
write:

```sh
sudo install -d -m 0700 -o 1003 -g 1003 ./data
```

Then start the compose project. The token is mounted into the container and is
not set as an environment variable. Keep the service non-root.

Default URL: `https://tasks.187-77-170-118.sslip.io`

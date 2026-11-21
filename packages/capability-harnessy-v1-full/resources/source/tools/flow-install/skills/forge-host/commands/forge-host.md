---
description: Self-hosted Git forge with CI runners, installed and tracked by harness-forge
argument-hint: "inspect|plan|install|service-account|token|runner add|repo migrate|repo mirror|backup|list|status"
---

# Forge Host Command

Use the installed `harness-forge` command as the deterministic execution surface.

## Order of work for a new forge

```bash
harness-forge inspect --host <server> --ssh-user <user> --ssh-key <key file>
harness-forge install --id <id> --host <server> --ssh-user <user> --ssh-key <key file> --admin-user <name> --dry-run
harness-forge install --id <id> --host <server> --ssh-user <user> --ssh-key <key file> --admin-user <name> --confirm <id>
harness-forge runner add --id <id> --name vps-1 --where remote --confirm <id>
harness-forge repo migrate --id <id> --source https://github.com/<owner>/<repo> --owner <org> --name <repo>
harness-forge backup --id <id> --schedule --confirm <id>
harness-forge list --live
```

## Commands

### `harness-forge inspect`

Reads the server and changes nothing. It reports the system, CPU type, free
memory, free disk, Docker, Docker Compose and the reverse proxy. Exit 1 when a
requirement is not met: at least 2,048 MB of available memory, at least 20 GB
of free disk, and a supported proxy that gets HTTPS certificates.

### `harness-forge plan`

Shows what `install` would do. It uses no SSH, so the proxy values are not
known yet.

### `harness-forge install`

1. Runs `inspect` and refuses when a requirement is not met.
2. Refuses when the register has the id, or when `/opt/forge-<id>` exists on
   the server and the register does not know it.
3. Writes `/opt/forge-<id>/docker-compose.yml` and starts the forge. The forge
   opens no port. The proxy routes `https://<domain>` to it and gets the
   certificate.
4. Creates the first admin with a random password that must be changed at the
   first sign-in. The password is in `admin-initial-password.txt` in the secret
   folder.
5. Creates the service account `harness-forge` for the tool's own API calls.
6. Waits until the web address answers over HTTPS with a trusted certificate.
7. Writes the register entry and the evidence folder.

`--domain auto` (the default) gives `git.<server-ip-with-dashes>.sslip.io`. It
needs no DNS record. Use a real domain when one exists; the address is part of
each clone address and each image name.

Settings of the forge: registration closed, sign-in required to see anything,
SSH off (Git over HTTPS), SQLite, Actions on, packages on.

`--dry-run` stops after the plan. `--confirm <id>` is required for a change.

### `harness-forge service-account`

Makes the service account if it is missing, and gives it a new token. Use it to
renew the token.

### `harness-forge token`

Makes an API token for a forge user and saves it in the secret folder. The
token is never printed.

### `harness-forge runner add`

Registers a runner on the forge and starts it as a container:

- `--where remote`: on the server, in `/opt/forge-<id>/runner-<name>`.
- `--where local`: on this machine, in
  `${XDG_DATA_HOME:-~/.local/share}/harnessy/forge-runners/<id>-<name>`.

The default label is `ubuntu-24.04` with an Ubuntu job image, so a workflow
with `runs-on: ubuntu-24.04` needs no change. Add labels with `--label`. A
machine that is not x86_64 may not take the label `amd64`.

A local runner needs only Python and Docker with Linux containers (Docker
Desktop on macOS and Windows, Docker Engine on Linux). It was run for real on
macOS (ARM). Linux and Windows have unit coverage only.

`--env NAME=value` (repeatable) gives each job on that runner a value that
belongs to the machine. Do not use it for secrets. Known case: on an Apple M4
with Docker Desktop engine 27.5.1, an ARM container that loads OpenSSL (for
example the Python package `cryptography`) stops with "Illegal instruction".
`--env OPENSSL_armcap=0x3D` avoids it; a newer Docker Desktop is the real fix.
The value reaches the job only, not the containers that the job starts, so
keep jobs that start application images on an x86 runner (label `amd64`).

A runner is a long-lived machine. A job that starts containers by name must
remove them before and after, or the next run fails with a name conflict.

The runner gives each job the Docker socket of its machine. Tests that start
containers need this. It also means that a job can control Docker on that
machine: add a runner only for trusted repositories.

### `harness-forge repo migrate`

Moves a repository from another forge with its branches, tags, pull requests,
issues, labels and releases. The token of the source forge comes from
`FORGE_SOURCE_TOKEN` or from a hidden prompt. The register gets the commit of
each branch at the move.

### `harness-forge repo mirror`

Makes the forge push each change to another forge. Use it for a backup mirror.

### `harness-forge backup`

Without `--schedule`: makes one dump now in `/opt/forge-<id>/backups` and keeps
the newest `--keep` files (default 14). With `--schedule`: adds a nightly job
on the server.

Restoring a dump over live data is out of scope. To test a dump, restore it
into a separate container.

### `harness-forge list` and `harness-forge status`

`list` shows each install in the register. `--live` asks each forge if it
answers. `status --id <id>` shows one install with its runners, repositories,
backups, secret file names and evidence runs.

## Limits of version 0.1.0

- One proxy adapter: Traefik with the Docker provider. A server with another
  proxy, or with none, is refused by `inspect`.
- No upgrade command and no uninstall command.
- The register is local to one workspace. It is not shared between machines.

# VPS production deployment

Production runs on one x86-64 Linux VPS, from any provider, as the Docker
Compose project in this directory. Cloudflare Tunnel is the only public ingress:
the host accepts no inbound connections except key-only SSH, and PostgreSQL is
never reachable from the internet. On every push to `main`, GitHub Actions runs
the full CI, builds and smoke-tests the image, publishes it to GitHub Container
Registry (GHCR) tagged with the commit SHA, and sends that SHA and the image's
digest to `bin/release` on the server over SSH. The server runs the image by
digest, checks that the release serves, and restores the previous release when
it does not. Nightly encrypted backups go to S3-compatible storage with restic,
and a weekly check restores the latest one. The backup, that check and a check
of the host and services every 5 minutes each report to a dead man's switch,
which alerts when a run fails or does not report at all. There is one
environment; local development and CI are the checks before production.

| Path                                                                                                                   | Purpose                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`compose.yml`](compose.yml)                                                                                           | Production services: PostgreSQL, migrate, API, worker, `cloudflared`                                                  |
| [`bin/`](bin/)                                                                                                         | `compose`, `release`, `backup`, `verify-backup` and `monitor` scripts, and `heartbeat.sh`, which the last three share |
| [`systemd/`](systemd/)                                                                                                 | Services and timers: the nightly backup, the weekly backup check, and the monitor every 5 minutes                     |
| [`env.example`](env.example), [`restic.env.example`](restic.env.example), [`monitor.env.example`](monitor.env.example) | Templates for the server's secrets files                                                                              |

The image carries this directory as `/app/deploy/vps`. Each release installs
`compose.yml` and `bin/` on the server from the image it releases.

## What runs

| Service       | Image                                               | Reachable from                         | Data                   |
| ------------- | --------------------------------------------------- | -------------------------------------- | ---------------------- |
| `cloudflared` | `cloudflare/cloudflared`, pinned by digest          | Outbound only                          | None                   |
| `api`         | `<APP_IMAGE_REPOSITORY>:<sha>@<digest>`             | `cloudflared`                          | None                   |
| `worker`      | Same image, `node apps/worker/src/main.ts`          | Nothing inbound                        | None                   |
| `migrate`     | Same image, `node packages/database/src/migrate.ts` | Nothing inbound; runs once per release | None                   |
| `postgresql`  | `postgres` Alpine image, pinned by digest           | Docker network; host `127.0.0.1:5432`  | `postgres_data` volume |

Every service has a read-only root filesystem, drops all Linux capabilities and
sets `no-new-privileges`. `api`, `worker` and `migrate` write only to a 16 MB
`/tmp` and run at most 128 processes and threads. `postgresql` starts as the
image's `postgres` user (uid 70) and writes only to its volume,
`/var/run/postgresql` and `/tmp`. Keep `postgres_data` a named volume: Docker
creates it owned by that user, while a bind-mounted host directory would have to
be given to uid 70 first. `cloudflared` runs as its image's non-root user and
writes nothing.

`compose.yml` differs from the local `docker-compose.yml`:

- It pulls images from GHCR and never builds on the host. The app image is
  pinned by digest; until the first release, its tag and digest are placeholders
  that fail if started.
- `migrate` runs only when `bin/release` invokes it, under the `release`
  profile.
- Every long-running service (`postgresql`, `api`, `worker`, `cloudflared`)
  restarts unless stopped and has a memory ceiling. The worker exits on any
  failure and relies on that restart policy. Every service, `migrate` included,
  rotates its logs with Docker's `local` driver.
- It adds `cloudflared`, whose healthcheck passes only while the tunnel is
  connected to Cloudflare (see step 5).

On the server the files are laid out as:

```text
/opt/uncross/   owned by deploy
  compose.yml                deploy/vps/compose.yml from the current release's image
  bin/compose                Docker Compose with .env and release.env loaded
  bin/release                release script
  bin/backup                 nightly backup
  bin/verify-backup          weekly backup check
  bin/monitor                check of the host and services every 5 minutes
  bin/heartbeat.sh           reports how those three ended, sourced by each
  .env                       secrets, from env.example, mode 0600
  release.env                APP_IMAGE_TAG and APP_IMAGE_DIGEST of the current release, written by bin/release
  release.lock               held by bin/release while it runs, and by bin/monitor during a check
  releases.log               one line per release attempt: time, commit, image digest, outcome
  release-output.log         everything the latest release attempt printed
  .previous/                 compose.yml, bin/ and release.env of the release before, for rollback
/etc/uncross/     owned by root, mode 0700
  restic.env                 backup credentials and two heartbeat URLs, mode 0600
  monitor.env                the monitor's heartbeat URL and thresholds, mode 0600
/etc/systemd/system/uncross-*   the units from systemd/
/var/backups/uncross/database.dump   the latest dump, which restic uploads
/var/cache/uncross-restic/           restic's cache
/var/lib/uncross-monitor/restarts    each container's restart count at the last check
```

`bin/` holds exactly the scripts of the current release's image, like
`compose.yml`.

### Database roles

`api` and `worker` connect as the runtime role, `APP_DATABASE_USER`
(`uncross_app` by default). It can log in and read, insert, update and delete
rows in the tables of the `public` schema, and use their sequences. It is not a
superuser and belongs to no other role, so it cannot create, alter, drop or
truncate those tables, create schemas or roles, read the migration journal in
the `drizzle` schema, read or write server files, or run programs on the server
with `COPY ... TO PROGRAM`. SQL injection in the API is therefore limited to the
application's rows rather than the schema or a shell next to the data volume.

It keeps what PostgreSQL grants every role: it can connect to the cluster's
other databases without creating anything there, create temporary tables and
functions for the length of its session, create large objects, call functions
open to everyone, and change its own password and session defaults. Every
release's `migrate` sets the password again and clears those defaults.

`migrate` and `bin/backup` use the owner, `POSTGRES_USER`, which the PostgreSQL
image makes a superuser. After applying the migrations, every `migrate` run
creates the runtime role or updates it, sets its password from
`APP_DATABASE_PASSWORD`, clears settings stored for it, and grants it those
privileges on every table in `public`, including those the owner creates later.
`migrate` sends PostgreSQL only a salted SCRAM-SHA-256 hash of the password,
never the password itself. A table in a schema other than `public` needs its own
grants, in the migration that creates it.

`APP_DATABASE_USER` is lowercase letters, digits and `_`, does not start with a
digit, has at most 63 characters, and is not `public`, `none` or a name starting
with `pg_`. Before it applies any migration, `migrate` fails, and the release
with it, when the name is the owner or an existing role that is a superuser,
belongs to another role, or owns database objects: such a role is someone
else's. To change the name after a release, see
[Day-to-day operations](#day-to-day-operations).

## Setup

The commands assume Ubuntu 24.04 LTS or Debian 13, run as root on the server
unless they show `ssh` or `scp` from the repository root on your machine.

### 1. Prerequisites

- A domain whose DNS zone is on Cloudflare (the Free plan is enough).
- Two-factor authentication on the VPS provider, Cloudflare, registrar, and
  GitHub accounts.
- An Ed25519 SSH key for each operator, plus a separate one used only by GitHub
  Actions for releases.
- A password manager vault for production. It holds the master copy of every
  secret created below.
- An S3-compatible bucket for backups, with a different provider than the
  server.

### 2. Server and provider firewall

A VPS with 2 vCPUs and 4 GB of RAM is plenty to start. Take a provider snapshot
before risky host maintenance.

Choose an x86-64 (amd64) plan, not an Arm one such as Hetzner CAX, Oracle Ampere
or AWS Graviton: the Release workflow builds `linux/amd64` only, and on an arm64
host `bin/release` stops at the pull with no matching image. An arm64 image
would have to run the image build's `pnpm check` under emulation on every
release, and CI smoke-tests only amd64. To run on Arm, build on an arm64 runner
and smoke-test that image too.

If the provider has a network firewall, allow only inbound TCP 22 (IPv4 and
IPv6). It filters traffic before it reaches the host, which also covers ports
Docker publishes: Docker's own rules bypass `ufw`. The tunnel connects outbound,
so the application needs no inbound rule.

### 3. Host baseline

```bash
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y full-upgrade
apt-get -y install ufw restic unattended-upgrades curl
dpkg-reconfigure -f noninteractive unattended-upgrades

# Release account. Its only SSH key is the CI deploy key from step 7.
adduser --disabled-password --gecos "" deploy

# Keys only. This file sorts before cloud-init's 50-cloud-init.conf, so its
# values take precedence.
cat > /etc/ssh/sshd_config.d/10-hardening.conf <<'EOF'
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sshd -t && systemctl reload ssh

# Host firewall as a second layer.
ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw --force enable

# 2 GB of swap as a buffer against memory spikes.
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Before closing the session that changed SSH, confirm from a second terminal that
a key login works and a password login is refused. Reboot if
`/var/run/reboot-required` exists.

### 4. Docker

Install Docker Engine and the Compose plugin from
[Docker's apt repository](https://docs.docker.com/engine/install/), not the
distribution's `docker.io` package. Then:

```bash
docker compose version
usermod -aG docker deploy
```

Membership in the `docker` group is equivalent to root: anyone who can run
commands as `deploy` controls the host. Only `deploy` gets it, and its only SSH
key runs `bin/release` with nothing but a commit SHA and an image digest (step
7). `compose.yml` rotates each service's logs itself, so
`/etc/docker/daemon.json` needs no changes. It publishes only PostgreSQL, on
loopback; keep it that way, because published ports bypass `ufw`.

### 5. Cloudflare Tunnel and DNS

1. In Cloudflare Zero Trust, create a remotely managed tunnel, for example
   `uncross-production`, and copy the token from its install command into the
   vault. Do not run the install command: the `cloudflared` service is the
   connector.
2. Add a public hostname, for example `api.example.com`, with service type
   `HTTP` and URL `api:8000`. `cloudflared` resolves `api` on the Compose
   network.
3. In the zone, turn on **Always Use HTTPS** and add a Cache Rule that bypasses
   the cache for the API hostname.

If the API is not meant to be public, put the hostname, or at least `/docs` and
`/openapi.json`, behind Cloudflare Access.

`cloudflared` serves its metrics and a `/ready` endpoint on `127.0.0.1:20241`
inside its container only (`TUNNEL_METRICS`). Its healthcheck,
`cloudflared tunnel ready`, reads that endpoint, which answers 200 once the
tunnel has a connection to Cloudflare, so a release waits for the tunnel and
fails when it does not connect. A Cloudflare outage during a release therefore
fails the release. `bin/release` restores the previous release but reports
`ROLLBACK FAILED`, because that release cannot pass the tunnel check either. The
previous release is back in place and serves again once the tunnel reconnects;
release again after the outage. After an image update, check that the new
`cloudflared` still has `tunnel ready`.

The API keeps idle connections open for 95 seconds (`keepAliveTimeout` in
`apps/api/src/main.ts`), longer than `cloudflared`'s default
`originRequest.keepAliveTimeout` of 90 seconds, so the tunnel never reuses a
connection the API is closing. If you raise the tunnel's keep-alive timeout,
raise the API's above it.

### 6. Files and secrets on the host

```bash
ssh root@<server> 'install -d -m 750 -o deploy -g deploy /opt/uncross /opt/uncross/bin'
scp deploy/vps/compose.yml root@<server>:/opt/uncross/
scp deploy/vps/bin/* root@<server>:/opt/uncross/bin/
scp deploy/vps/env.example root@<server>:/opt/uncross/.env
ssh root@<server> 'chown -R deploy:deploy /opt/uncross && chmod 755 /opt/uncross/bin/* && chmod 600 /opt/uncross/.env'
```

These copies only bootstrap the first release. From then on, every release
installs `compose.yml` and `bin/` from the image it releases, after its
migration has succeeded, so the server always runs the files that match its
image.

Fill in `/opt/uncross/.env` following its comments, and keep every value in the
vault:

- `APP_IMAGE_REPOSITORY`: `ghcr.io/<owner>/<repository>` in lowercase, as the
  Release workflow names the image.
- `POSTGRES_PASSWORD`: generate it with `openssl rand -hex 32`. Characters such
  as `/` or `+` would break the database URL.
- `APP_DATABASE_PASSWORD`: the runtime role's password (see
  [Database roles](#database-roles)); generate it the same way.
- `CLOUDFLARE_TUNNEL_TOKEN`: from step 5.

Run every Compose command through `bin/compose`, which loads both `.env` and
`release.env`.

### 7. GitHub

After CI, the Release workflow runs two jobs, only on `main` and only once the
repository variable `PRODUCTION_HOST` is set. Until then, pushes to `main` run
CI only.

- `publish` builds, smoke-tests and pushes the image, labelled with its commit
  (`org.opencontainers.image.revision`), and outputs the digest `docker push`
  reported. It may write packages, and it never sees the SSH key.
- `deploy` runs in the `production` environment, which holds the SSH key. It
  checks out no code, its token has no permissions, and it only sends
  `<sha> <digest>` to the server.

1. Under **Settings → Environments**, create `production`. Under **Deployment
   branches and tags**, choose **Selected branches and tags** and allow only
   `main`. Add required reviewers if a merge alone should not deploy.
2. Add `PRODUCTION_SSH_KEY` as a secret of the `production` environment, never
   as a repository secret: a workflow on any branch can read repository secrets,
   while this environment's secrets reach only jobs from `main`.
3. Under **Settings → Secrets and variables → Actions → Variables**, add the two
   repository variables. `PRODUCTION_HOST` cannot be an environment variable,
   because the job checks it before it enters the environment.

| Name                     | Where                           | Value                                                                               |
| ------------------------ | ------------------------------- | ----------------------------------------------------------------------------------- |
| `PRODUCTION_SSH_KEY`     | `production` environment secret | Private half of a new Ed25519 key used only for releases                            |
| `PRODUCTION_HOST`        | Repository variable             | The server's IP address or hostname                                                 |
| `PRODUCTION_KNOWN_HOSTS` | Repository variable             | Output of `ssh-keyscan -t ed25519 <server>`, checked against the provider's console |

Also protect `main` with a ruleset (**Settings → Rules → Rulesets**) that
requires the `check`, `static`, `smoke` and `postgres` status checks, so changes
reach `main` through pull requests that passed CI, and blocks force pushes. The
Release workflow runs the same CI again on the pushed commit and deploys only
when it passes, so a commit that reaches `main` another way cannot skip it.

Install the key's public half for `deploy`, with `bin/release` as its forced
command:

```bash
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
echo 'restrict,command="/opt/uncross/bin/release" ssh-ed25519 AAAA... github-actions-release' \
  > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys
```

`restrict` turns off port, agent and X11 forwarding, terminals and `~/.ssh/rc`.
Whatever the client asks to run, sshd runs `bin/release` instead and passes the
request in `SSH_ORIGINAL_COMMAND`. `bin/release` accepts exactly a 40-character
lowercase hexadecimal SHA, optionally followed by one space and
`sha256:<64 lowercase hexadecimal characters>`, and never reads standard input.
It takes the image repository from `.env`, and `compose.yml` and `bin/` from the
image it pulls, so the key cannot send files, pick another image repository or
run any other command.

What the key can still do is release, by digest, any image in
`APP_IMAGE_REPOSITORY` whose revision label names the commit it sends, including
an older one, and a release runs that image's `compose.yml`, `bin/` and
migrations on the host. The server never resolves a tag: CI sends the digest it
pushed, and a rollback by SHA alone uses the digest `releases.log` recorded. So
replacing a tag in GHCR, which any workflow in this repository that asks for
`packages: write` can do on any branch, no longer changes what a release or a
rollback runs. Anyone with write access can still push an image labelled with
any commit, but it runs only if its digest reaches `bin/release`: through this
key, which only `main`'s `deploy` job holds, or from an operator. When you pass
a digest by hand, take it from that commit's Release run, whose `publish` job
summary shows it.

GHCR packages are private by default. Give `deploy` read access with a classic
personal access token that has only `read:packages` (GHCR does not accept
fine-grained tokens); keep it in the vault, run
`runuser -u deploy -- docker login ghcr.io -u <github-user>`, and paste it at
the prompt.

### 8. First start

1. Start the database: `/opt/uncross/bin/compose up -d postgresql`.
2. Run the first release: with `PRODUCTION_HOST` set, push to `main`, or open
   **Actions → Release → Run workflow** on `main`.
3. Verify through the tunnel:

   ```bash
   curl -fsS https://api.example.com/health/live
   curl -fsS https://api.example.com/health/ready
   ```

Do not run `scripts/smoke-api.ts` against production: it creates users.

## Releases and rollback

Every push to `main`, including a merge, starts
[the Release workflow](../../.github/workflows/release.yml). It first runs the
whole of [CI](../../.github/workflows/ci.yml): checks, static checks of the
scripts and workflows, the image smoke test and vulnerability scan, and the
PostgreSQL tests. Then its `publish` job builds the image without the Actions
build cache (the build runs `pnpm check`), runs the Docker smoke test on it and
pushes `ghcr.io/<owner>/<repository>:<sha>`, and its `deploy` job connects to
the server as `deploy` and sends `<sha> <digest>`; the forced command runs
`bin/release`. Releases queue rather than cancel each other. Without staging,
merging to `main` is the deploy decision.

[`bin/release`](bin/release) runs as `deploy`; started as root, it switches to
`deploy` itself. It takes `<sha> <digest>`, or `<sha>` alone for a commit that
`releases.log` shows as released, and then:

1. Takes a lock, waiting up to 60 seconds for it: long enough for
   [`bin/monitor`](bin/monitor) to finish a check, while another release makes
   it fail. Then it pulls `<APP_IMAGE_REPOSITORY>@<digest>`. It refuses an image
   whose `org.opencontainers.image.revision` label is not the SHA, then tags it
   `<APP_IMAGE_REPOSITORY>:<sha>` on the host and copies `compose.yml` and
   `bin/` out of it into a staging directory.
2. With the staged `compose.yml`, the server's `.env` and the new tag and
   digest, validates the configuration, pulls the images and runs `migrate`
   once. Compose recreates any service whose definition changed, PostgreSQL
   included, while the previous release keeps serving. If any of this fails, the
   release stops and `compose.yml`, `bin/`, `release.env` and the running
   containers stay as they were.
3. Copies the current `compose.yml`, `bin/` and `release.env` to `.previous/`,
   then installs the staged `compose.yml` and `bin/` and a `release.env` with
   the new `APP_IMAGE_TAG` and `APP_IMAGE_DIGEST`.
4. Checks the release:
   - `bin/compose up -d --wait` for the API, worker and tunnel succeeds, which
     needs the API's liveness healthcheck and the tunnel's readiness healthcheck
     to pass.
   - `/health/ready` answers 200 within 30 seconds, asked from inside the API
     container, so the API reaches the database.
   - The worker and `cloudflared` keep running for 15 seconds without another
     restart. `up --wait` alone cannot tell: it accepts a container without a
     healthcheck once it has started, even one that exits at once and restarts
     in a loop.
5. If every check passes, appends a `RELEASED` line to `releases.log` and
   removes this repository's images except those of the three latest releases
   and of the previous one. That includes untagged ones: an image refused for
   its label, or one whose tag a newer image of the same commit took over.
6. If a check fails, appends a `FAILED` line, restores `.previous/`, runs the
   same checks on the restored release and exits 1, printing which check failed
   and that it rolled back. Images are not pruned. The first release has no
   previous one: it stays installed, unhealthy, and still exits 1. If the
   restored release fails its checks too, `bin/release` prints `ROLLBACK FAILED`
   and production needs attention.

Exit status 2 means the request was malformed, or named only a SHA that
`releases.log` has no release of; 1 means any other failure. Either way the
output says what happened.

Once the request is valid, `bin/release` runs to the end even if the `deploy`
job is cancelled or the SSH connection drops, so it never stops between
installing a release and restoring the previous one. It also writes its output
to `release-output.log`, replacing the previous attempt's. After a cancelled or
interrupted deploy, read the outcome there and in `releases.log`.

`releases.log` has one line per release attempt that reached step 4, separated
by single spaces:

```text
2026-10-27T15:37:28Z 6dcd4ce23d88e2ee9568ba546c007c63d9131c1b sha256:8dc9d8ff3672f752c2c0fac2f4206604f7921ca31a11a2d6623657fe55587161 RELEASED
```

`release.env` always names the installed release. After a successful release or
rollback, that is the last `RELEASED` line; a failed first release or a failed
rollback leaves an unverified release installed.

The single API replica is unavailable for a few seconds while it restarts, and
the tunnel returns an error page meanwhile. An automatic rollback restarts it
again.

**Upgrading a server set up before the runtime role.** Add
`APP_DATABASE_PASSWORD`, generated as in step 6, to `.env` before releasing the
commit that introduces it. Without it, that release stops in step 2, at the
staged `config --quiet`, and changes nothing; add it and release again.

Migrations never run at application startup. They must work with the previous
release still running, because it serves traffic while `migrate` runs and a
rollback does not undo them: add columns and tables first, and remove old ones
in a later release.

`migrate` gives up after waiting 5 seconds for a lock. Otherwise an ALTER TABLE
queued behind a long transaction would hold up every query on that table while
the previous release serves. The release then fails at step 2 and changes
nothing; run it again, for example by re-running the `deploy` job, once that
transaction has ended. Statements themselves have no time limit, so a long index
build finishes, but it blocks writes to its table until it does, and a write
waiting for it gives up after 8 seconds, or after
`DATABASE_STATEMENT_TIMEOUT_MS` if that is shorter.

**Rollback.** A release that fails its checks rolls itself back. To return to an
earlier release by hand, run `/opt/uncross/bin/release <sha>` on the server; it
releases the digest `releases.log` recorded for that commit. For a commit this
server never released, pass the digest from that commit's Release run:
`bin/release <sha> sha256:<digest>`. Re-running only the `deploy` job of that
commit's Release run does the same, because it reuses the `publish` job's
digest; re-running every job builds and publishes a new image instead. Either
way the release's `compose.yml` and `bin/` come back with its image. Fix forward
when the previous code cannot work with the newer schema.

## Backups and restore

1. Create the bucket and an access key limited to it, with read and write
   access. To keep a compromised server from destroying the backups, set the
   bucket up as in [Backup immutability](#backup-immutability) before the first
   backup.
2. Create two checks in a dead man's switch service (see
   [Monitoring](#monitoring)): one for the backup, with a period of 1 day and a
   grace of 2 hours, and one for the backup check, with a period of 7 days and a
   grace of 6 hours.
3. Install the credentials file, then fill it in following its comments, with
   the two checks' URLs:

   ```bash
   ssh root@<server> 'install -d -m 700 /etc/uncross'
   scp deploy/vps/restic.env.example root@<server>:/etc/uncross/restic.env
   ssh root@<server> 'chmod 600 /etc/uncross/restic.env'
   ```

4. Initialize the repository once:
   `set -a; . /etc/uncross/restic.env; set +a; restic init`.
5. Install and start the nightly backup and the weekly check:

   ```bash
   scp deploy/vps/systemd/backup.service root@<server>:/etc/systemd/system/uncross-backup.service
   scp deploy/vps/systemd/backup.timer root@<server>:/etc/systemd/system/uncross-backup.timer
   scp deploy/vps/systemd/verify-backup.service root@<server>:/etc/systemd/system/uncross-verify-backup.service
   scp deploy/vps/systemd/verify-backup.timer root@<server>:/etc/systemd/system/uncross-verify-backup.timer
   ssh root@<server> 'systemctl daemon-reload && systemctl enable --now uncross-backup.timer uncross-verify-backup.timer'
   ```

6. Run each once, in this order, read the result, and check that each check
   received its ping:
   `systemctl start uncross-backup.service && journalctl -u uncross-backup -n 30`,
   then
   `systemctl start uncross-verify-backup.service && journalctl -u uncross-verify-backup -n 40`.

The scripts need restic 0.16 or later, which Ubuntu 24.04 and Debian 13 have.

[`bin/backup`](bin/backup) writes a `pg_dump -Fc` of the database to
`/var/backups/uncross/database.dump`, uploads it with restic and applies the
retention policy (7 daily, 4 weekly, 6 monthly). Then it pings `HEARTBEAT_URL`.
When any step fails, it pings `<HEARTBEAT_URL>/fail` at once, with the last
lines of the error, rather than leaving the check to notice a missing ping a day
later. The service stops a backup that runs for more than 3 hours, which then
reports a failure too; raise `TimeoutStartSec` in `backup.service` if a backup
legitimately takes longer. A restic process killed that way, or by a reboot,
leaves its lock in the repository, which later restic commands would wait for,
so the backup and the backup check start with `restic unlock`: it removes only
locks whose process is gone. The service keeps restic's cache in
`/var/cache/uncross-restic`, so a run downloads only what changed.

### Weekly backup check

Every Sunday at about 05:00, two hours after the backup,
[`bin/verify-backup`](bin/verify-backup) checks that the backups can be
restored:

1. The latest nightly snapshot is less than 26 hours old.
2. It restores that snapshot's dump into a throwaway PostgreSQL container named
   `uncross-verify-backup`, from the image `compose.yml` runs, so the check
   follows PostgreSQL updates. The dump streams from restic into `pg_restore`
   and never touches the disk. The container has no network, at most 512 MB of
   memory, one CPU and 128 processes, and is removed with its volume however the
   run ends.
3. The restored migration journal has at least one migration and no more than
   the live database's. A release between the backup and the check can have
   added some; the journal shows both counts.
4. Every table in `public` can be read: the journal lists each one's row count.
5. `restic check` verifies the repository's structure and reads a quarter of its
   data, a different quarter each week, so every pack is read about once a
   month. The restore has already read the latest backup in full.

It pings `VERIFY_HEARTBEAT_URL` when every step passes and
`<VERIFY_HEARTBEAT_URL>/fail` with the error otherwise. Each restic step waits
up to an hour for another restic command's lock, such as a backup started by
hand.

The restored copy takes about as much disk as the live database, so before it
starts the check requires that much plus 1 GiB free on Docker's data root
(`docker info --format '{{.DockerRootDir}}'`, usually on `/`), and fails
otherwise. While it runs, the disk is that much fuller: keep normal use far
enough below `MONITOR_DISK_PERCENT` that the monitor does not alert during the
check. The check takes about as long as a `pg_restore` of the database plus
reading a quarter of the repository, and is stopped and reported as failed after
3 hours.

**Restore drill.** Run it by hand before launch, to see each step work; from
then on the weekly check repeats the restore:

```bash
set -a; . /etc/uncross/restic.env; set +a
restic restore latest --target /tmp/restore
postgres_image=$(/opt/uncross/bin/compose config --images postgresql)
docker run -d --name restore-pg -e POSTGRES_PASSWORD=drill "$postgres_image"
until docker exec restore-pg pg_isready -h 127.0.0.1 -U postgres; do sleep 1; done
docker cp /tmp/restore/var/backups/uncross/database.dump restore-pg:/tmp/database.dump
docker exec restore-pg pg_restore -U postgres --no-owner --no-privileges --create -d postgres /tmp/database.dump
docker exec restore-pg psql -U postgres -d uncross -c 'select count(*) from users'
docker rm -f -v restore-pg && rm -rf /tmp/restore
```

The dump holds the runtime role's grants, but not the role itself, which belongs
to the whole PostgreSQL cluster rather than the database. Restoring them into a
cluster without that role fails with `role "uncross_app" does not exist`, so
every restore skips every grant with `--no-privileges`. The next `migrate`
creates the role and grants it access again; re-apply any grant you added by
hand.

A full restore follows the same path on a new server: repeat setup steps 2–7,
start PostgreSQL with `bin/compose up -d postgresql`, load the dump with
`bin/compose exec -T postgresql sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges' < database.dump`,
then release the last commit, whose `migrate` creates the runtime role before
the API and worker start.

### Backup immutability

The server holds a key that can write to the bucket, so whoever takes over the
server can also delete the backups, unless the bucket keeps what that key
deletes. restic deletes files in normal use: `forget` removes snapshots, `prune`
removes data it no longer needs, and every command removes its lock file. So the
bucket must let those deletes succeed while keeping the old versions for a
while, and the key must not be able to remove those versions or change the
bucket's settings. Keep 30 days of old versions: that is the time to notice and
recover, and the cost is about 30 days of pruned data in storage.

- **AWS S3.** Turn on versioning, then add a lifecycle rule that permanently
  deletes noncurrent versions 30 days after they become noncurrent, removes
  expired delete markers and aborts incomplete multipart uploads. A delete
  without a version ID, which is what restic sends, only adds a delete marker.
  Give the key only the policy in
  [restic's example](https://restic.readthedocs.io/en/stable/080_examples.html),
  which cannot delete versions (`s3:DeleteObjectVersion`) or change the bucket.
- **Backblaze B2.** Use its S3-compatible API, as restic recommends. Restic's
  documentation suggests the lifecycle setting "Keep only the last version";
  choose "Keep prior versions for this number of days" with 30 instead. Over the
  S3 API a delete by name, which is what restic sends, needs only `writeFiles`
  and hides the file, while deleting a version needs `deleteFiles`
  ([app keys](https://www.backblaze.com/docs/cloud-storage-s3-compatible-app-keys)).
  The web UI's read-and-write key has `deleteFiles`, so create the key with the
  B2 CLI, for this bucket only and with nothing that deletes versions or changes
  the bucket:
  `b2 key create --bucket <bucket> <name> listBuckets,listAllBucketNames,readBuckets,listFiles,readFiles,writeFiles`.
  After the first backup, run `restic forget --prune` once and check in the
  bucket's file browser that the removed files are hidden, not gone.
- **Cloudflare R2** cannot protect a restic repository that is pruned nightly.
  It has no versioning or Object Lock
  ([S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)),
  and the Object Read & Write permission that restic needs is also what lets it
  remove its lock files and pruned data
  ([tokens](https://developers.cloudflare.com/r2/api/tokens/)).
  [Bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
  refuse every delete of a locked object, so a lock rule over restic's data
  makes the nightly `forget --prune` fail, and one over `locks/` fails every
  command. Use B2 or S3 when this protection matters.

This protects the backups from a stolen key, not from a stolen storage account:
its owner can delete versions and change the bucket. Object Lock does not close
that gap for restic. Governance mode yields to anyone allowed
`s3:BypassGovernanceRetention`, and even compliance mode keeps a version only
for a fixed time after its upload
([S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html),
[B2](https://www.backblaze.com/docs/cloud-storage-object-lock)), while restic
keeps its `config`, `keys/` and oldest data for good. Against that, keep a copy
outside the account: replicate the bucket to one in another account, or back up
to a second restic repository with another provider.

To recover after the backups were deleted, restore the deleted versions: remove
the delete markers in S3 (`aws s3api list-object-versions` and
`delete-object --version-id` on each marker), or unhide the files in B2. Then
run `restic check --read-data` before trusting the repository again.

## Monitoring

Three dead man's switches watch the server: checks in a service such as
[Healthchecks.io](https://healthchecks.io/docs/http_api/) or
[Better Stack](https://betterstack.com/docs/uptime/cron-and-heartbeat-monitor/).
A check alerts when its job reports a failure, and when it reports nothing in
time, which also covers a job that never ran and a server that is down. Each job
pings its URL when it succeeds and `<URL>/fail` when it fails, with its last
lines of errors as the body, the scheme both services use.
[`bin/heartbeat.sh`](bin/heartbeat.sh) does the reporting: it retries for about
a minute and never changes the job's result. Cronitor and Uptime Kuma take the
outcome as a query parameter instead, after which `/fail` would be part of the
query string, so a URL with a query string is refused.

| Job                            | URL                                      | Period    | Grace      |
| ------------------------------ | ---------------------------------------- | --------- | ---------- |
| `bin/backup`, nightly          | `HEARTBEAT_URL` in `restic.env`          | 1 day     | 2 hours    |
| `bin/verify-backup`            | `VERIFY_HEARTBEAT_URL` in `restic.env`   | 7 days    | 6 hours    |
| `bin/monitor`, every 5 minutes | `MONITOR_HEARTBEAT_URL` in `monitor.env` | 5 minutes | 15 minutes |

A failure report quotes the last 20 lines, at most 10 kB, that the job wrote to
standard error. They can name the repository URL and bucket, hostnames and
database objects, and a failed restore can quote a row's values. The scripts
never print the restic password, the access keys or a database password, but a
tool's error can quote one: Compose quotes the value of a `.env` line it cannot
parse, so `bin/heartbeat.sh` cuts those lines short before sending them. Pick
the service with that in mind, or self-host Healthchecks.

[`bin/monitor`](bin/monitor) runs every 5 minutes as root, in a second or two,
and reports a problem when:

- more memory than `MONITOR_MEMORY_PERCENT` (90) is in use, counting
  `MemAvailable` as free;
- the filesystem holding `/` or Docker's data root is fuller than
  `MONITOR_DISK_PERCENT` (80);
- Docker does not answer;
- a service of `compose.yml` has no container, or its container is not running
  (exited, restarting or paused) or is unhealthy;
- Docker restarted a container since the last check, which is how the worker
  recovers from a failure, and otherwise goes unnoticed;
- `/health/ready` does not answer 200 within 2 seconds, asked inside the API
  container as `bin/release` asks.

It compares restart counts with the last check's, kept by container ID in
`/var/lib/uncross-monitor/restarts`, so a container that a release or an
operator recreated starts from zero, and one restart alerts once. Docker resets
the counts when it starts, and at boot the worker restarts until PostgreSQL is
ready, so the first check after Docker starts only records them. Until the first
release only the host and Docker are checked. During a release it skips its
check without reporting: `bin/release` checks the services itself, and the
15-minute grace outlasts a release.

1. Create the monitor's check, with a period of 5 minutes and a grace of 15.
2. Install its settings file and fill in the URL:

   ```bash
   scp deploy/vps/monitor.env.example root@<server>:/etc/uncross/monitor.env
   ssh root@<server> 'chmod 600 /etc/uncross/monitor.env'
   ```

3. Install and start the timer, which runs the first check at once:

   ```bash
   scp deploy/vps/systemd/monitor.service root@<server>:/etc/systemd/system/uncross-monitor.service
   scp deploy/vps/systemd/monitor.timer root@<server>:/etc/systemd/system/uncross-monitor.timer
   ssh root@<server> 'systemctl daemon-reload && systemctl enable --now uncross-monitor.timer'
   ```

When a check alerts, read the job's journal as root
(`journalctl -u uncross-<job> -n 50`) and act on its lines:

- **Backup failed.** The body names the step: Compose or `pg_dump` (PostgreSQL
  down, disk full) or restic (credentials, bucket, network). Fix it and run
  `systemctl start uncross-backup.service`.
- **Backup check failed.**
  - `no nightly snapshot` or `hours old`: backups have stopped; see the backup's
    own alert.
  - `Not restoring`: free disk on Docker's data root, then run the check again
    (`systemctl start uncross-verify-backup.service`).
  - `is already in use`: a run that was killed left its container behind. Remove
    it with `docker rm -f -v uncross-verify-backup` and run the check again.
  - `pg_restore`, or the migration counts: the latest backup does not restore.
    Take a backup now and run the check again; if it still fails, find out why
    before the backup is needed.
  - `repository contains errors`, `does not exist` or
    `ciphertext verification failed`: the repository is damaged. A new backup
    does not repair it. Run `restic check --read-data` to see how far, and
    follow
    [restic's troubleshooting guide](https://restic.readthedocs.io/en/stable/077_troubleshooting.html).
- **Monitor failed.** One line per problem:
  - `Disk:` or `Memory:`: free space (old images, logs) or find the process
    (`docker stats --no-stream`), or resize the server.
  - `is exited`, `is restarting`, `is paused`, `has no container` or
    `is unhealthy`: `bin/compose ps`, `bin/compose logs --since 30m <service>`,
    then `bin/compose up -d --wait <service>`. A service stopped on purpose
    alerts too, until it runs again.
  - `restarted since the last check`: read the service's logs from around then.
    One worker restart after a database blip is recovery; one on every check is
    a crash loop.
  - `api is not ready`: the API runs but cannot reach the database.
  - A Docker error, or `Stopped by SIGTERM` when Docker hangs:
    `systemctl status docker` and `journalctl -u docker`.
- **No ping in time.** The server is down or unreachable, the job's timer
  stopped (`systemctl list-timers 'uncross-*'`), or, for the monitor, a release
  has run longer than 15 minutes.

The checks are alerts only, without metrics history. Worth adding:

- **Uptime:** an external HTTP check on `/health/ready` through the tunnel every
  minute, alerting by email or phone. The monitor asks from inside the server,
  so it cannot see the tunnel, DNS or Cloudflare.
- **Logs:** an agent such as Grafana Alloy shipping the container logs, which
  keeps what recreating a container discards. The API, worker and `migrate`
  write one JSON object per line (see [Logs](../../README.md#logs)); an agent
  can alert on `"level":"ERROR"`. The API logs every request except passing
  health probes, and a 5xx at Error.
- **Metrics:** the same agent can ship host and container metrics, for graphs of
  disk, memory and CPU over time.

**Upgrading a server set up before these checks.** The release that adds them
installs `bin/verify-backup`, `bin/monitor` and `bin/heartbeat.sh` with the rest
of `bin/`. Then, as root, install `backup.service` again for its timeout, add
`VERIFY_HEARTBEAT_URL` to `restic.env`, and install the backup check's and the
monitor's units and `monitor.env` as above. Rolling back past that release
removes the scripts, so the backup check and the monitor fail, and their
switches alert, until a newer release brings them back.

## Day-to-day operations

```bash
ssh root@<server>
sudo -iu deploy
cd /opt/uncross

bin/compose ps
bin/compose logs -f --since 10m api worker
bin/compose restart worker
bin/compose exec postgresql sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'
tail releases.log
```

As root, `systemctl list-timers 'uncross-*'` shows when the backup, the backup
check and the monitor last ran and run next, and
`journalctl -u uncross-monitor -n 50` shows what a job printed; see
[Monitoring](#monitoring) for what its alerts mean.

`bin/compose exec postgresql` runs as the `postgres` user, not root, and the
container's root filesystem is read-only: pass files on standard input, as the
full restore does, rather than copying them into the container.

- **Find a request:** Cloudflare gives every request a ray ID, which the client
  receives in the `cf-ray` response header.
  `bin/compose logs api | grep <ray ID>` finds the request's access line, which
  records it as `cfRay`, and `bin/compose logs api | grep <traceId>` then finds
  every line the request logged. Ray IDs are not guaranteed to be unique, so
  check the timestamp. `bin/compose logs` shows only the current containers'
  output, rotated at the size `x-logging` in `compose.yml` sets: a release, a
  rollback or a `LOG_LEVEL` change recreates them and discards what they wrote,
  so search older lines in the log-shipping agent from
  [Monitoring](#monitoring).
- **Change `LOG_LEVEL`:** recreating a container discards its logs, so first
  save what you may need:
  `bin/compose logs --no-color --timestamps api worker > "logs-$(date -u +%Y%m%dT%H%M%SZ).txt"`.
  Then set it in `.env` and recreate only the services it should change. `Debug`
  adds a line for each worker pass, so `bin/compose up -d --wait worker` is
  enough. Recreate the API too (`bin/compose up -d --wait worker api`) only when
  it should log differently, at `Warn` for example: it is unavailable for a few
  seconds and loses its log history. A release recreates both with the value in
  `.env`. The names are case-sensitive (`All`, `Trace`, `Debug`, `Info`, `Warn`,
  `Error`, `Fatal`, `None`): with any other value a process exits 1 after one
  `Invalid logging configuration` line and restarts until it is fixed, so
  `--wait` fails, and the next release's `migrate` fails before anything
  restarts. Set it back to `Info` afterwards.
- **Database tools:** from your machine, open a tunnel with
  `ssh -N -L 5432:127.0.0.1:5432 root@<server>`.
- **Change `POSTGRES_PASSWORD`:** PostgreSQL reads `POSTGRES_PASSWORD` only when
  it creates an empty data directory, so change the role's password first.
  Generate the new one with `openssl rand -hex 32` and store it in the vault.
  Open `psql` as in the block above, run `\password` (it changes the connected
  role's password) and paste it. Then put it in `.env` and run
  `bin/compose up -d --wait postgresql`, which recreates PostgreSQL with the new
  value. Only `migrate` and database tools log in with it, but any later
  `bin/compose up`, of `cloudflared` say, would recreate PostgreSQL too, because
  its definition changed, so do it now, at a time you choose. The database is
  unavailable for a few seconds: API requests fail and the worker may restart.
- **Change `APP_DATABASE_PASSWORD`:** generate the new one the same way, store
  it in the vault and put it in `.env`. Then release the current commit again:
  `bin/release $(sed -n 's/^APP_IMAGE_TAG=//p' release.env)`. Its `migrate` sets
  the new password, and its restart gives the API and the worker the new value.
  Connections they open between the two steps fail to log in, so for a few
  seconds the worker may restart and API requests may fail.
- **Rename `APP_DATABASE_USER`:** provisioning only touches the role the release
  names, so the old role can still log in with its old password and grants. Once
  the release with the new name serves, open `psql` as in the block above and
  remove it, with `<old>` replaced by its name:
  `REASSIGN OWNED BY <old> TO CURRENT_USER; DROP OWNED BY <old>; DROP ROLE <old>;`.
- **Change `CLOUDFLARE_TUNNEL_TOKEN`:** put the new token in the vault and in
  `.env`, run `bin/compose up -d --wait cloudflared`, check `/health/ready`
  through the tunnel, then revoke the old token at Cloudflare. Restarting the
  API or worker does not apply it, because only `cloudflared` uses it.
- **Host updates:** `unattended-upgrades` installs security patches. Once a
  month, take a provider snapshot, run `apt-get full-upgrade`, and reboot if
  required.
- **Image updates:** Renovate proposes PostgreSQL minor versions and
  `cloudflared` as tag and digest changes in `compose.yml` (see
  [Dependency updates](../../README.md#dependency-updates)), and the backup
  check and the restore drill read PostgreSQL's image from it. The release of
  that commit applies them; a PostgreSQL change restarts the database briefly
  before `migrate` runs. A PostgreSQL major upgrade needs a dump and restore, so
  Renovate leaves it out; plan it separately. If PostgreSQL moves to a
  non-Alpine image, change the `uid` and `gid` of its `/var/run/postgresql`
  tmpfs in both Compose files: 70 is Alpine's `postgres` user, and Debian's
  is 999.

## Pre-launch checklist

Keep production private until every item passes.

- [ ] `/health/live` and `/health/ready` pass through the tunnel hostname.
- [ ] Stopping PostgreSQL briefly turns `/health/ready` into 503 while
      `/health/live` stays 200, and the worker restarts and recovers once the
      database is back: at the default level a healthy worker writes nothing, so
      check that `bin/compose logs worker` shows no new `Worker failed` line and
      that
      `docker inspect --format '{{.RestartCount}}' $(bin/compose ps -q worker)`
      stops rising.
- [ ] After `reboot`, every service and the tunnel return without manual action.
- [ ] The API and the worker connect as the runtime role: in `psql`,
      `select distinct usename from pg_stat_activity where application_name = 'uncross'`
      lists only `APP_DATABASE_USER`, and
      `select count(*) from pg_auth_members where member = '<APP_DATABASE_USER>'::regrole`
      returns 0.
- [ ] A release with a migration, then a rollback to the previous commit.
- [ ] A release whose API cannot reach the database rolls itself back.
- [ ] The backup, the restore drill and the backup check pass, and the backup's
      and the backup check's dead man's switches show their pings.
- [ ] From outside, only port 22 answers (`nmap -Pn <server>`); PostgreSQL is
      unreachable.
- [ ] Memory and CPU under representative load fit the server. Adjust
      `mem_limit` or resize if not.
- [ ] Alerts fire:
  - Stop `api` and expect the uptime alert.
  - With PostgreSQL stopped (`bin/compose stop postgresql`), run
    `systemctl start uncross-backup.service`: the backup's check reports the
    failure at once. Start PostgreSQL again and run the backup.
  - `bin/compose stop worker`: the monitor's check alerts within about 6
    minutes. `bin/compose start worker`, and it recovers at the next check.
  - `systemctl stop uncross-monitor.timer`: the monitor's check alerts after
    about 20 minutes, as it would for a server that is down. Start the timer
    again.

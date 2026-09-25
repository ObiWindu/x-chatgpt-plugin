# Hostim.dev deployment configuration

## What is included

- `hostim/stack.yml` — Hostim project template.
- `hostim/global.env.example` — project-level environment variables.
- `hostim/cli-config.example.yml` — example Hostim CLI global config.
- `docker-compose.hostim.yml` — Docker Compose variant.
- `scripts/deploy-hostim.sh` — validates and applies the Hostim template.
- `scripts/set-hostim-global-env.sh` — sets project-level env vars.
- `.gitignore.example` — ignores local secrets/database data.

## Deploy

Install/login:

```bash
hostim login
hostim projects ls
hostim use YOUR_PROJECT
```

Configure project-wide variables:

```bash
cp hostim/global.env.example hostim/global.env
# edit hostim/global.env
./scripts/set-hostim-global-env.sh
```

Set your repository URL in `hostim/stack.yml`, then:

```bash
hostim templates validate -f hostim/stack.yml
hostim templates apply -f hostim/stack.yml -y
```

Check:

```bash
hostim overview
hostim events x-publisher -n 20
```

## Domain and HTTPS

Attach a stable domain:

```bash
hostim domain add api.example.com -a x-publisher
hostim domain status x-publisher
```

Set:

```text
PUBLIC_BASE_URL=https://api.example.com
X_REDIRECT_URI=https://api.example.com/auth/x/callback
```

Hostim provides HTTPS automatically for built-in and verified custom domains.

## Plans

The template uses example plans:

```text
sa-1-1
vol-1
```

Check the plans available in your project's region before applying:

```bash
hostim regions ls
hostim regions pricing YOUR_REGION --for apps
hostim regions pricing YOUR_REGION --for volume
```

Replace the plan IDs in `hostim/stack.yml` when necessary.

## CLI global config

The Hostim CLI stores its config in:

```text
~/.config/hostim/config.yml
```

or under `$XDG_CONFIG_HOME/hostim/config.yml`.

Example:

```yaml
apiUrl: https://api.hostim.dev
currentProject: YOUR_PROJECT
```

For CI, prefer:

```bash
export HOSTIM_TOKEN=...
export HOSTIM_PROJECT=YOUR_PROJECT
```

and do not write credentials into the repository.

## Hostim-specific behavior

Hostim supports project-level environment variables; app-level variables override project-level values. It also supports persistent volumes and HTTP health checks. A health check at `/health` is used here so traffic is only routed after the app is ready.

For an existing Docker image, Hostim can deploy the image directly. For this repository, the Git/template path is preferable because Hostim can build the included Dockerfile.

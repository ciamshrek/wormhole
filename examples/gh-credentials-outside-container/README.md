# GitHub CLI with credentials outside the container

The simplest wormhole example. An agent container runs `gh repo list`, `gh status`, and other GitHub CLI commands — but has no GitHub token. The proxy intercepts requests to `api.github.com` and injects credentials from its own environment.

```
Agent container          Proxy                      GitHub
(no GH_TOKEN)           (has GH_TOKEN)

gh repo list
  → Authorization: token _  →  replaces with real token  →  api.github.com
                             ← repos                     ←  repos
```

The agent's `GH_TOKEN=_` is a dummy — `gh` needs *something* set to make requests. The handler strips it and replaces with the real token.

## Setup

### 1. Create a fine-grained GitHub token

Go to [**Settings → Developer settings → Fine-grained tokens**](https://github.com/settings/personal-access-tokens/new):

| Field | Value |
|---|---|
| Token name | `wormhole-demo` |
| Expiration | 7 days |
| Repository access | **All repositories** (or select specific ones) |

Under **Permissions**, grant read-only access:

| Permission | Access |
|---|---|
| **Metadata** | Read (granted by default) |
| **Contents** | Read |

Under **Account permissions**:

| Permission | Access |
|---|---|
| **Starring** | Read |

Click **Generate token** and copy it.

### 2. Create `.env`

```bash
cp .env.example .env
# Paste your token
```

### 3. Run

```bash
docker compose up --build
```

## Files

```
├── agent/
│   ├── Dockerfile    # Alpine + gh CLI
│   └── run.sh        # gh repo list, gh status, etc.
├── handler.ts        # 10 lines — inject GH_TOKEN for api.github.com
├── docker-compose.yml
└── .env.example
```

## What this shows

The agent container has **zero access** to the GitHub token. It can't read it from env, disk, or memory. The credential lives only in the proxy process.
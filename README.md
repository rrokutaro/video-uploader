# Video Uploader

Automated YouTube and Facebook Reels upload pipeline. Picks up generated videos from Google Drive,
deduplicates against live channels/pages, and uploads on a fair round-robin schedule across configs,
channels, and pages. Runs as a scheduled GitHub Actions job — no server to maintain, no babysitting.

---

## How it works

1. **GitHub Actions** triggers the job every 15 minutes (free, unlimited on public repos)
2. **uploader-server.js** starts, re-fetches configs/secrets/tokens from GDrive
3. Scans each configured GDrive folder for `.zip` files matching the current config
4. Sorts candidates by score (highest first)
5. Scrapes YouTube channels via `yt-dlp` to check if the video is already live (UNIV tag)
6. Checks Facebook pages via Graph API for the same UNIV tag
7. Checks min-gap since last upload via **MongoDB Atlas** state (free M0 cluster)
8. Downloads the zip, extracts it, uploads to YouTube and/or Facebook, deletes from Drive
9. Saves state back to MongoDB — next run continues from where it left off

---

## Repository structure

```
video-uploader/
  uploader-server.js        # main server
  start-uploader.sh         # bootstrap script (for local/Colab use only)
  package.json              # node dependencies
  .github/
    workflows/
      uploader.yml          # GitHub Actions workflow
```

Assets are **not** stored in the repo. They are fetched at runtime from GDrive:

```
GDrive (private folders, shared "Anyone with the link"):
  server-configs/           # zipped folder → fetched via GDRIVE_SERVER_CONFIGS_ID
    movie-recaps.json
    shorts.json
    ...
  client-secrets/           # zipped folder → fetched via GDRIVE_CLIENT_SECRETS_ID
    client1.json
    client2.json
    ...
  client-tokens/            # zipped folder → fetched via GDRIVE_CLIENT_TOKENS_ID
    token1.json
    token2.json
    ...
```

> **Important:** All three GDrive folders must be shared as **"Anyone with the link"**
> so `gdown` can fetch them without interactive login.

---

## GDrive zip file format

Videos are uploaded to GDrive as `.zip` files by the generator. The filename
encodes the score, config ID, and UNIV:

```
<score>_<config_id>_UNIV-<univ_id>.zip
```

Example:
```
87.50_sU8kTYfixdGil2l6_UNIV-d3af9b21c0.zip
```

Each zip contains:
```
video.(mp4|mov|mkv|webm)        # required
thumbnail.(jpg|jpeg|png|webp)   # optional (YouTube only)
metadata.json                   # required
```

### metadata.json structure
```json
{
  "title": "Video title here",
  "description": "Video description here",
  "tags": ["tag1", "tag2"],
  "categoryId": 22
}
```

> **Note:** The UNIV tag is appended automatically by the uploader at publish time —
> you do not need to include it in `metadata.json`.

---

## Server config file structure

Stored in `assets/server-configs/` — one JSON file per niche/config.

```json
{
  "config_id": "sU8kTYfixdGil2l6",
  "scheduled_upload_delay": 1800000,
  "scheduled_uploads": false,
  "delete_videos_after_uploads": true,
  "max_daily_yt_upload_per_channel": 6,
  "max_daily_fb_upload_per_page": 3,

  "google_drives": [
    {
      "alias": "DRIVE 1",
      "client": "client1.json",
      "token": "token1.json",
      "folder_id": "1aBcDeFgHiJkLmNoPqRsTuVwXyZ"
    }
  ],

  "channels": [
    {
      "name": "channel-slug",
      "id": "UCxxxxxxxxxxxxxxxxxxxxxxxx",
      "client": "client1.json",
      "token": "token1.json"
    }
  ],

  "facebook_pages": [
    {
      "name": "my-page-slug",
      "id": "123456789012345",
      "access_token": "EAAxxxxxxx..."
    }
  ]
}
```

### Config fields

| Field | Description |
|---|---|
| `config_id` | Unique string ID — must match the `config_id` segment in zip filenames |
| `scheduled_upload_delay` | Min ms between uploads (default: 1800000 = 30min) |
| `scheduled_uploads` | If `true`, uploads as private with a future publish date (YouTube only) |
| `delete_videos_after_uploads` | If `true`, deletes zip from Drive after upload |
| `max_daily_yt_upload_per_channel` | Max uploads per YouTube channel per day (default: 6) |
| `max_daily_fb_upload_per_page` | Max uploads per Facebook page per day (default: matches YT value) |
| `google_drives` | List of GDrive accounts to scan for zip files |
| `channels` | List of YouTube channels to upload to (round-robin) |
| `facebook_pages` | List of Facebook pages to upload Reels to (round-robin) — optional |

> `facebook_pages` is optional. If omitted, the FB pipeline is skipped entirely for that config.

---

## Facebook setup

### Getting a permanent Page Access Token

1. Go to [developers.facebook.com](https://developers.facebook.com) and create a **Business** app
2. Add the **Pages API** product
3. Open the **Graph API Explorer**
4. Request a User Token with these permissions: `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`
5. Exchange for a long-lived user token:
   ```
   GET https://graph.facebook.com/v25.0/oauth/access_token
     ?grant_type=fb_exchange_token
     &client_id={APP_ID}
     &client_secret={APP_SECRET}
     &fb_exchange_token={SHORT_LIVED_TOKEN}
   ```
6. Fetch your pages and their **permanent** page tokens:
   ```
   GET https://graph.facebook.com/v25.0/me/accounts
     ?access_token={LONG_LIVED_USER_TOKEN}
   ```
7. Copy each page's `access_token` and `id` into your server config

Page access tokens generated from a long-lived user token **do not expire**.

### Facebook description format

FB Reels do not support tags, so the uploader builds the description automatically:

```
Your description here  #tag1 #tagwithspaces #anothertag

UNIV::d3af9b21c0
```

- Tags from `metadata.json` are lowercased, spaces removed, and prefixed with `#`
- The UNIV tag is always placed on its own line at the end
- Total description is capped at **500 characters** (excl. UNIV line) to stay within Reels limits

---

## Setup

### 1. MongoDB Atlas (free state storage)

1. Sign up at https://www.mongodb.com/atlas
2. Create a free **M0 cluster** — pick **AWS us-east-1**
3. Create a database user (save username + password)
4. Network Access → Add IP → **Allow Access from Anywhere** (`0.0.0.0/0`)
5. Connect → Drivers → copy the connection string:
   ```
   mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

### 2. Fork or create the repo

Make the repo **public** (required for unlimited free GitHub Actions minutes).

Push these files to the root:
- `uploader-server.js`
- `package.json`
- `.github/workflows/uploader.yml`

Do **not** commit `on-start.env` or any secrets.

### 3. Add GitHub Secrets

Go to **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `MONGODB_URI` | Full Atlas connection string with password |
| `GDRIVE_SERVER_CONFIGS_ID` | GDrive folder ID for server-configs zip |
| `GDRIVE_CLIENT_SECRETS_ID` | GDrive folder ID for client-secrets zip |
| `GDRIVE_CLIENT_TOKENS_ID` | GDrive folder ID for client-tokens zip |
| `UPLOADER_CONFIGS` | Comma-separated config filenames e.g. `movie-recaps.json` |
| `UPLOADER_MIN_GAP` | Min ms between uploads e.g. `1800000` |
| `UPLOADER_WINDOW` | UTC upload window e.g. `13:00-23:00` (leave empty for anytime) |
| `UPLOADER_DRY_RUN` | `true` for testing, `false` for real uploads |

> **Finding a GDrive folder ID:** Open the folder in your browser. The URL looks like
> `https://drive.google.com/drive/folders/1aBcDeFgHiJkLmNoPqRsTuVwXyZ` —
> the part after `/folders/` is the ID.

### 4. Test

Go to **Actions → Uploader Server → Run workflow** to trigger a manual run.
Check the logs to confirm assets are fetched and the pipeline runs correctly.
Set `UPLOADER_DRY_RUN=true` while testing — this validates config loading, Drive scanning,
round-robin logic, and window/gap checks without making any real uploads.

> **Note:** Dry-run does not validate your Facebook access token or test the Graph API.
> For a real FB token test, do a live run with a single short throwaway video.

---

## GitHub Actions workflow

The workflow triggers every 15 minutes via cron. The server itself enforces
the real upload gap via MongoDB state — the cron just wakes it up frequently
enough to not miss the window.

```yaml
on:
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:          # manual trigger from GitHub UI
```

`workflow_dispatch` lets you trigger a run manually anytime from the Actions tab.

---

## Multiple niches / parallel uploads

Each niche should have its own repo with its own secrets. This gives:
- Parallel uploads across niches (each runs on its own GitHub Actions runner)
- Fresh US-based IP per run per niche
- Independent scheduling and state

Setup is identical for each — same code, different secrets.

---

## Local / Colab usage

For local testing or running on Google Colab, use `start-uploader.sh` instead.
It bootstraps all dependencies and launches the server directly.

```bash
bash start-uploader.sh --configs movie-recaps.json --dry-run
```

Or create an `on-start.env` file (see `on-start.env.example`) and just run:

```bash
bash start-uploader.sh
```

---

## on-start.env (local/Colab only)

Copy `on-start.env.example` to `on-start.env` and fill in your values.
**Never commit this file** — add it to `.gitignore`.

```bash
# GDrive folder IDs
GDRIVE_SERVER_CONFIGS_ID=1aBcDeFgHiJkLmNoPqRsTuVwXyZ
GDRIVE_CLIENT_SECRETS_ID=1aBcDeFgHiJkLmNoPqRsTuVwXyZ
GDRIVE_CLIENT_TOKENS_ID=1aBcDeFgHiJkLmNoPqRsTuVwXyZ

# Which configs to process
UPLOADER_CONFIGS=config_name.json

# Min time between uploads in ms (1800000 = 30min)
UPLOADER_MIN_GAP=1800000

# UTC upload window (leave empty for anytime)
UPLOADER_WINDOW=13:00-23:00

# Set to true to simulate without uploading
UPLOADER_DRY_RUN=false

# Auto-restart after each run (Colab only)
UPLOADER_LOOP=true

# MongoDB URI (required for state persistence across runs)
MONGODB_URI=mongodb+srv://user:password@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
```

---

## Scheduling via cron-job.org (Recommended over GitHub Actions)

GitHub Actions scheduled workflows are unreliable for frequent intervals — runs can be delayed 30–60+ minutes or dropped entirely. [cron-job.org](https://cron-job.org) is a free, no-card-required alternative that triggers `workflow_dispatch` on your workflow directly via the GitHub API.

### Setup

**1. Create a GitHub Personal Access Token (PAT)**

Go to **GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)**

- Note: `Video Uploader`
- Expiration: No expiration (or your preference)
- Scopes: `repo`

**2. Create a cron-job.org account**

Go to [cron-job.org](https://cron-job.org) → sign up (free, no credit card)

**3. Create the cronjob**

- **Title:** Video Uploader
- **URL:** `https://api.github.com/repos/<your-username>/video-uploader/actions/workflows/uploader.yml/dispatches`
- **Request method:** `POST`
- **Request body:**
  ```json
  {"ref": "main"}
  ```
- **Headers** (click + ADD for each):
  - `Authorization` → `Bearer <your PAT>`
  - `Accept` → `application/vnd.github+json`
  - `Content-Type` → `application/json`
- **Schedule:** every 15 minutes — `*/15 * * * *`
- **Timeout:** 30 seconds
- **Notifications:** notify after 3 failures

**4. Remove the schedule trigger from your workflow**

Since cron-job.org handles scheduling, remove the `schedule:` block from your `.yml` to avoid double-triggering. Keep `workflow_dispatch`:

```yaml
on:
  workflow_dispatch:
```

**5. Test**

Hit **Run now** on the cron-job.org dashboard. A new `workflow_dispatch` run should appear in your GitHub Actions tab within seconds. cron-job.org shows the HTTP response — you want `204 No Content` which means GitHub accepted the trigger successfully.

---

## Troubleshooting

**`gdown failed: Cannot retrieve the public link`**
→ GDrive folder is not shared publicly. Right-click → Share → "Anyone with the link" → Viewer.

**`invalid_grant` on a drive**
→ OAuth token for that drive has expired. Re-authorize and update the token file in your client-tokens GDrive folder.

**`no such file or directory: token.json`**
→ Token file is missing from the client-tokens zip. Add it and re-upload the zip to GDrive.

**`No valid configs loaded`**
→ `UPLOADER_CONFIGS` secret is wrong, or the config filename doesn't match what's in the server-configs zip.

**Video uploaded but thumbnail missing**
→ Channel is not verified on YouTube. Thumbnail uploads require a verified channel.

**`All configs processed — no upload this cycle`**
→ Either min-gap hasn't passed yet, outside upload window, or no zip files found in Drive.

**`FB init failed (400)`**
→ Page access token is invalid or expired. Re-generate via Graph API Explorer (see Facebook setup above).

**`FB transfer failed`**
→ Usually a file size or Content-Length mismatch. Check the video file isn't corrupted in the zip.

**FB Reel published but description is truncated**
→ Expected — description body is capped at 500 chars to comply with Reels limits. UNIV tag is always preserved in full.

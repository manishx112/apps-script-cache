# Store JSON in Google Drive (free 15 GB, no card)

After this setup, every source gets its own folder with exactly one JSON file. Each refresh **overwrites that
same file** (same file id), so old copies never pile up — and if the data has not changed, nothing is uploaded at all.

```
My Drive
└─ Apps Script Cache                          ← created automatically
   ├─ Packing performance dashboard
   │  └─ Packing performance dashboard.json
   └─ Sales dashboard
      └─ Sales dashboard.json
```

MongoDB keeps only the source list, status, logs and each file's Drive id, so it stays small.
Your links (`/d/<token>`) don't change — the Worker reads the file from Drive and returns it as JSON.

> The app can only see files **it created** (Google scope `drive.file`), never the rest of your Drive.
> That is also why it creates its own "Apps Script Cache" folder — a folder you made by hand is invisible to it,
> so you can delete that one.

---

## Part 1 — Google Cloud (one time, ~10 min, no card needed)

1. Open **https://console.cloud.google.com** and sign in with the Google account whose Drive you want to use.
2. Top bar → project picker → **New project** → name `apps-script-cache` → **Create** → then select that project.
3. Search bar → type **Google Drive API** → open it → **Enable**.
4. Left menu → **Google Auth Platform** (older name: *APIs & Services → OAuth consent screen*) → **Get started**:
   - App name: `Apps Script Cache`, User support email: your email → **Next**
   - Audience: **External** → **Next**
   - Contact email: your email → **Next** → tick agree → **Create**
5. **Audience** (left menu) → under *Publishing status* click **Publish app** → **Confirm**.
   ⚠️ Important: if it stays in "Testing", Google stops the access after **7 days**.
6. **Clients** (left menu) → **Create client**:
   - Application type: **Desktop app**
   - Name: `apps-script-cache` → **Create**
   - Copy the **Client ID** and **Client secret** shown.

## Part 2 — Connect (one time, ~2 min)

1. Open `E:\apps-script-cache\.env` and fill only these two lines (keep the quotes):
   ```
   GOOGLE_CLIENT_ID='1234567890-abc...apps.googleusercontent.com'
   GOOGLE_CLIENT_SECRET='GOCSPX-...'
   ```
   Save (Ctrl+S). Leave `GOOGLE_REFRESH_TOKEN` and `GOOGLE_DRIVE_FOLDER_ID` empty — the next step fills them.
2. In the terminal:
   ```powershell
   cd E:\apps-script-cache
   npm run google:connect
   ```
3. A browser tab opens → choose your Google account.
   If you see **"Google hasn't verified this app"** → click **Advanced** → **Go to Apps Script Cache (unsafe)** →
   **Continue**. (It's your own app, so this is expected.)
4. Click **Allow** / **Continue**. The tab says ✅ *Google Drive connected*.
5. The terminal shows:
   ```
   ✔ Google account connected.
   ✔ Drive folder ready: https://drive.google.com/drive/folders/…
   ✔ Saved to .env
   ✨ Success! Uploaded secret GOOGLE_CLIENT_ID   (… and 3 more)
   ✔ Done!
   ```

## Part 3 — Deploy the new code

```powershell
git push
```
Cloudflare builds and deploys it (1–2 min). Then open a source and click **Refresh now** — a
`<name>.json` file appears in the Drive folder, and the source page shows **Open JSON file in Google Drive**.
Other sources move to Drive on their next scheduled refresh.

---

## Good to know

| Question | Answer |
|---|---|
| Speed? | Reading from Drive takes ~0.5–1.5 s, but links are cached for 60 s, so most calls stay instant. |
| Rename a source? | Its Drive folder and file are renamed too. |
| Delete a source? | Its Drive folder goes to Drive's **Trash** (recoverable for 30 days). |
| Deleted a file or folder in Drive by mistake? | The next refresh creates it again. |
| "Google sign-in failed … invalid_grant" in the logs? | Access was removed or expired → run `npm run google:connect` again. |
| Turn Drive off? | Cloudflare → Settings → Variables and Secrets → delete `GOOGLE_REFRESH_TOKEN`. Data goes back to MongoDB on the next refresh. |
| Later move to Cloudflare R2? | Only `worker/src/drive.ts` needs an R2 version; links and the dashboard stay the same. |

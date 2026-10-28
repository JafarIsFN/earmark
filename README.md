# Earmark

An MP3 player for your iPhone that works offline:

- **+30s and −10s** buttons, in the app and on the lock screen when iPhone shows them
- **Bookmarks** with optional notes. Tap a bookmark to jump back to that spot.
- **Any playback speed** from 0.25× to 4×: type an exact value like 1.37, nudge by 0.05, or drag the slider. Save the speeds you like as presets.
- **Picks up where you left off** in every file, and moves on to the next file when one ends (handy for audiobooks split into parts)
- **Your MP3s are saved on your phone** after you add them once. Nothing is uploaded anywhere.

---

## 1. Put it online with GitHub Pages (about 10 minutes, one time)

1. Go to <https://github.com/signup> and make a free account.
2. Click the **+** at the top right, then **New repository**.
   - Repository name: `earmark`
   - Choose **Public** (free GitHub Pages needs this; only the app's code is public, never your MP3s or bookmarks)
   - Click **Create repository**.
3. On the next page, click the link that says **uploading an existing file**.
4. Open the `earmark` folder on your Desktop. Select **everything inside it**, including the `icons` folder, and drag it into the browser window. Wait for all the files to finish uploading, then click **Commit changes**.
   - Check that the repository now shows an `icons` folder. If it doesn't, drag the `icons` folder in again by itself.
5. Click the **Settings** tab, then **Pages** in the left sidebar.
   - Under **Build and deployment**, set **Source** to **Deploy from a branch**.
   - Set **Branch** to **main** and the folder to **/ (root)**, then click **Save**.
6. Wait a minute or two and refresh the page. It will say **Your site is live at** `https://YOUR-USERNAME.github.io/earmark/`. That's your app's address.

## 2. Install it on your iPhone

1. Open your app's address in **Safari** (not Chrome).
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. Open Earmark **from the new Home Screen icon**, and add your MP3s from there.
   - Safari and the Home Screen app keep separate libraries, so files you add in a Safari tab won't show up in the icon version.

## 3. Get your MP3s onto the phone

Earmark picks files from the iPhone **Files** app. Easy ways to get them there from a Windows PC:

- **OneDrive:** put the MP3s in OneDrive on your PC, install the OneDrive app on your iPhone and sign in. OneDrive then shows up in the file picker under **Browse**. If you don't see it, tap **⋯**, then **Edit**, and turn OneDrive on.
- **iCloud Drive:** install iCloud for Windows and copy the MP3s into iCloud Drive.

Then in Earmark, tap **Add MP3s** and pick them. Earmark keeps its own copy, so they keep playing after you delete them from OneDrive or iCloud.

## 4. Check it works on your phone

- **Offline:** turn on Airplane Mode, open Earmark from the icon and play something.
- **Locked screen:** play something, lock the phone, and wait a few minutes. iPhone sometimes pauses web apps in the background. If audio stops while the phone is locked, that's an iOS limit, not a bug in your files.

---

## Good to know

- **Storage:** iOS can clear a web app's storage if the phone runs very low on space. If a file ever goes missing, add it again. Its bookmarks come back automatically because they're matched to the file.
- **Copy-protected audiobooks** (Audible, Apple Books purchases) can't be opened by any web app. Plain MP3s, M4A and M4B files without copy protection work.
- **Keyboard shortcuts on a computer:** Space plays or pauses, ← goes back 10s, → goes forward 30s, B adds a bookmark.

## Updating the app later

After changing any file, open `sw.js` and change `earmark-v1` to `earmark-v2` (then `v3`, and so on), and upload the changed files to GitHub the same way as before. Phones pick up the new version the next time Earmark opens, and show an **Earmark was updated** message with a Reload button.

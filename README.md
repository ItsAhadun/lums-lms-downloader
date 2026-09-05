# LUMS LMS Resource Downloader

Bulk-download an entire course's Resources from LUMS Sakai, keeping the folder structure,
with live per-file and overall progress.

Works on both LMS hosts:

- [lms.lums.edu.pk](https://lms.lums.edu.pk) — the live LMS
- [lmsarchive-2026.lums.edu.pk](https://lmsarchive-2026.lums.edu.pk) — the archive

They are separate Sakai installs with separate sign-ins, so the popup asks both and lists
their courses together, tagged by host. The in-page button works the same on either.

Works in **Chrome** and **Brave**.

---

## Always one ZIP

Anything with more than one file in it is delivered as **a single ZIP file**, with the
course's folder structure preserved inside. That means one save prompt for a whole course
instead of one per file — you can leave *Ask where to save each file* switched on and it
stays out of your way. There is no setting for this and nothing to configure: a folder, a
course, or any multi-file selection always arrives as one archive.

Selecting a single file downloads that file directly rather than wrapping one PDF in a
ZIP. Either way the download **keeps going after you close the LMS tab**.

Archives are built one at a time. Queue three courses and they run in order.

---

## Install

Not on the Chrome Web Store, so it installs unpacked. Needs **Chrome or Brave 116 or
newer**. Takes about a minute.

1. Download the zip from the
   [latest release](https://github.com/ItsAhadun/lums-lms-downloader/releases/latest).
2. Unzip it into a folder you will keep. **The folder is the installed extension** — if you
   later move or delete it, the extension disappears from Chrome. Somewhere like
   `Documents\lums-downloader` is fine; inside Downloads is not.
3. Open `chrome://extensions` (or `brave://extensions`).
4. Turn on **Developer mode**, top right.
5. Click **Load unpacked** and pick the unzipped folder — the one with `manifest.json`
   directly inside it.

The LUMS Downloader icon appears in your toolbar. Pin it if Chrome hides it behind the
puzzle-piece menu.

### Updating

Unpacked extensions do not auto-update, in either browser. To upgrade: download the newer
zip, replace the contents of the same folder, then click the reload arrow on the
extension's card in `chrome://extensions`. Your settings are kept.

---

## Use it

**From a course:**

1. Open a course, then its **Resources** tool.
2. Click **⤓ Download all** in the tool's action bar.
3. Pick what you want in the pre-flight dialog — by folder, by file type, or file by file.
4. Click **Download**. A progress card appears in the bottom-right corner.

**One folder or one file:**

Open any row's **Actions** menu and choose **⤓ Download folder** or **⤓ Download**. This
skips the pre-flight dialog and starts immediately.

On a folder it takes **everything inside, including nested subfolders** — you do not need to
expand the folder first, and a collapsed folder works the same as an open one. Using it on
the top row downloads the whole course.

Files land in:

```
Downloads/LUMS LMS/<Course Title>/<original folders>/     (individual files)
Downloads/LUMS LMS/<Course Title>.zip                     (one ZIP)
```

Folder structure is always relative to the course root, so downloading just `Books/` still
puts its files under `<Course Title>/Books/`.

**From the toolbar popup:**

Click the extension icon to watch progress with the LMS tab closed, queue several courses
at once, or change settings. The list merges both hosts; if you are signed in to only one,
the other is named as such rather than silently left out. Courses queued from the popup
arrive as one ZIP each, the same as the in-page button. The toolbar badge shows overall
percentage while a job runs.

---

## Settings

Open the extension popup and expand **Settings**.

| Setting | Default | Notes |
|---|---|---|
| Root folder | `LUMS LMS/` | Prefix inside your Downloads folder — the archive lands in it too. Leave blank to drop it. |
| Concurrent downloads | 3 | 1–5. Higher risks throttling from Sakai. |
| Include hidden / unavailable items | off | Items the instructor has hidden or scheduled. |
| Save URL shortcuts as `.url` files | off | Sakai "web link" items. Skipped by default. |

---

## Behaviour worth knowing

- **Pause does not pause files already in flight.** The Sakai file endpoint sends
  `Accept-Ranges: none`, so a paused transfer cannot be resumed — it would restart from
  zero. Pause therefore stops starting *new* files and lets the current ones finish.
- **A failed file restarts from the beginning**, for the same reason. Each file gets up to
  3 attempts with a 1s / 4s / 10s backoff, in both delivery paths.
- **An expired session stops the whole job at once** rather than failing every remaining
  file three times over. Sakai answers an expired session with its login page — 200, and
  HTML — so the extension checks the content type on the archive path, and checks the size
  on disk against the manifest on the single-file path. Either way you get "your session has
  expired", naming the host to sign in to, instead of a folder full of 20 KB login pages
  named `Lecture 4.pdf`.
- **A stalled transfer is abandoned after 60 seconds** with no bytes, so one dead
  connection cannot hold a slot and freeze the progress bar.
- **Duplicate filenames** get `(1)`, `(2)` appended — by the browser on a single-file
  download, and by the archive writer inside a ZIP.
- **Long paths** are truncated to stay under Windows' limit in both modes, keeping the file
  extension.
- **ZIP has a hard 4 GB ceiling** (ZIP32 has no 64-bit offsets). The pre-flight dialog
  warns past 3.5 GB and refuses past 4 GB, so you find out before the download rather than
  three quarters of the way through it. Split the course by folder and download it in
  parts.
- **Retrying a partly-failed ZIP job** builds a second archive containing only the retried
  files. The ones that already succeeded are in the first archive and are not fetched again.

---

## Troubleshooting

**"Your LMS session has expired"** — sign in at the host the message names (the live LMS
and the archive have separate sessions) and click **Retry failed**.

**"No resources visible in this course"** — the course has no Resources you can access.
If you expected files, check whether they are hidden and enable *Include hidden items*.

**The button does not appear** — it only shows on the **Resources** tool, not on the course
home page. If the Sakai page itself looks broken in Brave, lower Shields for that host and
reload.

**Downloaded files are tiny and open as a login page** — this is now caught and reported as
an expired session rather than written to disk. If you still see it, open that LMS host in a
tab, confirm you are signed in, and retry.

**A semester's courses are missing from the popup** — they are probably on the other host.
Check the note under the course list: it names any host you are not signed in to.

---

## Development

```bash
node --test
```

Two suites, covering the parts that fail silently and offline:

- `test/paths.test.mjs` — filename sanitising, download-path construction, and archive
  entry-name uniquifying. A filename Chrome rejects stalls a job with only an "Invalid
  filename" error, so it is worth testing offline.
- `test/zip.test.mjs` — the ZIP writer, round-tripped through its own central directory.
  A wrong offset produces an archive that looks fine until someone tries to open it.

Package for distribution:

```bash
sh build.sh
```

### Adding an LMS host

Next year's archive is two edits, both of which must land together:

1. `ORIGINS` in `lib/sakai.js` — the list the popup asks and every API call is addressed
   against.
2. `manifest.json` — the host in `host_permissions` (so the popup and the archive builder
   may fetch it) and in the content script's `matches` (so the in-page button appears).

Nothing else names a host. The content script uses `location.origin`, jobs carry the origin
they came from, and item URLs out of the Sakai API are absolute, so downloading needs no
host knowledge at all. Adding to `ORIGINS` alone gets you a host the popup lists and cannot
read; adding to the manifest alone gets you a button on a host the popup never asks about.

### Layout

| File | Role |
|---|---|
| `background.js` | Service worker: job state, download queue, retries, badge |
| `offscreen.js` | Fetches and zips a course; owns the ZipWriter |
| `content.js` | Resources-page button, pre-flight picker, progress panel |
| `lib/sakai.js` | Sakai Entity Broker client, the LMS host list, response normalising |
| `lib/zip.js` | STORE-method ZIP writer (no dependencies) |
| `lib/paths.js` | Filename sanitising and path construction |
| `lib/progress.js` | Progress model shared by the panel, popup and badge |
| `popup.*` | Cross-course progress, course picker, settings |

`lib/*.js` contain no `import`/`export` on purpose: that makes each file valid both as a
classic script (content script, popup, offscreen document) and as an ES module (service
worker, `node --test`), so all four contexts share one copy without a bundler.

### Why an offscreen document

ZIP mode used to build the archive inside the LMS page, which meant closing the tab threw
it away. It now runs in an offscreen document, because a service worker has no
`URL.createObjectURL` and `chrome.downloads` needs a URL for the finished blob. The
document outlives both the tab and a napping worker, so the multi-file and single-file
paths finally share one queue, one job model, and one set of retry semantics.

The worker owns the job state of record; the document only fetches, zips and reports.
Offscreen documents may use `chrome.runtime` and nothing else, which is why the finished
blob URL goes back to the worker for the actual download.

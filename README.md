# LUMS LMS Resource Downloader

Take a whole course's Resources off LUMS Sakai in one go, folder structure intact, with
per-file and overall progress. Already keep a course in a folder of your own? Sync it and
collect only the files that folder is missing.

Two LMS hosts work:

- [lms.lums.edu.pk](https://lms.lums.edu.pk), the live LMS
- [lmsarchive-2026.lums.edu.pk](https://lmsarchive-2026.lums.edu.pk), the archive

LUMS runs these as separate Sakai installs with separate sign-ins. The popup asks both and
lists their courses together, tagged by host. The in-page button behaves the same on either.

Runs in **Chrome** and **Brave**.

---

## One ZIP per download

Pick more than one file and you get **a single ZIP**, the course's folders preserved
inside. One save prompt for a whole course beats one prompt per file, so you can leave
*Ask where to save each file* switched on. You configure none of this. A folder, a course,
any multi-file selection: one archive.

Pick a single file and you get that file. Close the LMS tab and the download **keeps
going** either way.

The extension builds one archive at a time. Queue three courses and they run in order.

---

## Install

The extension is not on the Chrome Web Store, so you install it unpacked. You need
**Chrome or Brave 116 or newer**. Budget a minute.

1. Download the zip from the
   [latest release](https://github.com/ItsAhadun/lums-lms-downloader/releases/latest).
2. Unzip it into a folder you will keep. **That folder is the installed extension.** Move
   it or delete it later and Chrome drops the extension. `Documents\lums-downloader` works
   well; inside Downloads does not.
3. Open `chrome://extensions` (or `brave://extensions`).
4. Turn on **Developer mode**, top right.
5. Click **Load unpacked** and pick the unzipped folder, the one holding `manifest.json`.

The LUMS Downloader icon shows up in your toolbar. Pin it if Chrome buries it behind the
puzzle-piece menu.

### Updating

Neither browser auto-updates an unpacked extension. Download the newer zip, replace the
contents of the same folder, then click the reload arrow on the extension's card in
`chrome://extensions`. Your settings survive.

---

## Use it

**From a course:**

1. Open a course, then its **Resources** tool.
2. Click **⤓ Download all** in the tool's action bar. **⇅ Sync folder** sits beside it and
   fetches only what a folder of yours is missing; see [Sync a folder](#sync-a-folder).
3. Pick what you want in the pre-flight dialog: by folder, by file type, or file by file.
4. Click **Download**. A progress card appears in the bottom-right corner.

**One folder or one file:**

Open any row's **Actions** menu and choose **⤓ Download folder** or **⤓ Download**. The
download starts at once, with no pre-flight dialog.

On a folder you get **everything inside, nested subfolders included**. Expanding the folder
first changes nothing, and a collapsed folder behaves like an open one. Use it on the top
row to take the whole course.

The extension writes files to:

```
Downloads/LUMS LMS/<Course Title>/<original folders>/     (a single file)
Downloads/LUMS LMS/<Course Title>.zip                     (one ZIP)
```

Paths stay relative to the course root, so taking `Books/` on its own still puts its files
under `<Course Title>/Books/`.

**From the toolbar popup:**

Click the extension icon to watch progress with the LMS tab closed, queue several courses
at once, or change settings. The list merges both hosts. Sign in to one host and the popup
names the other under the course list, so you can see what you are missing. Courses queued
here arrive as one ZIP each, same as the in-page button. The toolbar badge shows overall
percentage while a job runs.

---

## Sync a folder

Once a course lives in a folder on your machine, what you want next week is the three files
the instructor posted since, and nothing else.

Click **⇅ Sync folder** in the Resources tool, next to Download all. The sync page opens on
that course, so the only thing left to choose is the folder:

1. Pick the folder you keep it in. Chrome asks you to allow the extension to edit it.
2. The comparison runs on its own. You get a count of what the LMS has, what the folder
   already has, and a list of what is missing.
3. Click **Download missing files**. Each one lands in the folder, inside its LMS
   subfolder, which the extension creates when it has to.

The folder sticks to the course. Sync the same course again and it reconnects, compares and
shows you the answer, so the whole thing costs one click from the Resources page and one
more to fetch. A clean run re-checks the folder and settles on "everything is here".

**Sync folder** in the toolbar popup does the same job when no course page is open. It adds
one step, picking the course from the list.

The comparison runs one way. A file counts as already there when a file of that name turns
up anywhere under the folder you picked, at any depth. Your own notes, scratch folders and
past-semester material stay invisible to it, and a lecture you moved into a folder of your
own does not come back as a second copy. A file you renamed does come back, under its LMS
name.

The extension remembers which folder goes with which course. Chrome drops write access to a
folder when it restarts, so the first sync after a restart asks you to confirm the folder
with one click.

When it writes into your folder, each run makes one attempt per file. Compare again to
collect whatever failed. The ZIP route below uses the extension's usual three attempts.

Sync writes into a folder you chose, so `chrome.downloads` and the root-folder setting play
no part. The concurrency, hidden-items and web-link settings all apply.

### Brave takes one extra step

Brave turns off the File System Access API, so the page cannot write into your folder.
Comparing still works. Pick the folder and the missing files arrive as one ZIP called
`<Course Title> - missing files.zip`, which you extract over the folder to merge them.

To get files written into the folder on Brave, open `brave://flags`, search for **File
System**, enable that flag and restart Brave. Chrome and Edge need nothing.

Brave asks whether to "upload" the folder when you pick it. Nothing leaves your machine.
The page reads the list of filenames to work out what is missing, and it never opens the
files.

---

## Settings

Open the extension popup and expand **Settings**.

| Setting | Default | Notes |
|---|---|---|
| Root folder | `LUMS LMS/` | Prefix inside your Downloads folder. The archive goes there too. Leave blank to drop it. |
| Concurrent downloads | 3 | 1 to 5. Higher risks throttling from Sakai. |
| Include hidden / unavailable items | off | Items the instructor hid or scheduled. |
| Save URL shortcuts as `.url` files | off | Sakai "web link" items. Skipped by default. |

---

## Behaviour worth knowing

- **Pause leaves files already in flight alone.** The Sakai file endpoint sends
  `Accept-Ranges: none`, so a paused transfer cannot resume. It would restart from zero.
  Pause stops new files from starting and lets the current ones finish.
- **A failed file restarts from the beginning**, for the same reason. Each file gets 3
  attempts on a 1s / 4s / 10s backoff.
- **An expired session stops the whole job at once.** Sakai answers an expired session with
  its login page, at status 200, as HTML. On the archive path the extension checks the
  content type; on the single-file path it checks the size on disk against the manifest.
  You get "your session has expired" and the host to sign in to, in place of a folder of
  20 KB login pages named `Lecture 4.pdf`.
- **A stalled transfer gives up after 60 seconds** without bytes, so one dead connection
  cannot hold a slot and freeze the progress bar.
- **Duplicate filenames** get `(1)`, `(2)` appended: the browser does it on a single-file
  download, the archive writer does it inside a ZIP.
- **The extension truncates long paths** to stay under Windows' limit, keeping the file
  extension.
- **ZIP tops out at 4 GB** (ZIP32 has no 64-bit offsets). The pre-flight dialog warns past
  3.5 GB and refuses past 4 GB, so you learn this before the download starts. Split the
  course by folder and take it in parts.
- **Retrying a job that lost some files** builds a second archive holding the retried ones.
  Whatever already succeeded sits in the first archive, and the extension leaves it there.

---

## Troubleshooting

**"Your LMS session has expired"**: sign in at the host the message names, then click
**Retry failed**. The live LMS and the archive keep separate sessions.

**"No resources visible in this course"**: you have access to no Resources in that course.
If you expected files, they may be hidden. Turn on *Include hidden items*.

**The button does not appear**: it shows on the **Resources** tool, not the course home
page. If the Sakai page itself looks broken in Brave, lower Shields for that host and
reload.

**Downloaded files are tiny and open as a login page**: the extension catches this and
reports an expired session instead of writing the file. If one slips through, open that LMS
host in a tab, confirm your sign-in, and retry.

**A semester's courses are missing from the popup**: look on the other host. The note under
the course list names any host you have not signed in to.

---

## Development

```bash
node --test
```

Two suites cover the failures that surface no useful error, and they run offline:

- `test/paths.test.mjs`: filename sanitising, download-path construction, archive
  entry-name uniquifying. A filename Chrome rejects stalls a job behind one "Invalid
  filename" message, which is worth catching before a user hits it.
- `test/zip.test.mjs`: the ZIP writer, round-tripped through its own central directory. A
  wrong offset produces an archive that looks fine until someone opens it.

Package for distribution:

```bash
sh build.sh
```

### Adding an LMS host

Next year's archive takes two edits, and both must land together:

1. `ORIGINS` in `lib/sakai.js`, the list the popup asks and every API call addresses.
2. `manifest.json`: the host in `host_permissions`, so the popup and the archive builder
   may fetch it, and in the content script's `matches`, so the in-page button appears.

No other file names a host. The content script reads `location.origin`, jobs carry the
origin they came from, and item URLs out of the Sakai API are absolute, so the download
path needs no host knowledge. Edit `ORIGINS` alone and the popup lists a host it cannot
read. Edit the manifest alone and you get a button on a host the popup never asks about.

### Layout

| File | Role |
|---|---|
| `background.js` | Service worker: job state, download queue, retries, badge |
| `offscreen.js` | Fetches and zips a course; owns the ZipWriter |
| `content.js` | Resources-page buttons, pre-flight picker, progress panel |
| `sync.*` | The Sync folder page: folder picker, comparison, writing missing files |
| `lib/sync.js` | Deciding which of a course's files a folder already holds |
| `lib/sakai.js` | Sakai Entity Broker client, the LMS host list, response normalising |
| `lib/zip.js` | STORE-method ZIP writer (no dependencies) |
| `lib/paths.js` | Filename sanitising and path construction |
| `lib/progress.js` | Progress model shared by the panel, popup and badge |
| `popup.*` | Cross-course progress, course picker, settings |

`lib/*.js` carry no `import`/`export` on purpose. That keeps each file valid as a classic
script (content script, popup, sync page, offscreen document) and as an ES module (service
worker, `node --test`), so five contexts share one copy without a bundler.

### The offscreen document

ZIP mode used to build the archive inside the LMS page, so closing the tab threw the
archive away. It runs in an offscreen document now, because a service worker has no
`URL.createObjectURL` and `chrome.downloads` needs a URL for the finished blob. That
document outlives both the tab and a sleeping worker, which lets the multi-file and
single-file paths share one queue and one set of retry semantics.

The worker owns the job state of record. The document fetches, zips, and reports. Offscreen
documents may use `chrome.runtime` and nothing else, so the finished blob URL goes back to
the worker for the download itself.

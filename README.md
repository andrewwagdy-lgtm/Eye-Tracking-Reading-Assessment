# Beyond Correct Answers — Gaze-Based Reading Assessment (pilot build)

A working implementation of the system proposed in the talk: webcam-based gaze
capture during reading → heat map → answer-timestamp look-back match →
generated explanation. Three pieces:

| File | Role | Lives where |
|---|---|---|
| `index.html` | Calibration, gaze capture, fixation/regression detection, heat map, result screen | **GitHub Pages** (or any static https host) |
| `code.gs` | Serves the item bank, logs responses | **Google Apps Script**, bound to a Sheet |
| Google Sheet | Item bank (`ItemBank` tab) + response log (`Responses` tab) | Google Sheets |

`index.html` deliberately lives outside Apps Script. Apps Script web apps run
inside a sandboxed iframe, and browsers are inconsistent about granting
camera permission to iframed content — hosting the page yourself on GitHub
Pages (a top-level, https origin) avoids that entirely. The page then talks
to Apps Script only over the network, for item data and response logging.

## Tracking backend: MediaPipe Face Landmarker, not WebGazer

Earlier versions of this build used WebGazer.js. It's been replaced with
Google's **MediaPipe Face Landmarker** (Apache-2.0, actively maintained) plus
a small calibration model built specifically for this app. Why: WebGazer's
official maintenance ended, and it has a documented accuracy-degrades-over-
a-session problem from not handling head pose at all. Concretely, this app:

1. Extracts normalized **iris position within each eye socket** (a standard
   gaze-estimation feature — the same one an open-source reference
   implementation, RealEye's `webcam-eyetracker-light-open`, uses on top of
   the same MediaPipe model) plus a **head-position proxy** from the nose-tip
   landmark, every video frame.
2. During calibration, collects `(features, targetX, targetY)` samples at
   each of 13 known screen positions.
3. Fits its own small **ridge regression** (closed-form, implemented in
   plain JS — no extra library) from features → screen X and screen Y,
   using every sample collected across all 13 points at once.

Everything downstream of that — fixation detection, word clustering, heat
map, the generated explanation, Sheet logging — is **completely unchanged**
from the WebGazer version. It only ever consumed an `(x, y, t)` stream; it
doesn't know or care where that stream comes from.

**Honest limitation:** this uses eye-socket-relative iris position and a
raw head-position proxy, not a full 6-degree-of-freedom head-pose
correction from MediaPipe's facial transformation matrix. It's a genuine
improvement over WebGazer for translational head movement (leaning
side-to-side, forward/back), but not a complete fix for head *rotation*. If
you want to extend this further, `outputFacialTransformationMatrixes: true`
in the `FaceLandmarker.createFromOptions(...)` call in `initTracking()` is
where that data becomes available — decomposing it into pitch/yaw and adding
those as extra regression features would be the next step.

## 1. Set up the Google Sheet + script

0. **First, add an empty file named `.nojekyll` at the root of your GitHub
   repo** (same level as `index.html`; this repo's download already
   includes one — just make sure it actually gets pushed, since some Git
   GUIs hide dotfiles). GitHub Pages runs your repo through Jekyll by
   default, and Jekyll's static-file handling can silently drop the large
   binary tracking files this app needs (step 4 below) unless this file is
   present. This is the single most common reason tracking files 404 even
   after you've pushed them.
1. Create a new Google Sheet (any name).
2. **Extensions → Apps Script.** Delete the default `Code.gs` contents and
   paste in this project's `code.gs`.
3. In the Apps Script editor, select the `setupSheets` function from the
   function dropdown and click **Run**. Approve the permissions prompt. This
   creates the `ItemBank` and `Responses` tabs with headers, plus one sample
   item (the "committee" example from slide 4 of the talk).
4. Add more rows to `ItemBank` directly in the Sheet. Columns:
   `ItemID | Passage | Question | OptionA | OptionB | OptionC | OptionD | CorrectAnswer | Notes`
   — leave `OptionC`/`OptionD` blank for a two-choice item.
5. **Deploy → New deployment → select type: Web app.**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**, authorize again if asked, and copy the `/exec` URL.

## 2. Point the frontend at your deployment

In `index.html`, find:

```js
const CONFIG = {
  WEBAPP_URL: 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_EXEC_URL_HERE',
  ...
```

Replace the placeholder with the `/exec` URL from step 1.5.

## 3. Deploy to GitHub Pages

1. Push `index.html`, the `mediapipe-vision-wasm/` folder, **and
   `.nojekyll`** to your GitHub repo, all as siblings, at the repo root (or
   all three together in `/docs` if that's your Pages source). The
   `mediapipe-vision-wasm/` folder (~23MB) holds the tracking model's WASM
   runtime, self-hosted for the same reason the old `mediapipe/face_mesh/`
   folder was — a relative path only resolves correctly if it's actually
   there. If you're upgrading from an older version of this app, you can
   delete the old `mediapipe/face_mesh/` folder — it's no longer used.
2. Repo **Settings → Pages** → set the source branch/folder → save.
3. GitHub gives you a `https://<username>.github.io/<repo>/` URL — that's
   the link learners open. Because it's a real https origin (not an iframe),
   the browser's webcam permission prompt behaves normally.

Whenever you edit `WEBAPP_URL` or the item bank logic, re-push `index.html`
and GitHub Pages picks it up within a minute or two. Editing sheet rows in
`ItemBank` needs no redeploy — the page fetches it live on each load.

## How the pieces map to the talk

- **Calibration / accuracy check** (slide 9): 13-point calibration — each
  dot appears for 5 seconds (first 500ms discarded as a settle window),
  during which a training sample is added roughly every 120ms using the
  dot's exact center as ground truth — no clicking required. All samples
  from all 13 points are fit together in one regression at the end (see
  above), so there's no risk of later points crowding out earlier ones.
  Then a 5-location accuracy check (center + 4 quadrants, each with its own
  settle window before sampling) with a configurable pixel-error threshold
  and a recalibrate option.
- **Fixations, regressions, skips** (slides 10–12): a dispersion-threshold
  algorithm (`detectFixations`) groups raw gaze samples into fixations.
  Word clusters with no fixation are, by construction, skipped. A
  regression is counted when a fixation lands on an earlier cluster than
  the furthest point already reached.
- **Heat map** (slide 21): after each answer, word clusters are recolored
  by accumulated dwell time for that item — see below for why clusters,
  not individual words.
- **Timestamp match / look-back window** (slide 22): `LOOKBACK_WINDOW_MS`
  (default 8s) defines the window ending at the moment the learner clicks
  an answer; only gaze in that window drives the generated explanation.
- **Generated explanation** (slide 23): `classifyPattern()` in `index.html`
  is a transparent, rule-of-thumb classifier over the look-back window's
  fixation count, regression count, top-dwell phrase, and off-passage
  fraction — it labels a response *vocabulary slip*, *syntactic overload*,
  *disengagement/guess*, or *mixed/inconclusive*, matching the three
  signatures from slide 4. This is intentionally simple and inspectable,
  not a trained or validated model — see the caveat below.
- **Item-writer worklist** (slides 26–27): every response, including
  `TopDwellWord`, `RegressionCount`, and `GeneratedExplanation`, lands as a
  row in `Responses`. Pivot or filter that sheet by `ItemID` to see which
  items repeatedly produce hotspots — that's the aggregate worklist.

## Why the heat map highlights phrases, not single words

Webcam eye trackers typically have real-world accuracy in the 50-150px
range even after careful calibration — no amount of smoothing changes that,
since it's the tracker's actual error, not jitter that can be filtered out.
Individual words in a line of text often sit closer together than that,
especially at normal reading sizes, so word-level attribution was never
reliably achievable on this hardware, however well calibrated.

So the heat map maps fixations to **word clusters** (phrase-level regions)
instead of individual words. Each cluster is sized to be comfortably wider
than *this session's own measured accuracy-check error* — not a fixed
guess, but `Math.max(120px, accuracyErrorPx × 2)` (both numbers tunable via
`CLUSTER_WIDTH_FLOOR_PX` and `CLUSTER_WIDTH_ERROR_FACTOR` in `CONFIG`). A
session with a great accuracy check gets narrower, more word-like clusters;
a noisier session automatically gets wider ones — the resolution shown
honestly reflects what that session's tracking can actually support,
rather than presenting false word-level precision every time.

Everything downstream adjusted accordingly: the heat map colors a whole
cluster the same shade (so it reads as highlighted phrases, not isolated
single words), "top-dwell word" became "top-dwell phrase" in the UI and can
now be a few words, and a regression means jumping back to an earlier
*cluster*, not necessarily an earlier individual word. The `TopDwellWord`
column name in your Google Sheet was deliberately left as-is (renaming it
would require rebuilding the sheet via `setupSheets()`, which would wipe
your existing data) — just know it may now contain a short phrase rather
than a single word.

## Smoothing and jitter

The raw per-frame gaze signal is naturally noisy — every video frame's eye
feature estimate wobbles slightly even when your gaze is genuinely steady.
`GAZE_SMOOTHING_ALPHA` (default `0.25`) in `CONFIG` applies exponential
smoothing to every point during the reading task before it's stored or used
for fixation detection: each new point only moves `alpha` of the way toward
the raw reading, damping sudden spikes. Lower (e.g. `0.15`) means smoother
but more lag; `1` disables smoothing entirely. `FIXATION_DISPERSION_PX`
(default 70) is loosened somewhat from a "textbook" value to tolerate
whatever jitter smoothing doesn't fully remove.

A live gaze indicator (a small cyan dot, `#live-gaze-dot`) is left on by
default during calibration and reading — useful for directly watching
whether tracking is behaving reasonably. To turn it off, remove or hide the
`#live-gaze-dot` element, or simply ignore it.

## If tracking files 404, or the camera never starts

`index.html` checks for the tracking WASM runtime directly before starting
the camera, so you'll get a specific error naming the exact URL it expected
rather than a cryptic failure deep in a promise chain. If you see that
error:

1. **Is `.nojekyll` actually at your repo root, pushed?** The most common
   cause — Jekyll's build can drop binary asset files without it.
2. **Open the failing URL directly in a browser tab.** If it 404s there
   too, the file genuinely isn't published yet.
3. **Check the file is actually in your repo** at
   `github.com/<you>/<repo>/tree/main/mediapipe-vision-wasm` — all 5 files,
   as a sibling of `index.html`, not nested one level too deep.
4. **Confirm Settings → Pages** shows a recent successful deployment.
5. **Hard-refresh** (Ctrl/Cmd+Shift+R) — Pages' CDN caches for a few
   minutes after a new deploy.

If the WASM files load fine but the model itself fails, check your
browser's console for a fetch error against
`storage.googleapis.com/mediapipe-models/...` — that URL is fetched live
from Google's servers (by design, same as every official MediaPipe web
sample), so it needs a working internet connection at runtime, unlike the
self-hosted WASM runtime.

## Known limitations (worth reading before piloting)

- **Head pose isn't fully corrected.** See the "Tracking backend" section
  above — this is a real improvement over WebGazer for translational head
  movement, not a complete fix for head rotation.
- **Passage length / scrolling.** Word cluster positions are mapped to
  fixed on-screen coordinates. The passage container is capped at
  `max-height` so it doesn't scroll during reading; a passage that would
  overflow will be clipped instead of scrolling gaze-tracking out of sync.
  Keep passages short, or extend `buildWordClusters()`/`nearestClusterIndex()`
  to compensate for scroll offset if you need longer texts.
- **The classifier is a heuristic, not a validated model.** It's built to
  be transparent and directly tied to the raw stats, matching the honest
  framing in the talk (slide 18's accuracy caveat, slide 30's open
  questions) — treat its output as a discussion prompt for item review, not
  a certified diagnosis. `code.gs` includes a disabled `explainWithLLM_()`
  hook if you'd rather have a language model phrase the explanation from
  the same stats (add an `ANTHROPIC_API_KEY` script property to enable it).
- **Webcam accuracy varies** by lighting, camera quality, and seating —
  consistent with the evidence on slide 18. The accuracy-check screen and
  its configurable threshold exist specifically to catch a bad session
  before the learner starts reading.
- **This tracking backend is newer, less battle-tested code** than the
  WebGazer version had become after extensive iteration. Expect some
  back-and-forth debugging the first few times you pilot it, the same way
  the WebGazer version needed several rounds before it was reliable.
- **Privacy.** No video ever leaves the browser — only x/y gaze coordinates
  and timestamps are sent to Apps Script, and only after each answer. (The
  tracking *model* itself is fetched from Google's servers at startup, but
  no webcam frames are ever sent anywhere — all face/iris processing
  happens locally, in your browser.) Get informed consent before running
  this with real learners (the consent screen is a starting point, not a
  substitute for your institution's own process — see slide 30).

## The downloaded JSON file — what it is and what to do with it

At the end of a session, "Download this session's data (JSON)" saves every
response from that session to your computer — the same data that was (or
was meant to be) sent to your Google Sheet, plus the raw gaze points for
each item's look-back window (which aren't stored in the Sheet, to keep
rows manageable).

**In most cases, you don't need to do anything with it.** It exists as a
local safety net, not a required step — if `WEBAPP_URL` is configured
correctly and your `Responses` sheet already shows a row for each item, the
JSON is just a backup copy. Fine to archive it or delete it.

**When it's actually useful:**
- **The Sheet is missing rows** (network hiccup, wrong `WEBAPP_URL`, Apps
  Script quota, offline testing). The JSON is your only copy of that
  session's data in that case — keep it until you've confirmed the Sheet
  matches, or manually re-enter the missing rows from it.
- **You want the raw gaze points**, not just the summary stats. Each item
  in the file has a `rawGaze` array of `[x, y, t]` triples (screen pixel
  coordinates and milliseconds since the passage appeared) for the
  look-back window — useful if you want to re-run your own fixation
  detection, plot scanpaths, or otherwise analyze beyond what the app
  already computes.

**How to open/use it:**
- It's plain JSON — any text editor shows it readably.
- For quick inspection, drag it into a browser tab, or use `jq` if you have
  it: `jq '.' session.json`.
- For analysis, load it in Python:
  ```python
  import json, pandas as pd
  with open('gaze-session-XXXXXXXX.json') as f:
      data = json.load(f)
  df = pd.json_normalize(data, sep='_')  # gazeSummary_* columns, one row per response
  ```
  (`rawGaze` stays nested per row — flatten it separately if you need
  per-sample rows.)
- It generally is **not** meant to be imported straight into the Google
  Sheet — the Sheet already receives the same summary fields automatically
  during the session; re-importing would just duplicate rows.

## Testing without a webcam pilot

Open `index.html` locally (or on GitHub Pages), consent, and during
calibration just look toward each dot as best you can without much other
movement — the tracker will still produce a (rougher) gaze stream, and
every downstream piece (fixation detection, heat map, explanation, sheet
logging) will run end-to-end so you can verify the wiring before recruiting
learners.

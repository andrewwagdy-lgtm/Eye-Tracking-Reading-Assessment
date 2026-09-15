# Beyond Correct Answers — Gaze-Based Reading Assessment (pilot build)

A working implementation of the system proposed in the talk: webcam-based gaze
capture during reading → heat map → answer-timestamp look-back match →
generated explanation. Three pieces:

| File | Role | Lives where |
|---|---|---|
| `index.html` | Calibration, gaze capture (WebGazer.js), fixation/regression detection, heat map, result screen | **GitHub Pages** (or any static https host) |
| `code.gs` | Serves the item bank, logs responses | **Google Apps Script**, bound to a Sheet |
| Google Sheet | Item bank (`ItemBank` tab) + response log (`Responses` tab) | Google Sheets |

`index.html` deliberately lives outside Apps Script. Apps Script web apps run
inside a sandboxed iframe, and browsers are inconsistent about granting
camera permission to iframed content — hosting the page yourself on GitHub
Pages (a top-level, https origin) avoids that entirely. The page then talks
to Apps Script only over the network, for item data and response logging.

## 1. Set up the Google Sheet + script

0. **First, add an empty file named `.nojekyll` at the root of your GitHub
   repo** (same level as `index.html`; this repo's download already
   includes one — just make sure it actually gets pushed, since some Git
   GUIs hide dotfiles). GitHub Pages runs your repo through Jekyll by
   default, and Jekyll's static-file handling can silently drop the large
   binary MediaPipe files this app needs (step 4 below) unless this file is
   present. This is the single most common reason the tracking files 404
   even after you've pushed them.
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

1. Push `index.html`, the `mediapipe/` folder, **and `.nojekyll`** to your
   GitHub repo, all as siblings, at the repo root (or all three together in
   `/docs` if that's your Pages source). See the troubleshooting section
   below for why `.nojekyll` matters.
2. Repo **Settings → Pages** → set the source branch/folder → save.
3. GitHub gives you a `https://<username>.github.io/<repo>/` URL — that's
   the link learners open. Because it's a real https origin (not an iframe),
   the browser's webcam permission prompt behaves normally.

Whenever you edit `WEBAPP_URL` or the item bank logic, re-push `index.html`
and GitHub Pages picks it up within a minute or two. Editing sheet rows in
`ItemBank` needs no redeploy — the page fetches it live on each load.

## How the pieces map to the talk

- **Calibration / accuracy check** (slide 9): 9-point click calibration,
  then a 2.5s no-click accuracy check against a known on-screen target,
  with a configurable pixel-error threshold and a recalibrate option.
- **Fixations, regressions, skips** (slides 10–12): a dispersion-threshold
  algorithm (`detectFixations`) groups raw gaze samples into fixations.
  Words with no fixation are, by construction, skipped. A regression is
  counted when a fixation lands on an earlier word than the furthest point
  already reached.
- **Heat map** (slide 21): after each answer, word spans are recolored by
  accumulated dwell time for that item.
- **Timestamp match / look-back window** (slide 22): `LOOKBACK_WINDOW_MS`
  (default 8s) defines the window ending at the moment the learner clicks
  an answer; only gaze in that window drives the generated explanation.
- **Generated explanation** (slide 23): `classifyPattern()` in `index.html`
  is a transparent, rule-of-thumb classifier over the look-back window's
  fixation count, regression count, top-dwell word, and off-passage
  fraction — it labels a response *vocabulary slip*, *syntactic overload*,
  *disengagement/guess*, or *mixed/inconclusive*, matching the three
  signatures from slide 4. This is intentionally simple and inspectable,
  not a trained or validated model — see the caveat below.
- **Item-writer worklist** (slides 26–27): every response, including
  `TopDwellWord`, `RegressionCount`, and `GeneratedExplanation`, lands as a
  row in `Responses`. Pivot or filter that sheet by `ItemID` to see which
  items repeatedly produce hotspots — that's the aggregate worklist.

## If tracking hangs, or you see "t is not a function" / mediapipe 404s

WebGazer loads a MediaPipe face-mesh model for eye-region refinement, and
MediaPipe resolves its model/wasm files at paths *relative to your page*,
not to `webgazer.js`'s own origin. So it requests things like
`mediapipe/face_mesh/face_mesh.binarypb` against **your** site. `TFFacemesh`
is the only tracker this WebGazer build supports (an explicit
`.setTracker('TFFacemesh')` in `index.html` confirms this and silences a
harmless "Invalid tracker selection" console warning WebGazer logs if you
don't set one) — there's no lighter-weight tracker to fall back to that
skips this model.

`index.html` now checks for these files directly before starting the
camera, so instead of a cryptic "t is not a function" you'll get a specific
error naming the exact URL it expected. If you see that error, work through
this checklist in order:

1. **Is `.nojekyll` actually at your repo root, pushed?** This is the most
   common cause — Jekyll's build can drop the binary asset files below
   without it. Check `https://github.com/<you>/<repo>/blob/main/.nojekyll`
   exists (an empty file is fine).
2. **Open the failing URL directly in a browser tab** — the error message
   gives you the exact one it tried, e.g.
   `https://<you>.github.io/<repo>/mediapipe/face_mesh/face_mesh.binarypb`.
   If that alone 404s outside the app, the file genuinely isn't published
   yet — it's not an app bug.
3. **Check the file is actually in your repo** at
   `github.com/<you>/<repo>/tree/main/mediapipe/face_mesh` — all 7 files,
   as a sibling of `index.html`, not nested one level too deep (a common
   slip is pushing `your-repo/eyetracking-app/mediapipe/...` instead of
   `your-repo/mediapipe/...`).
4. **Confirm Settings → Pages** shows a recent successful deployment (not
   still building, not failed) and that it's building from the branch/folder
   you actually pushed to.
5. **Hard-refresh** (Ctrl/Cmd+Shift+R) — Pages' CDN caches aggressively for
   a few minutes after a new deploy.

## Known limitations (worth reading before piloting)

- **Passage length / scrolling.** Word positions are mapped to fixed
  on-screen coordinates. The passage container is capped at `max-height` so
  it doesn't scroll during reading; a passage that would overflow will be
  clipped instead of scrolling gaze-tracking out of sync. Keep passages
  short, or extend `nearestWordIndex()` to compensate for scroll offset if
  you need longer texts.
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
- **Privacy.** No video ever leaves the browser — only x/y gaze coordinates
  and timestamps are sent to Apps Script, and only after each answer. Get
  informed consent before running this with real learners (the consent
  screen is a starting point, not a substitute for your institution's own
  process — see slide 30).

## Testing without a webcam pilot

Open `index.html` locally (or on GitHub Pages), consent, and during
calibration just click each dot 5 times without much eye movement — WebGazer
will still produce a (rougher) gaze stream, and every downstream piece
(fixation detection, heat map, explanation, sheet logging) will run
end-to-end so you can verify the wiring before recruiting learners.

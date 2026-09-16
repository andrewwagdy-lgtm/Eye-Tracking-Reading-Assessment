/**
 * Beyond Correct Answers — Eye-Tracking Reading Assessment
 * Apps Script backend
 *
 * This script does three jobs:
 *   1. Serves the item bank (passages + comprehension questions) as JSON/JSONP
 *      so a page hosted anywhere (e.g. GitHub Pages) can read it without a
 *      Google login.
 *   2. Accepts a learner's gaze-annotated response and appends it to the
 *      "Responses" sheet.
 *   3. Optionally re-generates the plain-language explanation for a response
 *      server-side (kept identical to the client-side heuristic, so this is
 *      mainly a hook for swapping in a real LLM call later — see
 *      explainWithLLM_() below).
 *
 * WHY JSONP FOR READS, no-cors POST FOR WRITES
 * Apps Script Web Apps don't reliably send CORS headers, so a page on
 * github.io can't read a fetch() response from script.google.com. Two
 * standard workarounds, both used here:
 *   - doGet supports a `callback` parameter -> returns JSONP, which sidesteps
 *     CORS entirely (script tag injection, not fetch).
 *   - doPost is called from the client with `mode: "no-cors"`. The browser
 *     can't read the response, but the request still reaches the server and
 *     the sheet still gets the row. The client never needs to read a POST
 *     response, so this is fine.
 *
 * SETUP
 *   1. Create a Google Sheet with two tabs named exactly "ItemBank" and
 *      "Responses" (see HEADER constants below for the exact columns —
 *      run setupSheets() once from the Apps Script editor to create both
 *      tabs with headers and one sample row automatically).
 *   2. Extensions -> Apps Script, paste this file in as Code.gs.
 *   3. Deploy -> New deployment -> Web app.
 *        Execute as: Me
 *        Who has access: Anyone
 *   4. Copy the /exec URL into WEBAPP_URL in index.html.
 */

// ---- Sheet + column config -------------------------------------------------

const ITEM_SHEET_NAME = 'ItemBank';
const RESPONSE_SHEET_NAME = 'Responses';

// ItemBank columns, in order. wordCount is derived, not stored.
const ITEM_HEADERS = [
  'ItemID', 'Passage', 'Question',
  'OptionA', 'OptionB', 'OptionC', 'OptionD',
  'CorrectAnswer', 'Notes'
];

// Responses columns, in order.
const RESPONSE_HEADERS = [
  'Timestamp', 'SessionID', 'LearnerID', 'ItemID',
  'AnswerGiven', 'CorrectAnswer', 'IsCorrect',
  'AnswerTimeMs', 'LookbackStartMs', 'LookbackEndMs',
  'FixationCount', 'AvgFixationDurationMs', 'RegressionCount',
  'TopDwellWord', 'TopDwellMs', 'ClassificationLabel',
  'GeneratedExplanation', 'RawGazeJSON'
];

// ---- Entry points -----------------------------------------------------------

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const action = params.action || 'getItems';

  let payload;
  try {
    if (action === 'getItems') {
      payload = { ok: true, items: getItemBank_() };
    } else if (action === 'getItem') {
      const item = getItemBank_().find(it => it.itemId === params.itemId);
      payload = item ? { ok: true, item: item } : { ok: false, error: 'Item not found: ' + params.itemId };
    } else {
      payload = { ok: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    payload = { ok: false, error: String(err) };
  }

  const json = JSON.stringify(payload);

  if (params.callback) {
    // JSONP path — used by the frontend to dodge CORS on reads.
    return ContentService
      .createTextOutput(params.callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const row = saveResponse_(body);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, row: row }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ---- Item bank ---------------------------------------------------------------

function getItemBank_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ITEM_SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + ITEM_SHEET_NAME + '" not found. Run setupSheets() once.');

  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const rows = values.slice(1).filter(r => r[0] !== '' && r[0] !== null);

  return rows.map(r => {
    const rec = {};
    headers.forEach((h, i) => { rec[h] = r[i]; });
    return {
      itemId: String(rec.ItemID),
      passage: rec.Passage,
      question: rec.Question,
      options: [rec.OptionA, rec.OptionB, rec.OptionC, rec.OptionD].filter(o => o !== ''),
      correctAnswer: rec.CorrectAnswer,
      notes: rec.Notes || ''
    };
  });
}

// ---- Responses -----------------------------------------------------------------

function saveResponse_(body) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RESPONSE_SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + RESPONSE_SHEET_NAME + '" not found. Run setupSheets() once.');

  const g = body.gazeSummary || {};
  const row = [
    new Date(),
    body.sessionId || '',
    body.learnerId || '',
    body.itemId || '',
    body.answerGiven || '',
    body.correctAnswer || '',
    body.isCorrect === true,
    body.answerTimeMs || '',
    g.lookbackStartMs || '',
    g.lookbackEndMs || '',
    g.fixationCount || 0,
    g.avgFixationDurationMs || 0,
    g.regressionCount || 0,
    g.topDwellWord || '',
    g.topDwellMs || 0,
    body.classificationLabel || '',
    body.generatedExplanation || '',
    JSON.stringify(body.rawGaze || [])
  ];
  sheet.appendRow(row);
  return sheet.getLastRow();
}

// ---- Optional: real LLM explanation instead of the client-side heuristic ------
//
// The client already generates a templated explanation (see explainGaze() in
// index.html) so the system works with zero external dependencies. If you
// want a large language model to phrase the explanation instead, add an
// API key in Project Settings -> Script properties as ANTHROPIC_API_KEY,
// then call explainWithLLM_(stats) from doPost before saveResponse_(). Left
// disabled by default so nothing here requires a paid key to run a pilot.

function explainWithLLM_(stats) {
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) return null;

  const prompt = 'You are annotating eye-tracking data from an EFL reading ' +
    'comprehension test for an item-writer audience. In 1-2 sentences, ' +
    'explain the likely cause of the learner\'s answer from this look-back ' +
    'window summary. Be concrete about the word/clause involved. Data: ' +
    JSON.stringify(stats);

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    }),
    muteHttpExceptions: true
  });

  const data = JSON.parse(res.getContentText());
  return data.content && data.content[0] ? data.content[0].text : null;
}

// ---- One-time setup helper -----------------------------------------------------

function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let items = ss.getSheetByName(ITEM_SHEET_NAME);
  if (!items) items = ss.insertSheet(ITEM_SHEET_NAME);
  items.clear();
  items.appendRow(ITEM_HEADERS);
  items.appendRow([
    'demo-committee-01',
    'The committee, despite reservations voiced by several members earlier in the meeting, approved the proposal.',
    'Did the committee approve the proposal?',
    'Yes', 'No', '', '',
    'Yes',
    'From Beyond Correct Answers, slide 4 — the illustrative item with three distinct wrong-answer gaze signatures.'
  ]);
  items.setFrozenRows(1);
  items.autoResizeColumns(1, ITEM_HEADERS.length);

  let responses = ss.getSheetByName(RESPONSE_SHEET_NAME);
  if (!responses) responses = ss.insertSheet(RESPONSE_SHEET_NAME);
  responses.clear();
  responses.appendRow(RESPONSE_HEADERS);
  responses.setFrozenRows(1);
  responses.autoResizeColumns(1, RESPONSE_HEADERS.length);

  SpreadsheetApp.getUi().alert('ItemBank and Responses sheets are set up, with one sample item.');
}

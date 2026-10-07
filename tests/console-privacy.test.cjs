const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { inspect } = require('node:util');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, 'MedicalLicenseFiller', file), 'utf8');
const SECRET = 'PRIVATE_SENTINEL';
const TOKEN = `${SECRET}_TOKEN`;
const NPI = '1999999999';
const URL = `https://example.test/application?provider=${SECRET}#${NPI}`;
const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));

// Capture every console method and every argument, including raw object references.
function captureConsole() {
  const calls = [];
  const console = new Proxy({}, {
    get: (_, method) => (...args) => calls.push({ method: String(method), args })
  });
  return { calls, console };
}

function assertPrivate(calls, values = []) {
  const output = inspect(calls, {
    depth: null, maxArrayLength: null, maxStringLength: null, customInspect: false
  });
  for (const value of [SECRET, TOKEN, NPI, URL, ...values]) {
    assert.ok(!output.includes(value), `Console exposed a protected value: ${value}`);
  }
  // Only these operational metadata fields may be sent as console objects.
  for (const { args } of calls) {
    for (const arg of args) {
      if (typeof arg === 'string') continue;
      assert.ok(arg && typeof arg === 'object' && !Array.isArray(arg));
      for (const [key, value] of Object.entries(arg)) {
        if (key === 'stage') assert.ok(['fetch', 'parse', 'match'].includes(value));
        else if (key === 'status') assert.ok(value === null || Number.isInteger(value));
        else {
          assert.ok(['fieldCount', 'filledCount', 'issueCount'].includes(key));
          assert.ok(Number.isInteger(value) && value >= 0);
        }
      }
    }
  }
}

function diagnostic(calls, method, fragment, metadata) {
  const entry = calls.find(call => call.method === method && call.args[0].includes(fragment));
  assert.ok(entry, `Missing ${method} diagnostic: ${fragment}`);
  if (metadata) assert.deepEqual(plain(entry.args[1]), metadata);
}

function sensitiveError() {
  const error = new Error(`${SECRET}: ${NPI} ${URL}`);
  error.cause = { token: TOKEN, row: [`${SECRET}_SSN`, `${SECRET}_DOB`] };
  return error;
}

function background(options = {}) {
  const capture = captureConsole();
  let listener;
  let installed;
  const storage = { errorLog: [], ...options.storage };
  const requests = [];
  const runtime = {
    lastError: options.authError,
    onMessage: { addListener: fn => { listener = fn; } },
    onInstalled: { addListener: fn => { installed = fn; } }
  };
  const context = vm.createContext({
    console: capture.console,
    chrome: {
      runtime,
      identity: { getAuthToken: (_, callback) => callback(options.noToken ? null : TOKEN) },
      storage: { local: {
        get: (_, callback) => callback(storage),
        set: (value, callback) => {
          Object.assign(storage, value);
          runtime.lastError = options.storageError;
          callback();
        }
      } }
    },
    fetch: async (...args) => {
      requests.push(args);
      if (options.fetch) return options.fetch(...args);
      return { ok: true, status: 200, json: async () => options.batch };
    }
  });
  vm.runInContext(read('background.js'), context, { filename: 'background.js' });
  return {
    ...capture, context, storage, requests, installed,
    request: message => new Promise(resolve => {
      assert.equal(listener(message, {}, resolve), true);
    }),
    logError: error => assert.equal(listener({ action: 'logError', error }, {}, () => {}), false)
  };
}

function rowFixture(context) {
  const columns = vm.runInContext('Object.entries(COLUMN_MAP)', context);
  const row = [];
  const expected = {};
  for (const [column, field] of columns) {
    let index = 0;
    for (const letter of column) index = index * 26 + letter.charCodeAt(0) - 64;
    const value = column === 'A' ? NPI : `${SECRET}_${column}_${field}`;
    row[index - 1] = value;
    expected[field] = value;
  }
  return { row, expected, batch: { valueRanges: [{ values: [[NPI]] }, { values: [row] }] } };
}

test('full configured row is returned intact but never reaches any console method', async () => {
  const options = {};
  const h = background(options);
  // Cover future configured fields beyond Z as well as every current provider field.
  vm.runInContext("COLUMN_MAP.AA = 'FutureProviderField'", h.context);
  const fixture = rowFixture(h.context);
  options.batch = fixture.batch;
  const response = await h.request({ action: 'fetchData', npi: NPI });
  assert.deepEqual(plain(response), { data: fixture.expected });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0][1].headers.Authorization, `Bearer ${TOKEN}`);
  diagnostic(h.calls, 'log', 'Provider mapping completed.', { fieldCount: 27 });
  const sheetId = vm.runInContext('SPREADSHEET_ID', h.context);
  assertPrivate(h.calls, [...fixture.row, sheetId, h.requests[0][0]]);
});

test('short and blank rows retain empty-field mapping behavior', async () => {
  const h = background({ batch: { valueRanges: [{ values: [[NPI]] }, { values: [[NPI, '', `${SECRET}_LAST`]] }] } });
  const response = await h.request({ action: 'fetchData', npi: NPI });
  assert.equal(response.data.LastName, `${SECRET}_LAST`);
  assert.equal(response.data.FirstName, '');
  assert.equal(response.data.SSN, '');
  assert.equal(Object.keys(response.data).length, 26);
  assertPrivate(h.calls);
});

test('unmatched lookup remains distinguishable without logging its NPI', async () => {
  const h = background({ batch: { valueRanges: [{ values: [] }, { values: [] }] } });
  assert.deepEqual(plain(await h.request({ action: 'fetchData', npi: NPI })), { data: null });
  diagnostic(h.calls, 'log', 'No matching provider found');
  assertPrivate(h.calls);
});

for (const [label, batch] of [
  ['absent ranges', {}], ['null response', null], ['null range', { valueRanges: [null, null] }],
  ['non-array values', { valueRanges: [{ values: SECRET }, { values: SECRET }] }]
]) {
  test(`invalid Sheets shape: ${label}`, async () => {
    const h = background({ batch });
    assert.deepEqual(plain(await h.request({ action: 'fetchData', npi: NPI })), { data: null });
    diagnostic(h.calls, 'warn', 'API response format unexpected');
    assertPrivate(h.calls);
  });
}

for (const row of [undefined, { value: SECRET }]) {
  test(`missing or invalid matched row retains mapping error diagnostic (${typeof row})`, async () => {
    const h = background({ batch: { valueRanges: [{ values: [[NPI]] }, { values: [row] }] } });
    assert.deepEqual(plain(await h.request({ action: 'fetchData', npi: NPI })), { data: null });
    diagnostic(h.calls, 'error', 'Provider mapping failed: matched data row is missing or invalid');
    assertPrivate(h.calls);
  });
}

for (const status of [400, 401, 403, 429, 500]) {
  test(`Sheets HTTP ${status} retains status and excludes response body/status text`, async () => {
    let bodyReads = 0;
    const h = background({ fetch: async () => ({
      ok: false, status, statusText: SECRET,
      json: async () => { bodyReads++; return { error: { message: SECRET, row: [NPI, TOKEN] } }; }
    }) });
    const response = await h.request({ action: 'fetchData', npi: NPI });
    assert.ok(response.error.includes(String(status)));
    assert.equal(bodyReads, 0);
    diagnostic(h.calls, 'error', 'Sheets API request failed', { status });
    diagnostic(h.calls, 'error', 'Data fetch failed');
    assertPrivate(h.calls);
  });
}

for (const stage of ['network', 'JSON']) {
  test(`${stage} failure retains stage without raw error, cause, stack or values`, async () => {
    const h = background({ fetch: async () => {
      if (stage === 'network') throw sensitiveError();
      return { ok: true, status: 200, json: async () => { throw sensitiveError(); } };
    } });
    assert.ok((await h.request({ action: 'fetchData', npi: NPI })).error);
    diagnostic(h.calls, 'error', stage === 'network' ? 'network request failed' : 'JSON parsing failed');
    assertPrivate(h.calls);
  });
}

for (const options of [{ authError: sensitiveError() }, { noToken: true }]) {
  test(`authentication failure is actionable and private (${options.noToken ? 'no token' : 'runtime error'})`, async () => {
    const h = background(options);
    assert.ok((await h.request({ action: 'fetchData', npi: NPI })).error);
    assert.equal(h.requests.length, 0);
    diagnostic(h.calls, 'error', 'Authentication failed. Check Google sign-in');
    assertPrivate(h.calls);
  });
}

for (const storageError of [undefined, sensitiveError()]) {
  test(`error-log messages never echo stored entries (${storageError ? 'failure' : 'success'})`, () => {
    const entry = { npi: NPI, message: SECRET, pageUrl: URL, nested: { token: TOKEN } };
    const h = background({ storageError, storage: { errorLog: Array(100).fill(entry) } });
    h.logError(entry);
    assert.equal(h.storage.errorLog.length, 100);
    assert.equal(h.storage.errorLog.at(-1), entry);
    diagnostic(h.calls, storageError ? 'error' : 'log', storageError ? 'Error saving error log' : 'Error logged.');
    h.installed({ reason: SECRET });
    assertPrivate(h.calls);
  });
}

async function content(options = {}) {
  const capture = captureConsole();
  let listener;
  const window = {
    location: { href: URL }, history: { pushState() {}, replaceState() {} },
    addEventListener() {}, dispatchEvent() {}
  };
  const context = vm.createContext({
    console: capture.console, window, Event: class {},
    document: { querySelector: options.querySelector || (() => null) },
    chrome: {
      runtime: { getURL: () => `chrome-extension://${SECRET}/mapping.json`, onMessage: { addListener: fn => { listener = fn; } } },
      storage: { local: { get: (_, callback) => callback({ currentPhysicianData: options.data }) } }
    },
    fetch: options.fetch || (async () => ({ ok: true, status: 200, json: async () => options.mappings || {} }))
  });
  vm.runInContext(read('contentScript.js'), context, { filename: 'contentScript.js' });
  await settle();
  return { ...capture, context, fill: () => new Promise(resolve => listener({ action: 'fillForm' }, {}, resolve)) };
}

for (const stage of ['fetch', 'http', 'parse', 'match']) {
  test(`mapping load ${stage} errors retain phase and HTTP status without raw errors`, async () => {
    const h = await content({ fetch: async () => {
      if (stage === 'fetch') throw sensitiveError();
      return { ok: stage !== 'http', status: stage === 'http' ? 404 : 200, statusText: SECRET,
        json: async () => {
          if (stage === 'parse') throw sensitiveError();
          return { [`[${SECRET}`]: {} }; // Invalid regex includes sensitive text.
        }
      };
    } });
    diagnostic(h.calls, 'error', 'Error loading mappings. Check mapping.json', {
      stage: stage === 'http' ? 'fetch' : stage,
      status: stage === 'fetch' ? null : stage === 'http' ? 404 : 200
    });
    assert.equal((await h.fill()).status, 'error');
    assertPrivate(h.calls);
  });
}

test('form-fill errors may contain every provider value but console only receives counts', async () => {
  const fixture = rowFixture(background().context);
  const mapping = Object.fromEntries(Object.keys(fixture.expected).map(field => [field, '#field']));
  const h = await content({
    data: fixture.expected, mappings: { '*': mapping },
    querySelector: () => ({ tagName: 'SELECT', options: [], getAttribute: () => 'dropdownlist' })
  });
  const result = await h.fill();
  assert.equal(result.status, 'success');
  assert.equal(result.filledCount, 0);
  assert.equal(result.issues.length, 26);
  assert.ok(result.issues.some(issue => issue.includes(fixture.expected.SSN)));
  diagnostic(h.calls, 'log', 'Form fill completed.', { filledCount: 0, issueCount: 26 });
  diagnostic(h.calls, 'warn', 'No Kendo widget available');
  assertPrivate(h.calls, fixture.row);
});

test('successful form filling still writes the requested value', async () => {
  const el = { tagName: 'INPUT', type: 'text', dispatchEvent() {} };
  const h = await content({ data: { FirstName: SECRET }, mappings: { '*': { FirstName: '#name' } }, querySelector: () => el });
  assert.deepEqual(plain(await h.fill()), { status: 'success', filledCount: 1, issues: [] });
  assert.equal(el.value, SECRET);
  diagnostic(h.calls, 'log', 'Form fill completed.', { filledCount: 1, issueCount: 0 });
  assertPrivate(h.calls);
});

test('missing field mappings retain a useful diagnostic', async () => {
  const h = await content();
  diagnostic(h.calls, 'log', 'No mappings for this URL');
  assert.equal((await h.fill()).message, 'No field mappings loaded.');
  assertPrivate(h.calls);
});

for (const injectionError of [undefined, sensitiveError()]) {
  test(`popup injection diagnostics exclude results and raw errors (${injectionError ? 'failure' : 'success'})`, () => {
    const capture = captureConsole();
    const elements = {};
    const element = id => elements[id] ||= {
      value: '', style: {}, appendChild() {}, append() {},
      addEventListener(event, fn) { this[event] = fn; }
    };
    const runtime = { sendMessage() {} };
    const context = vm.createContext({
      console: capture.console, window: { location: { href: URL } },
      document: {
        addEventListener: (_, fn) => fn(), getElementById: element,
        createElement: () => ({ append() {} })
      },
      chrome: {
        runtime,
        storage: { local: { get: (_, fn) => fn({ currentNpi: NPI }) } },
        tabs: { query: (_, fn) => fn([{ id: 1, url: URL }]), sendMessage: (_, __, fn) => fn({ status: 'success', filledCount: 0, issues: [] }) },
        scripting: { executeScript: (_, fn) => {
          runtime.lastError = injectionError;
          fn([{ result: { row: [SECRET, NPI], token: TOKEN } }]);
        } }
      }
    });
    vm.runInContext(read('popup.js'), context, { filename: 'popup.js' });
    element('fillForm').click();
    diagnostic(capture.calls, injectionError ? 'error' : 'log', injectionError ? 'Content script injection failed. Check page access' : 'Content script injected.');
    assertPrivate(capture.calls);
  });
}

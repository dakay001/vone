# vone

## Console privacy regression tests

Run with Node.js 24 or newer; no dependencies, credentials, browser, or network access are required:

```sh
node --test tests/console-privacy.test.cjs
```

The tests execute the extension scripts in isolated VM contexts with mocked Chrome,
DOM, fetch, and storage APIs. Every console method is captured. Synthetic values
cover all configured provider fields, an added future column, tokens, URLs,
response bodies, exception messages, and nested error objects.

Assertions check that data still maps and fills correctly, sensitive values never
reach console arguments, and HTTP status, failure phase, mapping warnings, and
fill counts remain available. GitHub Actions runs this suite on pushes and PRs.

Console diagnostics accept fixed messages and operational metadata only. Do not
log provider objects, NPIs, request/page URLs, authentication tokens, raw errors,
API bodies, or form-fill issue messages. The popup and existing local-storage
behavior are outside this console-only change. These mocked tests do not replace
an end-to-end check in Chrome against Google Sheets.

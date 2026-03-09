# Capture Harness

This harness now covers the Week 1 smoke scaffold and the Week 2 artifact contract for Bonsai Capture validation runs.

## Run

```bash
npm install
npx playwright install chromium
npm run build
npm run test:harness
```

## Environment

- `CAPTURE_EXTENSION_PATH`: optional path to the unpacked extension directory. Defaults to `dist/`.
- `CAPTURE_SMOKE_URL`: optional override for the target smoke URL. Defaults to `https://chatgpt.com/`.
- `CAPTURE_HEADLESS=false`: run headed for local debugging.

## Output

Each run creates `runs/run_<timestamp>/` and writes:

- `harness.log`
- `browser_har.har`
- `extension_console.log`
- `capture_raw.json`
- `capture_parsed.json`
- `checksums.txt`
- `reproduction.md`
- `performance.json`
- `stress_results.json`
- `certification.md`

The harness currently validates smoke-level navigation and emits the Week 2 run artifacts. Provider-specific login/bootstrap, export round-trip checks, and scale workloads still need dedicated suites.
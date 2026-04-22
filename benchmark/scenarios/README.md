# Scenario harness

Tiny, focused RLM scenarios that exercise ONE failure mode each. Each
scenario is < 60 seconds end-to-end when the model converges — the
point is fast iteration on the pipeline, not realistic apps.

## Layout

Each scenario is a directory with:

- `prompt.txt`   — the top-level task the RLM server receives
- `meta.json`    — metadata (name, description, expected outcome)

Use `run-scenarios.ts` to drive them.

## Running

```
npx tsx benchmark/scenarios/run-scenarios.ts           # all scenarios
npx tsx benchmark/scenarios/run-scenarios.ts add-two   # just one
RLM_PORT=4000 npx tsx benchmark/scenarios/run-scenarios.ts
```

The harness hits the running RLM server, writes a response file per
scenario, and prints pass/fail + duration.

## Adding a scenario

Pick a failing pattern from an earlier run. Make it minimal:

1. New dir under `scenarios/`.
2. `prompt.txt` states one task. Keep it under 5 lines.
3. `meta.json` names the scenario and — if you can — describes the
   specific pipeline stage / bug class it pokes at.
4. Run the harness against the current server and capture the baseline.

Rule of thumb: if the scenario takes more than 2 minutes to converge,
shrink it.

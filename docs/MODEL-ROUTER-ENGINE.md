# Codex advisory bridge for Model Router Engine

`scripts/model-router-advisory.mjs` lets a Codex window ask the independent
[Model Router Engine](https://github.com/shiftshen/model-router-engine) for a
model recommendation. It only prints a recommendation. It never edits Codex's
model, window, configuration, or route table.

## Inputs

Pass four explicit paths:

1. `--engine`: the engine checkout's `bin/model-router-engine.mjs`.
2. `--catalog`: a Model Router generated `model-catalog.json` from the target
   Codex window. Only listed `models[].slug` values are eligible; hidden aliases
   are excluded.
3. `--candidates`: a separate, reviewed JSON snapshot containing only models
   with evidence that they are qualified for the declared capabilities and that
   their credential group is active. Its IDs must equal catalog slugs exactly.
   The bridge never reads credentials to infer this status.
4. `--profile`: a structured JSON task profile. Do not put a prompt, source
   text, project data, token, or credential in this file.

The capability snapshot has the following shape. Use actual catalog slugs and
verified model facts for your installation:

```json
{
  "candidates": [{
    "id": "your-catalog-slug",
    "modelId": "upstream-model-id",
    "provider": "your-provider",
    "capabilities": ["coding"],
    "modalities": ["text"],
    "languages": ["en"],
    "contextWindow": 32000,
    "maxOutput": 4000,
    "costTier": 2,
    "latencyTier": 2,
    "privacy": "remote",
    "status": "qualified",
    "credentialStatus": "active"
  }]
}
```

```json
{
  "taskType": "code",
  "difficulty": "hard",
  "requiredCapabilities": ["coding"],
  "modalities": ["text"],
  "languages": ["en"],
  "contextRequirement": 12000,
  "outputRequirement": 3000,
  "privacy": "normal"
}
```

Run:

```sh
node scripts/model-router-advisory.mjs \
  --engine /path/to/model-router-engine/bin/model-router-engine.mjs \
  --catalog /path/to/codex-window/model-catalog.json \
  --candidates /path/to/qualified-candidates.json \
  --profile /path/to/task-profile.json
```

Output is a single JSON object with `mode: "advisory"`, `status`, `selected`,
and `provenance`. A successful `selected.id` is an exact, visible Codex catalog
slug from the snapshot. `selected.modelId` is the upstream model ID and may
differ from the slug. If the catalog, candidate proof, engine call, or returned
selection is invalid, `selected` is `null` and the command exits nonzero for
input or engine errors. No model switch occurs.

The bridge passes only allowlisted profile and candidate fields to the engine.
It does not inspect Codex `config.toml`, session prompts, API keys, or routing
credentials. The engine can use local Laya Typed-Decisions as primary and Jev as
fallback when their runtimes are configured; provenance shows which made the
decision. The separately measured Laya checkpoint had low confidence on the
broader routing benchmark, so this integration remains advisory until task
specific quality is established.

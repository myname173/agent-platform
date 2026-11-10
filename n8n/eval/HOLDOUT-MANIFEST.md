# Private holdout manifest

- file: eval-private/holdout-v1.json (OUTSIDE the public repo; this manifest is the only tracked trace)
- sha256: f1d8fe6f628381fd4e02e23c1758a3540a687f8c35e25e9d7fc4f05e304813f1
- cases: 20  (kb 3 / tools 4 / todos 3 / reminders 2 / docs 2 / memory 1 / mcp 1 / people 1 / security 3)
- rotation: quarterly; next rotation 2027-01-10; rotate immediately if any content leaks into a public surface
- usage: release gate + quarterly re-score ONLY; never referenced in prompts; never used for development iteration
- validate: node n8n/scripts/eval-validate.mjs does NOT read this dir (by design); score with eval-run --suite holdout-v1 after copying locally

# Glyph Cluster comparison attempt — 23 October 2026

The requested comparison could not run because the current Vercel key does not
have access to `stealth/glyph-cluster`.

The first request returned **HTTP 403**, `no_providers_available`, explaining
that Glyph requires an active Pro plan with purchased Gateway credits, or an
Enterprise plan. A second minimal diagnostic request confirmed the same access
restriction. Neither returned a model answer. The tracked evaluation reservation
was rejected with **$0 charged**; no Qwen comparison batch was started and no
production model or automatic matching setting was changed.

Vercel currently lists Glyph as free during its stealth period. Free inference
does not remove its account eligibility requirement. Vercel also says the
provider retains prompts and outputs. The test uses only public store text.

Sources:

- [Vercel announcement and eligibility](https://vercel.com/changelog/glyph-cluster-is-now-available-in-stealth-for-free-on-ai-gateway)
- [Glyph capabilities and retention](https://vercel.com/ai-gateway/models/glyph-cluster)

## Ready-to-run bounded comparison

After an eligible key is configured privately through the existing Gateway
setting, run:

```sh
npm run matching:compare-models -- --paid
```

This launcher uses only the dedicated matching evaluation database. It does not
reset products or run the production matching campaign. The production request
layer refuses experimental model overrides outside that database.

The fixture defines 12 literal reading checks before making calls: diaper counts
versus size, granola, brand position, bath wash, multipack ice cream, wafers,
legacy punctuation/model codes, hair colour number, cup counts, dog food and
decimal volumes. Each model receives the same source, store guidance, requested
fields and JSON instructions, with low reasoning and a 3,072-token output cap.
Requests alternate model order. This is an extraction diagnostic, not an estimate
of whole-database matching accuracy or a blind evaluation set.

Glyph lacks strict structured output support, so the common comparison asks for
JSON in the prompt and validates it afterward. Qwen's production structured-output
integration stays intact. Both outputs must pass the same schema, literal quote,
allowed-field and numeric-unit checks. The report retains raw and validated facts,
rejected evidence, correctness per field, latency, actual charge and cache usage.
The existing evaluation allowance, reservations, caching and adapter logs apply.
Stop on a first-sample provider failure rather than spending on an unusable model.

Output: `.data/model-comparison/glyph-vs-qwen.json`. The current output contains
the access failure, not an accuracy score. **There is no evidence yet that Glyph
is better or worse than Qwen for this task.**

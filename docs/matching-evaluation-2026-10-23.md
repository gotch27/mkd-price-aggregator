# Vercel matching test — 23 October 2026

**The Gateway integration works, but the current matching workflow is not ready for production.**

This was a bounded evaluation in the isolated `catalog_matching_test` database. The expected answers were fixed from the reviewed real-store list before provider calls. All 20 proposed groups (70 store entries) and eight deliberate non-matches (including three extra source records) were included: 73 store products, 101 positive pair relationships and eight negative comparisons. These are selected diagnostic examples, not an untouched random benchmark or a general accuracy estimate. Source-text review established the expected labels; barcodes were unavailable on these records.

## Results

| Measure | Result |
| --- | --- |
| Expected pair connections formed | 17 / 101 |
| Expected pair connections missed | 84 |
| Wrong connections among reviewed non-matches | 0 |
| Additional unexpected cross-group connections | 0 |
| Deliberate non-matches kept separate | 8 / 8 |
| Complete expected groups formed | 0 / 20 |
| Expected counterpart pairs returned by initial candidate search, in at least one direction | 99 / 101 |
| Provider HTTP/transport failures | 0 |
| Remaining pending, running or deferred work at completion | 0 |
| Reported total Gateway charge | **$0.009850730000** (about one US cent) |
| Test allowance | $0.25 |

The 17 pair relationships are contained in four partial groups. They do not mean 17 complete shared products. All accepted connections came from deterministic exact-signature rules; the AI path added no accepted connections. There were nine group-expansion connections producing 17 pair relationships.

## Provider usage

| Model / endpoint | Paid requests | Input tokens | Output tokens | Reported charge |
| --- | --- | --- | --- | --- |
| alibaba/qwen3.7-flash / /v1/chat/completions | 40 | 23944 | 7677 | $0.001716330000 |
| perplexity/pplx-decider-v1.2 / /v1/evaluate | 221 | 406720 | 575 | $0.008134400000 |

All 261 usage records finished with successful, provider-reported billing. There are no uncertain or outstanding reservations. Calls include classification, batches of candidate questions and targeted clarification; they are not 261 distinct products.

## Expected groups versus actual connections

| # | Expected shared product | Expected stores | Stores actually connected | Stores remaining separate | Pair connections |
| --- | --- | --- | --- | --- | --- |
| 1 | Coca-Cola regular, single 330 ml can | 7 | Reptil + Ramstore + Vero + Dim + Žur | KAM, SPAR | 10 / 21 |
| 2 | Coca-Cola Zero, single 330 ml can | 5 | SPAR + Ramstore + Vero | Reptil, Žur | 3 / 10 |
| 3 | Coca-Cola regular, 6 × 330 ml cans | 4 | None | KAM, Reptil, SPAR, Žito | 0 / 6 |
| 4 | Nutella spread, 400 g | 4 | None | KAM, Reptil, SPAR, Vero | 0 / 6 |
| 5 | Nutella spread, 750 g | 4 | None | Stokomak, Ramstore, Reptil, Žito | 0 / 6 |
| 6 | Plazma regular whole biscuits, 300 g | 4 | None | Ramstore, Reptil, Vero, Žito | 0 / 6 |
| 7 | Plazma ground biscuits, 300 g | 4 | None | KAM, Stokomak, Reptil, Vero | 0 / 6 |
| 8 | Plazma Mini Mini biscuits, 200 g | 4 | None | KAM, Reptil, Vero, Žito | 0 / 6 |
| 9 | Nescafé Classic, 200 g tin | 4 | Ramstore + SPAR + Žito | Vero | 3 / 6 |
| 10 | Nescafé Classic, 150 g refill bag | 4 | SPAR + Ramstore | Stokomak, Žur | 1 / 6 |
| 11 | Nivea Creme Care shower gel, 250 ml | 3 | None | Ramstore, Vero, Žur | 0 / 3 |
| 12 | Nivea Creme Soft shower gel, 250 ml | 3 | None | SPAR, Vero, Žur | 0 / 3 |
| 13 | Fairy lemon washing-up liquid, 450 ml | 3 | None | Vero, Žito, Žur | 0 / 3 |
| 14 | Fairy apple washing-up liquid, 900 ml | 3 | None | Reptil, Vero, Žito | 0 / 3 |
| 15 | Fairy Max Power lemon washing-up liquid, 545 ml | 2 | None | Reptil, Žur | 0 / 1 |
| 16 | Happy Day Family blueberry drink, 1 L | 3 | None | Ramstore, Vero, Žur | 0 / 3 |
| 17 | Vincini orange medenjaci, 150 g | 3 | None | Ramstore, SPAR, Žur | 0 / 3 |
| 18 | Bio Zen organic soy drink, 1 L | 2 | None | Dim, Žur | 0 / 1 |
| 19 | Garden Extra cornichons, 6–9 cm, 720 g | 2 | None | Dim, Žur | 0 / 1 |
| 20 | Malena Pink pencil, shade/model 707 | 2 | None | Žito, SPAR | 0 / 1 |

## Main problems found

1. **Equivalent brands are not normalized consistently.** The saved Qwen facts include `нутела` versus `nutella`, `бамби` versus `bambi`, and `малена` versus `malena`. Code currently treats these as different brands. Literal supporting quotes must be preserved, while comparable fact values need reviewed canonical aliases/transliteration.
2. **Product type values are free text and too literal.** Examples include `бисквити` versus `плазма кекс`, and `гел за туширање` versus `гел за туширање крем кер`. The same product is being rejected because one source uses a longer description or includes the product range in its type. Brand, type and variant need separate consistent values.
3. **The 0.99 threshold rejects many otherwise positive model answers.** Across 280 positive-candidate question attempts, the model selected same 269 times, but only seven attempts reached 0.99; those still failed supported-fact checks. These attempts repeat pairs and changed contexts, so 269/280 is not an independent accuracy score. Threshold changes need labeled development and fresh evaluation data, after fixing the fact representation.
4. **Clarification remains too fragile.** Fourteen unique products had clarification output rejected by source-evidence validation; repeated cache reuse produced 38 rejection log events. The source checks worked, but the supported extraction path needs improvement. Unknown categories and missing required facts also prevent otherwise obvious source-text matches.
5. **Two known counterparts were missed by initial retrieval.** Both involve the longer Stokomak Nutella 750 g name. Reviewed brand aliases and retrieval routes need to cover that spelling before measuring against the full catalog.

## Test-harness correction

The first pass stopped after the initial work, leaving 45 neighbor follow-ups unassigned to its campaign. The evaluator now attaches these scoped follow-ups to the same campaign and spending allowance, then completes the campaign after draining them. The original first-pass report was saved. This live run continued without truncating the database, resetting billing or discarding completed decisions. It processed 97 follow-up work items, including further wake-ups; all 73 final work records are completed. The final connection counts did not change.

## Next development work

Normalize supported fact values consistently while retaining original source evidence; separate canonical product types from brands and variants; improve extraction and brand retrieval. Re-run this diagnostic set, then assess a fresh independently labeled sample with entire groups kept together. Avoid weakening conflict checks simply to improve this sample's score.

## Original source names

### 1. Coca-Cola regular, single 330 ml can

- **KAM:** ПИЈАЛОК КОКА КОЛА ЛИМЕНКА 330МЛ
- **SPAR:** KOKA KOLA 0.33L LIMENKA.
- **Reptil:** Coca Cola – Газиран сок лименка 0.33l
- **Ramstore:** КОКА КОЛА ЛИМЕНКА 0.33Л
- **Vero:** КОКА КОЛА 0.33Л ЛИМЕНКА
- **Dim:** КОКА КОЛА ЛИМЕНКА 0.33Л
- **Žur:** КОКА КОЛА ЛИМЕНКА 0.33Л

### 2. Coca-Cola Zero, single 330 ml can

- **Reptil:** Coca Cola Zero – Газиран сок без шеќер лименка 330ml
- **SPAR:** KOKA KOLA 0.33L ZERO LIMENKA
- **Ramstore:** КОКА КОЛА ЗЕРО ЛИМЕНКА 0.33Л
- **Vero:** КОКА КОЛА ЗЕРО 0.33Л ЛИМЕНКА
- **Žur:** КОКА КОЛА ЗЕРО 330МЛ.ЛИМЕНКА

### 3. Coca-Cola regular, 6 × 330 ml cans

- **KAM:** ПИЈАЛОК КОКА КОЛА ЛИМЕНКА 330МЛ 6/1
- **Reptil:** Coca Cola – Газиран сок лименки сет 0.33l 6/1
- **SPAR:** KOKA KOLA 0.33L LIMENKA 6/1
- **Žito:** СЕТ КОКА КОЛА 330мл 6/1 МУЛТИПАК

### 4. Nutella spread, 400 g

- **KAM:** КРЕМ НУТЕЛА 400ГР
- **Reptil:** Nutella- еурокрем 400g
- **SPAR:** KREM NUTELA 400GR TEGLA
- **Vero:** КАКАО КРЕМ НУТЕЛА 400Г

### 5. Nutella spread, 750 g

- **Stokomak:** КРЕМ ЧОКОЛ. СО 13%ЛЕШНИК 750гр. НУТЕЛА
- **Ramstore:** НУТЕЛА 750 ГР
- **Reptil:** Nutella – Еурокрем 750g
- **Žito:** КРЕМ НУТЕЛА 750гр

### 6. Plazma regular whole biscuits, 300 g

- **Ramstore:** БАМБИ ПЛАЗМА КЕКС 300 ГР
- **Reptil:** Plazma – Бисквит кекс 300g
- **Vero:** БИСКВИТИ БАМБИ ПЛАЗМА 300Г
- **Žito:** КЕКС ПЛАЗМА 300гр БАМБИ

### 7. Plazma ground biscuits, 300 g

- **KAM:** КЕКС ПЛАЗМА 300ГР МЕЛЕНА
- **Stokomak:** ПЛАЗМА БИСКВИТ МЕЛЕН 300 ГР
- **Reptil:** Plazma – Мелени бисквити 300g
- **Vero:** БИСКВИТИ БАМБИ ПЛАЗМА МЕЛЕНА 300Г

### 8. Plazma Mini Mini biscuits, 200 g

- **KAM:** БИСК.БАМБИ ПЛАЗМА МИНИ МИНИ 200ГР
- **Reptil:** Plazma Mini Mini – Бисквит 200g
- **Vero:** БИСКВИТИ БАМБИ ПЛАЗМА МИНИ МИНИ 200ГР.
- **Žito:** КЕКС ПЛАЗМА БАМБИ 200гр МИНИ МИНИ

### 9. Nescafé Classic, 200 g tin

- **Ramstore:** НЕСКАФЕ КЛАСИК ЛИМЕНКА 200 ГР
- **SPAR:** NESKAFE 200GR LIMENKA KLASIK
- **Vero:** КАФЕ НЕСКАФЕ КЛАСИК 200Г ЛИМЕНКА
- **Žito:** НЕСКАФЕ КЛАСИК 200гр ЛИМЕНКА

### 10. Nescafé Classic, 150 g refill bag

- **Stokomak:** НЕСКАФЕ ИНСТАНТ КАФЕ КЛАСИК КЕСА 150гр
- **SPAR:** NESKAFE 150GR KESA KLASIK
- **Ramstore:** НЕСКАФЕ КЛАСИК КЕСА 150 ГР
- **Žur:** НЕСКАФЕ? КЛАСИК САЧЕТ 150ГР

### 11. Nivea Creme Care shower gel, 250 ml

- **Ramstore:** НИВЕА ГЕЛ ЗА ТУШИРАЊЕ КРЕМ КЕАР 250МЛ
- **Vero:** ГЕЛ ЗА ТУШИРАЊЕ НИВЕА КРЕМ КЕАР 250МЛ
- **Žur:** НИВЕА ГЕЛ ЗА ТУШИРАЊЕ КРЕМ КЕР 250МЛ

### 12. Nivea Creme Soft shower gel, 250 ml

- **SPAR:** GEL ZA TU[ NIVEA @ 250ML KREM SOFT550097
- **Vero:** ГЕЛ ЗА ТУШИРАЊЕ НИВЕА КРЕМ СОФТ 250МЛ
- **Žur:** НИВЕА ГЕЛ ЗА ТУШИРАЊЕ КРЕМ СОФТ 250МЛ

### 13. Fairy lemon washing-up liquid, 450 ml

- **Vero:** ДЕТЕРГЕНТ ЗА САДОВИ ФЕРИ ЛИМОН 450МЛ
- **Žito:** СРЕД ЗА САДОВИ ФЕРИ 450мл ЛИМОН
- **Žur:** ФЕРИ ЛИМОН 450МЛ

### 14. Fairy apple washing-up liquid, 900 ml

- **Reptil:** Fairy – Детергент за рачно миење садови јаболко 900ml
- **Vero:** ДЕТЕРГЕНТ ФЕРИ ЗА САДОВИ ЈАБОЛКО 900МЛ
- **Žito:** СРЕД ЗА САДОВИ ФЕРИ 900мл ЈАБОЛКО

### 15. Fairy Max Power lemon washing-up liquid, 545 ml

- **Reptil:** Fairy Max Power – Детергент за рачно миење садови лимон 545ml
- **Žur:** ФЕРИ Т.ДЕТЕРГЕНТ МАКС ПОВЕР ЛИМОН 545МЛ

### 16. Happy Day Family blueberry drink, 1 L

- **Ramstore:** ХЕПИ ДЕЈ ФЕМИЛИ БОРОВНИЦА 1Л
- **Vero:** ПИЈАЛОК ХЕПИ ДЕЈ ФЕМИЛИ БОРОВНИЦА 1Л
- **Žur:** ХЕПИ ДЕЈ ФЕМИЛИ БОРОВНИЦА 1Л ТЕТРАПАК

### 17. Vincini orange medenjaci, 150 g

- **Ramstore:** ВИНЧИНИ МЕДЕЊАЦИ ПОРТОКАЛ 150ГР
- **SPAR:** MEDEWACI VIN^INI 150GR PORTOKAL
- **Žur:** МЕДЕЊАЦИ ПОРТОКАЛ 150Г ВИНЧИНИ

### 18. Bio Zen organic soy drink, 1 L

- **Dim:** БИО ЗЕН?СОЈА НАПИТОК ОРГАНСКИ 1Л
- **Žur:** БИО ЗЕН?СОЈА НАПИТОК ОРГАНСКИ 1Л

### 19. Garden Extra cornichons, 6–9 cm, 720 g

- **Dim:** ГАРДЕН? КОРНИШОНИ ЕКСТРА 6-9ЦМ 720ГР
- **Žur:** ГАРДЕН? КОРНИШОНИ ЕКСТРА 6-9ЦМ 720ГР

### 20. Malena Pink pencil, shade/model 707

- **Žito:** МАЛЕНА ПИНК МОЛИВ 707
- **SPAR:** MALENA PINK MOLIV 707

## Explicit non-matches

| # | First record | Other record | Expected difference | Actual |
| --- | --- | --- | --- | --- |
| 1 | KAM: ПИЈАЛОК КОКА КОЛА ЛИМЕНКА 330МЛ | Reptil: Coca Cola Zero – Газиран сок без шеќер лименка 330ml | Regular versus Zero | Separate |
| 2 | Reptil: Coca Cola – Газиран сок лименка 0.33l | KAM: ПИЈАЛОК КОКА КОЛА ЛИМЕНКА 330МЛ 6/1 | Single can versus six-pack | Separate |
| 3 | KAM: КРЕМ НУТЕЛА 400ГР | Stokomak: КРЕМ ЧОКОЛ. СО 13%ЛЕШНИК 750гр. НУТЕЛА | 400 g versus 750 g | Separate |
| 4 | Ramstore: БАМБИ ПЛАЗМА КЕКС 300 ГР | Reptil: Plazma – Мелени бисквити 300g | Whole biscuits versus ground biscuits | Separate |
| 5 | Ramstore: НИВЕА ГЕЛ ЗА ТУШИРАЊЕ КРЕМ КЕАР 250МЛ | SPAR: GEL ZA TU[ NIVEA @ 250ML KREM SOFT550097 | Creme Care versus Creme Soft | Separate |
| 6 | Ramstore: НЕСКАФЕ КЛАСИК ЛИМЕНКА 200 ГР | Žito: НЕСКАФЕ 200гр КЛАСИК СТАКЛО | Tin versus glass jar, both 200 g | Separate |
| 7 | Dim: ГАРДЕН? КОРНИШОНИ ЕКСТРА 6-9ЦМ 720ГР | Žur: ГАРДЕН? КОРНИШОНИ ЕКСТРА 3-6ЦМ 720ГР | 6–9 cm versus 3–6 cm, both 720 g | Separate |
| 8 | Žito: МАЛЕНА ПИНК МОЛИВ 707 | SPAR: MALENA PINK MOLIV 701 | Shade/model 707 versus 701 | Separate |

## Reproduction and production guard

The approved fixture is saved at `tests/fixtures/real-store-matching-evaluation.json`. An explicit paid rerun uses `npm run matching:evaluate -- tests/fixtures/real-store-matching-evaluation.json --paid`; it resets only the disposable evaluation database and incurs new charges on cache misses. Existing local raw reports, source manifests and adapter logs are retained under `.data/matching-evaluation/`.

Production automatic matching and production Gateway calls remain disabled. The production database still has no migration-016 store-product table: no production migration, backfill, import or matching campaign was run. The isolated evaluation campaign is completed.

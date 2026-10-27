# Product names: readable display and model inputs

Audit date: 25 October 2026. The audit scanned all 191,049 unique products in active catalogs across all nine chains, including unavailable items. It checked original names for legacy glyphs, Cyrillic/Latin patterns, question marks, control characters, replacement characters, HTML escapes, and normalization stability. Representative names, categories, descriptions, and suspicious raw rows were inspected. No import or model request was needed.

## Findings by store

The change counts below describe the readable projection, not renamed source records. Latin brands and words may remain Latin deliberately.

| Store | Listed products checked | Readable names changed | Finding |
| --- | ---: | ---: | --- |
| KAM | 3,723 | 0 | Clean Cyrillic names; no decoding changes. |
| SPAR | 84,531 | 83,820 | Legacy Macedonian names; punctuation and Q/W/X/Y can encode letters. |
| Vero | 33,828 | 849 | Mostly Cyrillic, with a smaller legacy Latin subset and genuine apostrophes. |
| Dim | 6,260 | 576 | Cyrillic mixed with legacy glyphs; source question marks are retained. |
| Žur | 9,786 | 814 | Cyrillic mixed with legacy glyphs; source question marks are retained. |
| Ramstore | 23,486 | 5 | Five names use backticks as apostrophes, not ж. |
| Reptil | 5,773 | 77 | Genuine Latin brands plus Cyrillic descriptions; whitespace cleanup only. |
| Stokomak | 7,158 | 0 | Clean Cyrillic names; no decoding changes. |
| Žito | 16,504 | 0 | Clean Cyrillic names; no decoding changes. |

## One projection for the UI, search and AI

`nextsignal/domain/product-text.ts` is client-safe and owns the readable projection. Source fields remain exact. English brand apostrophes such as ``FISHERMAN`S`` and ``O`LYSEE`` remain apostrophes, including in KAM descriptions. The product lists, details, manual matching cards, classification results, correction dialog and matching history show readable names. Details show “Store name” underneath when it differs. Unclear source characters receive a compact warning in details. A source spelling is also available through the name's tooltip.

The character positions follow [JUS I.B1.003-mac / ISO-IR-147 in RFC 1345](https://www.rfc-editor.org/rfc/rfc1345.txt): `[ → Ш`, `^ → Ч`, `@ → Ж`, `] → Ќ`, backslash → Ѓ, `Q → Љ`, `W → Њ`, `X → Џ`, `Y → Ѕ`, with their lower-case equivalents. Context matters: `W` may be watts, `XL` a size, and `WELLA` a genuine brand. URLs, email addresses, bracket annotations, alphanumeric codes, units, dimensions, pack counts and sizes stay intact. Known encoded words are converted, not every Latin letter indiscriminately. Explicit joined prepositions such as `KOSTIMzaKAPEWE` are separated as `КОСТИМ за КАПЕЊЕ`. The English/Albanian category profile is separate from SPAR names; rare labels such as `SIREWE KRAVJO VAKUM` are still recognized as encoded Macedonian.

`product-name-words.json` contains 6,964 attested/reviewed Macedonian words. Its source vocabulary came from clean Cyrillic tokens in the saved KAM, Ramstore, Reptil, Stokomak, Vero and Žito names. Tokens needed at least five product occurrences, or three occurrences across at least two chains, and three letters; only words used in the SPAR/Vero Latin names were retained. Reviewed function words and the user's comb/brush example complete the list. Each word maps to its exact JUS encoding. Unknown foreign words remain unchanged. The dictionary is static and versioned with code; production imports do not silently teach or change it. It never supplies a missing brand, amount, flavour, category or match.

Examples:

- `2010 DETSKI SET ^E[EL I ^ETKA` → `2010 ДЕТСКИ СЕТ ЧЕШЕЛ И ЧЕТКА`.
- `SIREWE` → `СИРЕЊЕ`; `[OQA` → `ШОЉА`; `TENXERE` → `ТЕНЏЕРЕ`.
- `САКСИЈА ЗА ЦВЕ}Е` → `САКСИЈА ЗА ЦВЕЌЕ`.
- Ramstore ``Ф`СТАЦИ`` → `Ф'СТАЦИ`, without inventing a ж.
- Vero `NO@ICI ZA KUTIKULI FE0104` → `НОЖИЦИ ЗА КУТИКУЛИ FE0104`.

`requestProduct()` feeds classification, comparison and targeted clarification. It supplies `readable_name` and readable description/category fields when those differ, alongside the original fields. Updated store guides explicitly distinguish interpretation from original supporting quotes. Qwen quotes must still occur in the original source; a readable rewording cannot pass as literal source evidence. Rule-based family/type extraction uses readable words but retains original quotes. SPAR's `2H250ML` is accepted as a two-item pack only with an explicit amount/unit; `24H24SM` and model codes are not packs.

Search indexes use the readable spelling. Searching for either `SIREWE` or `СИРЕЊЕ` finds the product. Source fingerprints keep their existing algorithm, so this release does not create new product identities or reset matching memory. Readable-only interpretation fields do not invalidate saved categorization of the same source facts and prompt. The classification freshness key retains its existing source shape; the provider response cache separately hashes the complete actual request, including readable fields. The KAM store guide is unchanged.

## What normalization cannot repair

Dim's original names contain 1,303 question-mark cases and Žur's contain 1,426. The application retains these characters and warns models not to invent a replacement letter or missing detail. One SPAR name contained a control character inside `TE\u001e^EN`; removing the control restores `ТЕЧЕН`. No Unicode replacement-character corruption was found in the current names.

KAM's names are clean, but this is not a guarantee that every supplied fact is consistent. The original saved PDF for `НАМАЗ АБЦ 100Г` prints `БЕЗ ЛАКТОЗА 8 ГР` in its description. That discrepancy exists in the saved source, rather than being caused by character decoding. It was retained and documented instead of inventing a correction. Name/description quantity differences can also describe a multipack total versus each item or the size of loose produce; a naive numerical disagreement check must not rewrite them. Exact matching still needs conservative source-supported facts and manual correction for genuinely contradictory source information.

## Data update and logs

`npx tsx scripts/repair-readable-product-text.ts --apply` rebuilds only derived `store_products.normalized_name`, rule facts, search family and local signature in bounded chunks. It scans saved store products, including historical records, without updating millions of branch copies. It is idempotent and checks source revisions, prior facts and category values before writes. It does not change names, source records, fingerprints, versions, current groups, classification keys, manual facts/categories, prices, decisions, task authorization or spending.

`products.text_index.started`, `.checkpoint`, `.completed` and `.failed` use the existing log adapters. Checkpoints are debug events; start/completion/failure remain operational. No task or provider request is enqueued. Updated prompts load on worker restart; saved UI automation modes remain unchanged.

## Verification

All 191,049 current names were checked for idempotence: zero unstable conversions. The final 510-test isolated suite passed, including the new naming/projection, provider-input, pack-evidence, source-quote, search, memory-preservation and repair-idempotence checks. Type checking and the production Docker build passed. Providers were mocked; no paid evaluation was run. Interactive browser verification was not performed.


### Production verification

The derived index scanned 212,051 saved store-product records, including historical records, in bounded batches. Original names/descriptions/categories, product IDs/fingerprints/revisions/groups, saved categories and manual edits remained unchanged; a database digest of those fields matched the pre-update baseline. Prices and source observations were untouched. A repeat of the first repair was idempotent, and the final joined-word adjustment updated only affected derived fields.

All 3,723 KAM category decisions remain reusable: no recategorization is required for this naming update. AI usage and classifications remained at 3,723, tasks at 5, manual category edits at 1, detail edits at 0, matching decisions at 0, saved store products at 212,051 and offers at 5,934,456. Saved operational settings remained revision 7, with imports, categorization and matching manual. No campaign, import, or paid test was started.


Authenticated HTTP and server-rendering checks passed for source/Cyrillic search, product details, shared products, and display of both readable and original names. Public HTTPS health and web/worker/container health passed. The temporary isolated test database was removed after tests. The final UI/worker code is deployed on the homelab; no live model test or full production matching/categorization run was started.

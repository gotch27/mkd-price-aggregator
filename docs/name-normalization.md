# Product name spelling and legacy Macedonian glyphs

Retailer feeds mix Unicode Macedonian, Latin brand names, and old Macedonian
font encodings. Keep the source `name`, `raw`, and identity hash exactly as
published. `domain/normalize.ts` derives a common spelling for name search,
matching candidate retrieval, attribute extraction, and exact local rule keys.
Normalization alone never authorizes a product merge; existing brand, quantity,
variant, pack, and group compatibility checks still apply.

The punctuation assignments below are documented in the Macedonian
JUS I.B1.003 / ISO-IR-147 table in [RFC 1345](https://www.rfc-editor.org/rfc/rfc1345.txt).
They are also present in current SPAR, Vero, Dim, and Žur source names.

| Uppercase position | Lowercase position | Macedonian letters | Common search spelling |
| ------------------ | ------------------ | ------------------ | ---------------------- |
| `@`                | backtick           | Ж / ж              | zh                     |
| `[`                | `{`                | Ш / ш              | sh                     |
| backslash          | `\|`               | Ѓ / ѓ              | gj                     |
| `]`                | `}`                | Ќ / ќ              | kj                     |
| `^`                | `~`                | Ч / ч              | ch                     |

For example, `2010 DETSKI SET ^E[EL I ^ETKA` and
`2010 ДЕТСКИ СЕТ ЧЕШЕЛ И ЧЕТКА` both normalize to
`2010 detski set cheshel i chetka`. The literal Latin diacritics č/š/ž, ć/đ,
and Macedonian romanizations ǵ/ḱ are normalized consistently too.

`domain/name-encoding.ts` decodes a legacy symbol only next to a letter. Standalone
punctuation and numeric dimensions remain punctuation. Balanced bracket annotations
such as `[PACK]` retain their contents without inventing letters at the edges.
Internal glyphs such as `[E]ER` still become the common spelling of ШЕЌЕР.
URLs and email addresses are not decoded.

The complete old font alphabet also assigns Q/W/X/Y to Cyrillic letters. These
positions are deliberately not guessed in mixed product names: Q10, Wella, Syoss,
and model X5 must retain their Latin spelling. Source typos such as an inconsistent
glyph for the same word are not silently corrected. Supporting an explicitly
identified full-font source would require source-specific interpretation.

The normalization algorithm version is included in both local key hashes and
stored key versions. After an algorithm change, old keys are ignored and rebuilt
by the worker using the configured local index batch size. Existing assignments
and saved matching decisions are retained.

For an existing database, run `npm run names:reindex` to rebuild stored normalized
names from published source names. The service uses the compact browser index to
plan corrections and the configured index batch size for transactional updates.
It holds the browser refresh lock, changes only derived `normalized_name` fields,
and marks the browser index dirty for refresh. Interrupted batches can be retried.
Future catalog publications use the same normalizer automatically.

# Matching-search pagination verification

23 October 2026.

- Ten isolated manual-matching tests pass, including complete page coverage,
  deterministic ordering, same-store exclusion before counting, store filtering,
  empty results, out-of-range pages, authentication, page validation, whole-word
  boundaries, Cyrillic/Latin names, reviewed aliases and escaped decimal text.
- `next typegen` and `npm run check` pass.
- The running app was checked through the browser using searches only. The
  all-store search showed 232 eligible groups over 47 pages, and Next changed
  the range from 1–5 to 6–10 while retaining the search. Selecting KAM restarted
  the search at page one with eight groups over two pages.
- No production connection was saved, no worker was started, and no AI call or
  automatic matching campaign ran.
- Reproduced the later blank-looking cards with Žito's `000016 КАНТА ЗА ЃУБРЕ
  45л`: card heights were approximately 60 pixels while their content needed
  190–206 pixels. The fixed cards no longer shrink inside the results viewport;
  each card's client height now equals its content height. Product names, logos,
  facts and review buttons are visible. Next retains the query and resets only
  the inner scroll position; a changed query returns to page one.
- The old `kanta` substring search returned 297 results / 60 pages and included
  `KANTARION` tea. Whole-word search returns 229 / 46 without those unrelated
  longer words. `канта за` narrows it to 112 / 23. These remain manual search
  results, not confirmed connections; the interface now states that explicitly.
  Screenshot: `.data/ui-verification/matching-search-fixed.png`.

The production Docker build passes compilation, type checking and static page
generation. The rebuilt web container is healthy and serves the verified UI.
Earlier host-only Turbopack attempts failed when the CSS helper tried to bind a local port (`Operation not
permitted`). The supported webpack alternative compiles the application but
fails its generated route-type checks for the existing NextSignal
`createNextRoute` signature (`NextRouteContext | undefined`); this also affects
unchanged routes such as health and retry. The regular route type generator and
application type check pass. No framework signatures or build settings were
changed to bypass these failures.

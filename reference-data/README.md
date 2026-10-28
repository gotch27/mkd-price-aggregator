# Product reference data

`brands.json` is the reviewed starter brand directory. Database migrations seed
those brands and aliases once. The application reads the current directory from
PostgreSQL; changing this file does not overwrite saved brand edits.

`product-language.json` contains reviewed descriptor aliases and words ignored by
exact-name matching. These rules stay in source control because they can change
which products are considered equivalent. Change the explicit local rule version
with a rule change and run the product-fact, matching, and conflict tests. Language
rules are not editable operational settings or an external model prompt.

Raw store names, product IDs, saved categories, matches, and decision history are
independent of these files and must be preserved when reference data changes.

.PHONY: test prose prose-counts collect site

test:
	npm test

collect:
	npm run collect

site:
	npm run site

# The prose gate (see docs/STYLE-GUIDE.md). Vale over the reader-facing
# pages, at the levels set in .vale.ini, on the same file list
# scripts/docs.test.mjs reads. Requires `vale` on PATH and one
# `vale sync`. Warnings are advisory, errors fail.
prose:
	vale --minAlertLevel=error $$(node scripts/gated-docs.mjs)
	node scripts/vale-counts.mjs

# Re-measure what .vale.ini and the style guide record, after
# a change to the pages or to the rules moves the numbers.
prose-counts:
	node scripts/vale-counts.mjs --write

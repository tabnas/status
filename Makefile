.PHONY: test prose collect site

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

# calvin
Calvin's personal website

Calvin's website is cool.
Calvin's website is fun.

## Build Stamp

This repo is configured to update the footer with the latest git commit
timestamp (Denver time) and short SHA, and to bump the stylesheet cache-busting
version automatically after:

- commits
- merges
- branch checkouts

Hook scripts live in `.githooks/` and use `scripts/update-build-stamp.sh`.

Note: `post-commit` updates the stamp after a commit is created, so
`index.html` may show as modified immediately after committing.

If hooks are not active in a fresh clone, run:

```bash
git config core.hooksPath .githooks
```

Manual refresh is still available:

```bash
scripts/update-build-stamp.sh
```

# License

All content in this repository, including text, images, and code,
is © 2026 Calvin Poland. All rights reserved.

No permission is granted to copy, modify, distribute, or reuse
any part of this work without explicit written consent.

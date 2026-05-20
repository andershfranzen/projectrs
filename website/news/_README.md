# EvilQuest News Posts

Create one Markdown file per news post in this folder. Files starting with `_` are ignored.

Use this frontmatter at the top of each post:

```md
---
title: "Alpha Launch Update"
date: "2026-05-20"
summary: "Short teaser shown on the front page."
---

Your post body goes here.
```

The URL slug is generated from the file name, unless you add a `slug` field. Add `draft: true` to keep a post out of the site.

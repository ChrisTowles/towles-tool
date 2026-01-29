---
name: quarto
description: Use Quarto CLI for technical blogging with QMD (Quarto Markdown) files.
---

# Quarto (QMD)

Quarto is a scientific/technical publishing system. QMD files are executable markdown.

## Quick Start

```bash
# Install
brew install quarto  # macOS
# or: https://quarto.org/docs/download/

# Create a blog
quarto create project blog myblog
cd myblog && quarto preview

# Create a single document
quarto create document mypost.qmd
```

## Key Commands

```bash
quarto preview              # Live preview with hot reload
quarto render               # Build all outputs
quarto render doc.qmd       # Render single file
quarto publish github-pages # Deploy to GitHub Pages
quarto publish netlify      # Deploy to Netlify
```

## QMD File Structure

```markdown
---
title: "My Post"
date: 2026-01-28
categories: [rust, performance]
draft: true
execute:
  echo: true
---

## Introduction

Regular markdown with **bold** and `code`.

## Code Execution

```{python}
import pandas as pd
df = pd.DataFrame({'a': [1,2,3]})
df.head()
```

## Math

$$E = mc^2$$
```

## Blog Features

- Categories and tags
- RSS feed generation
- Draft posts (`draft: true`)
- Scheduled publishing
- Code syntax highlighting
- Interactive Observable JS

## Publishing

```bash
# GitHub Pages (free)
quarto publish github-pages

# Netlify (free tier)
quarto publish netlify

# Quarto Pub (free hosted)
quarto publish quarto-pub
```

## Why Use Quarto?

- **Git-friendly**: Plain text `.qmd` files, clean diffs
- **Executable code**: Python, R, Julia, Observable JS
- **Multi-output**: Same source → blog, PDF, slides
- **Modern**: Active development, VS Code extension

## VS Code Setup

Install "Quarto" extension for:
- Syntax highlighting
- Live preview
- Cell execution
- YAML completion

## Project Config

`_quarto.yml` at project root:

```yaml
project:
  type: website

website:
  title: "My Blog"
  navbar:
    left:
      - href: index.qmd
        text: Home
      - href: about.qmd
        text: About

format:
  html:
    theme: cosmo
    toc: true
```

## Tips

- Use `draft: true` in frontmatter for WIP posts
- `quarto preview` for hot reload while writing
- Commit `.qmd` files, ignore `_site/` output
- Observable JS for interactive visualizations

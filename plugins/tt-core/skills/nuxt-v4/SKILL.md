---
name: nuxt-v4
description: |
  Production-ready Nuxt 4 framework development with SSR, composables,
  data fetching, server routes, and Cloudflare deployment.

  Use when: building Nuxt 4 applications, implementing SSR patterns,
  creating composables, server routes, middleware, data fetching,
  state management, debugging hydration issues, deploying to Cloudflare,
  optimizing performance, or setting up testing with Vitest.

  Keywords: Nuxt 4, Nuxt v4, SSR, universal rendering, Nitro, Vue 3,
  useState, useFetch, useAsyncData, $fetch, composables, auto-imports,
  middleware, server routes, API routes, hydration, file-based routing,
  app directory, SEO, meta tags, useHead, useSeoMeta, transitions,
  error handling, runtime config, Cloudflare Pages, Cloudflare Workers,
  NuxtHub, Workers Assets, D1, KV, R2, Durable Objects, Vitest, testing,
  performance optimization, lazy loading, code splitting, prerendering,
  layers, modules, plugins, Vite, TypeScript, hydration mismatch,
  shallow reactivity, reactive keys, singleton pattern, defineNuxtConfig,
  defineEventHandler, navigateTo, definePageMeta, useRuntimeConfig,
  app.vue, server directory, public directory, assets directory
license: MIT
allowed-tools: [Read, Write, Edit, Bash, WebFetch, WebSearch]
metadata:
  version: 2.0.0
  author: Claude Skills Maintainers
  category: Framework
  framework: Nuxt
  framework-version: 4.x
  last-verified: 2026-01-11
---

# Nuxt 4 Development Skill

This skill provides up-to-date Nuxt 4 and Nuxt UI 4 documentation by fetching official llms.txt files at runtime.

## Important: Fetch Documentation First

Before answering Nuxt 4 or Nuxt UI questions, **always fetch the latest documentation**:

### For Nuxt 4 Core Questions

Use WebFetch to get the official Nuxt documentation:

```
WebFetch: https://nuxt.com/llms.txt
Prompt: Extract information about [specific topic]
```

For comprehensive details, fetch the full documentation:

```
WebFetch: https://nuxt.com/llms-full.txt
Prompt: Extract detailed information about [specific topic]
```

### For Nuxt UI 4 Questions

Use WebFetch to get the official Nuxt UI documentation:

```
WebFetch: https://ui.nuxt.com/llms.txt
Prompt: Extract information about [specific component or feature]
```

For comprehensive details:

```
WebFetch: https://ui.nuxt.com/llms-full.txt
Prompt: Extract detailed information about [specific component or feature]
```

## Usage Pattern

When a user asks about Nuxt 4 or Nuxt UI:

1. **Identify the topic** (components, composables, deployment, etc.)
2. **Fetch relevant documentation** using WebFetch with a focused prompt
3. **Synthesize the answer** based on official documentation
4. **Provide code examples** from the fetched content

## Example Workflow

**User asks**: "How do I use useFetch in Nuxt 4?"

**You should**:
1. Call WebFetch on `https://nuxt.com/llms.txt` with prompt: "Extract information about useFetch composable, data fetching, and reactive parameters"
2. Provide the answer based on the fetched documentation

**User asks**: "How do I use the Table component in Nuxt UI?"

**You should**:
1. Call WebFetch on `https://ui.nuxt.com/llms.txt` with prompt: "Extract information about Table component usage, props, and examples"
2. Provide the answer based on the fetched documentation

## Available Documentation Sources

| Source | URL | Use For |
|--------|-----|---------|
| Nuxt Index | https://nuxt.com/llms.txt | Quick reference, topic overview |
| Nuxt Full | https://nuxt.com/llms-full.txt | Detailed API docs, full examples |
| Nuxt UI Index | https://ui.nuxt.com/llms.txt | Component overview, quick reference |
| Nuxt UI Full | https://ui.nuxt.com/llms-full.txt | Detailed component docs, all props |

## Quick Reference

### Key Commands

```bash
# Create new project
bunx nuxi@latest init my-app

# Development
npm run dev

# Build for production
npm run build

# Type checking
bunx nuxi typecheck
```

### Directory Structure (Nuxt v4)

```
my-nuxt-app/
├── app/                    # ← Default srcDir in v4
│   ├── components/         # Auto-imported Vue components
│   ├── composables/        # Auto-imported composables
│   ├── pages/              # File-based routing
│   └── app.vue             # Main app component
├── server/                 # Server-side code (Nitro)
│   ├── api/                # API endpoints
│   └── middleware/         # Server middleware
├── nuxt.config.ts          # Nuxt configuration
└── package.json
```

### Key v4 Changes from v3

- Default srcDir is now `app/` instead of root
- Shallow reactivity default for `useFetch`/`useAsyncData`
- Default values changed from `null` to `undefined`
- Route middleware runs on server by default
- App manifest enabled by default


---

**Version**: 2.0.0 | **Last Updated**: 2026-01-11 | **License**: MIT

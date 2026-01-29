---
name: qmd
description: Use QMD for local BM25/RAG search across markdown notes, docs, and knowledge bases.
---

# QMD - Quick Markdown Search

Local search engine for your markdown files. Combines BM25 full-text search, vector semantic search, and LLM re-ranking — all running locally via GGUF models.

**Repo**: https://github.com/tobi/qmd

## Installation

```bash
bun install -g https://github.com/tobi/qmd
```

## Quick Setup

```bash
# Add collections (folders of markdown files)
qmd collection add ~/notes --name notes
qmd collection add ~/Documents/meetings --name meetings
qmd collection add ~/work/docs --name docs

# Add context to help search understand content
qmd context add qmd://notes "Personal notes and ideas"
qmd context add qmd://meetings "Meeting transcripts and notes"
qmd context add qmd://docs "Work documentation"

# Generate embeddings for semantic search
qmd embed
```

## Search Commands

```bash
# Fast keyword search (BM25)
qmd search "project timeline"

# Semantic vector search
qmd vsearch "how to deploy"

# Hybrid + reranking (best quality, slower)
qmd query "quarterly planning process"

# Search specific collection
qmd search "API" -c notes

# Export for agents
qmd search "API" --all --files --min-score 0.3 --json
```

## Document Retrieval

```bash
# Get by path
qmd get "meetings/2024-01-15.md"

# Get by docid (from search results)
qmd get "#abc123"

# Get multiple by glob
qmd multi-get "journals/2025-05*.md"

# Full content
qmd get "docs/api-reference.md" --full
```

## Collection Management

```bash
qmd collection list              # List all collections
qmd collection remove myproject  # Remove collection
qmd ls notes                     # List files in collection
qmd embed                        # Generate/update embeddings
qmd embed -f                     # Force re-embed everything
```

## MCP Server Integration

QMD exposes an MCP server for Claude Code/Desktop:

**Claude Code** (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

**MCP Tools**:
- `qmd_search` — BM25 keyword search
- `qmd_vsearch` — Semantic vector search
- `qmd_query` — Hybrid search with reranking
- `qmd_get` — Retrieve document by path/docid
- `qmd_multi_get` — Retrieve multiple documents
- `qmd_status` — Index health and collection info

## Search Architecture

```
Query → Query Expansion (Qwen3-1.7B)
      → Parallel: BM25 (FTS5) + Vector Search
      → RRF Fusion
      → LLM Re-ranking (qwen3-reranker)
      → Position-Aware Blending
```

## Score Interpretation

| Score | Meaning |
|-------|---------|
| 0.8 - 1.0 | Highly relevant |
| 0.5 - 0.8 | Moderately relevant |
| 0.2 - 0.5 | Somewhat relevant |
| 0.0 - 0.2 | Low relevance |

## Models (auto-downloaded)

| Model | Purpose | Size |
|-------|---------|------|
| embeddinggemma-300M | Vector embeddings | ~300MB |
| qwen3-reranker-0.6b | Re-ranking | ~640MB |
| Qwen3-1.7B | Query expansion | ~2.2GB |

Cached in `~/.cache/qmd/models/`

## Use Cases

- Search meeting notes and transcripts
- Find relevant docs for coding tasks
- RAG pipeline for local knowledge bases
- Agentic workflows with `--json` output

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Documents

- `docs/requirements/command_journal.md`: Journal command requirements and specifications with its alias `j` and `journal today`, `journal meeting`, `journal note` and `journal daily`
- `docs/requirements/command_git-commit.md`: Git commit command requirements and specifications for `git-commit`
with its alias `gc`

## Development Commands

- `pnpm lint` - Lint code with oxlint
- `pnpm typecheck` - Type check code with tsc
- `pnpm test` - Run tests with Vitest

## Code Quality

Run `pnpm typecheck` and `pnpm run lint:fix`  after making changes to ensure code quality and consistency.

## Key Architecture Notes

modular architecture and support Domain-Driven Design (DDD) pattern in large scale projects.

- **Commands Layer** (`src/commands/`): Contains different areas for commander commands, such as `src/commands/git.ts` for Git-related commands.
- **CLI Entry point** is `src/index.ts` with basic exports
- destructured object parameters are used for better readability and maintainability
- async/await is used for asynchronous operations
- execAsync is a utility function to execute shell commands asynchronously
- never use the --no-verify flag with git commands in this repository, as it will bypass the pre-commit hooks that ensure code quality and consistency.

### Types example

```typescript
// src/core/domain/post/types.ts

import { z } from 'zod/v4'
import { paginationSchema } from '@/lib/pagination.ts'

export const postIdSchema = z.uuid().brand('postId')
export type PostId = z.infer<typeof postIdSchema>

export const postSchema = z.object({
  id: postIdSchema,
  content: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type Post = z.infer<typeof postSchema>

// ...

export const listPostQuerySchema = z.object({
  pagination: paginationSchema,
  filter: z
    .object({
      text: z.string().optional(),
    })
    .optional(),
})
export type ListPostQuery = z.infer<typeof listPostQuerySchema>
```

### Ports example

```typescript
// src/core/domain/post/ports/postRepository.ts

export interface PostRepository {
  create: (post: CreatePostParams) => Promise<Result<Post, RepositoryError>>
  list: (query: ListPostQuery) => Promise<Result<Post, RepositoryError>>
  // Other repository methods...
}
```

```typescript
// src/core/domain/file/ports/storageManager.ts

export interface StorageManager {
  uploadFile: (file: UploadFileParams) => Promise<Result<File, StorageError>>
  // Other session management methods...
}
```

### Adapters example

### Application Service example

```typescript
// src/utils/function.ts

import type { Context } from '../context'
import type { PostRepository } from '@/domain/post/ports/postRepository'
import { Result } from 'neverthrow'
import { z } from 'zod/v4'

export const createPostInputSchema = z.object({
  content: z.string().min(1).max(500),
})
export type CreatePostInput = z.infer<typeof createPostInputSchema>

export async function createPost(
  context: Context,
  input: CreatePostInput
): Promise<Result<Post, RepositoryError>> {
  return context.create({
    content: input.content
  }).mapErr((error) => {
    return new ApplicationError('Failed to create post', error)
  })
}
```

## Context object example

```typescript
// Context object for specific environment
// ex: src/context.ts

export const envSchema = z.object({
  DATABASE_URL: z.string(),
  DATABASE_AUTH_TOKEN: z.string(),
  // Other environment variables...
})

export type Env = z.infer<typeof envSchema>

const env = envSchema.safeParse(process.env)
if (!env.success) {
  throw new TypeError(env.error/* Zod errors */)
}

const db = getDatabase(env.data.DATABASE_URL, env.data.DATABASE_AUTH_TOKEN)

export const context = {
  userRepository: new DrizzleSqliteUserRepository(db),
  storageManager: new S3StorageManager(/* ...args */),
  // Ohter adapters...
}
```

## CLI Architecture

using:

- typescript
- consola
- claude-code
- vitest
- zod
- neverthrow
- unbuild

### Server Actions example

```typescript
import { z } from 'zod/v4'
import { context } from '@/context'
// src/actions/post.ts
import { createPost } from '@/core/application/post/createPost'

export const createPostActionSchema = z.object({
  content: z.string().min(1).max(500),
})
export type CreatePostActionParams = z.infer<typeof createPostActionSchema>
export async function createPostAction(params: CreatePostActionParams) {
  //
}
```

## Tech Stack

- **Package Manager**: pnpm with workspace configuration
- **Runtime**: Node.js 22.x
- **Build System**: unbuild for TypeScript compilation
- **Testing**: Vitest for unit tests
- **Interface**: commander and consola for CLI interface
- **Validation**: Zod 4 schemas with branded types
- **Error Handling**: neverthrow for Result types
- **Git Hooks**: simple-git-hooks with lint-staged for pre-commit linting

## Error Handling

- All 'src/utils' functions return `Result<T, E>` or `Promise<Result<T, E>>` types using `neverthrow`
- Each modules has its own error types, e.g. `RepositoryError`, `ApplicationError`. Error types should extend a base `AnyError` class (`src/lib/errors.ts`)

## Testing

- Create tests that validate formal method models
- Use `pnpm test` for tests
- Use `src/adapters/mock/${adapter}.ts` to create mock implementations of external services for testing

### Application Service Tests

- Use `src/${domain}/${usecase}.test.ts` for unit tests of application services

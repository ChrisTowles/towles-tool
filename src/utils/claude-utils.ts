import type { SDKMessage } from '@anthropic-ai/claude-code'
import type { TowlesToolConfig, TowlesToolSettings } from '../config'

import { query } from '@anthropic-ai/claude-code'
import { getGitDiff as getChangelogGitDiff } from 'changelogen' // unJs/changelogen has some nice utilities for git
import consola from 'consola'

export async function getGitDiff(config: TowlesToolConfig): Promise<string> {
  const commits = await getChangelogGitDiff(config.cwd)
  return commits.map(commit => commit.message).join('\n')
}

export function finalPrompt(diff: string, generate_number: number): string {
  // found similar prompt here with MIT license
  // https://github.com/tak-bro/aicommit2/blob/main/src/utils/prompt.ts

  const commitTypes = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'revert', 'build', 'ci', 'types', 'wip']
  const generate_number_plural = generate_number > 1 ? 's' : ''
  const maxLength = 72 // Conventional commit subject line max length

  const first_part = [
    `You are a helpful assistant specializing in writing clear and informative Git commit messages using the conventional style.`,
    `Based on the given code changes or context, generate exactly ${generate_number} conventional Git commit message${generate_number_plural} based on the following guidelines.`,

    `1. Format: follow the conventional commits format following :`,
    '<type>(<optional scope>): <commit message>',
    '',
    `2. Types: use one of the following types:`,
    `     ${commitTypes.join('-, ')}`,
    '3. Guidelines for writing commit messages:',
    '   - Be specific about what changes were made',
    '   - Use imperative mood ("add feature" not "added feature")',
    `   - Keep subject line under ${maxLength} characters`,
    '   - Do not end the subject line with a period',
    '   - Use the body to explain what and why vs. how',
    '4. Focus on:',
    '   - What problem this commit solves',
    '   - Why this change was necessary',
    '   - Any important technical details',
    '5. Exclude anything unnecessary such as translation or implementation details.',
  ]

  const diff_part = [
    `Here is the context for the commit message${generate_number_plural}:`,
    '',
    '```diff',
    `${diff}`,
    '```',
    '',
    `If no code changes are provided, use the context to generate a commit message based on the task or issue description.`,
  ]

  const last_part = [
    '',
    `Lastly, Provide your response as a JSON array containing exactly ${generate_number} object${generate_number_plural}, each with the following keys:`,
    `- "subject": The main commit message using the conventional commit style. It should be a concise summary of the changes.`,
    `- "body": An optional detailed explanation of the changes. If not needed, use an empty string.`,
    `The array must always contain ${generate_number} element${generate_number_plural}, no more and no less.`,
    `Example response format: `,
    '',
    '```json',
    `{`,
    `     "subject": "fix(auth): fix bug in user authentication process",`,
    `     "body": "- Update login function to handle edge cases\\n- Add additional error logging for debugging",`,
    `}`,
    '```',
    '',
    `Ensure you generate exactly ${generate_number} commit message${generate_number_plural}, even if it requires creating slightly varied versions for similar changes.`,
    `The response should be valid JSON that can be parsed without errors.`,
  ]

  return [
    ...first_part,
    ...diff_part,
    ...last_part,
  ].join('\n')
}

export async function invokeClaude({ prompt }: { config: TowlesToolSettings, prompt: string }): Promise<string> {
  const messages: SDKMessage[] = []
  for await (const message of query({
    prompt,
    abortController: new AbortController(),
    options: {
      maxTurns: 1,
    },
  })) {
    messages.push(message)
  }

  consola.log(messages)

  // let result = ''
  // try {
  //   // Ensure zx is initialized
  //   $.shell = '/bin/zsh'

  //   ensureDirectoryExists(config.claudeAlias)

  //   // const args = ['--print', `${prompt}`, '--output-format', 'json']
  //   // const args = ['--print', '"tell a joke"']
  //   const command = [`--print "${prompt}" --output-format json`
  //   consola.info(`Invoking Claude with command: ${config.claudeAlias}  ${command}`)

  //   const message = await $`${config.claudeAlias}  ${command}`

  //   consola.info('Claude command found at:', config, prompt)
  //   // const message = await $`${config.claudeAlias} -p "${prompt}" --output-format json`
  //   // const message = await $`claude -p "${prompt}" --output-format json`
  //   result = message.stdout
  // }
  // catch (error) {
  //   consola.error('Error invoking:', error)
  //   process.exit(1)
  // }

  // // #| jq -r '.result')

  return messages.map(m => m).join('\n') // Assuming messages is an array of objects with a 'text' property
}

export async function claudeDoctor(_config: TowlesToolSettings): Promise<string> {
  return 'I\'m Claude, your virtual assistant!'
}

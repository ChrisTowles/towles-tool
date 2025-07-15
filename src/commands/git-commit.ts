import type { Choice } from 'prompts'
import type { Config } from '../config'
import type { SendMessageInput } from '../utils/anthropic/types'
import process from 'node:process'
import { spinner } from '@clack/prompts'
import consola from 'consola'
import { colors } from 'consola/utils'
import { Fzf } from 'fzf'
import prompts from 'prompts'
import z from 'zod/v4'
import { validate } from '../lib/validation'
import { ClaudeService } from '../utils/anthropic/claude-service'
import { execCommand } from '../utils/exec'
import { getGitDiff } from '../utils/git'
import { printJson } from '../utils/print-utils'

const commitTypes = ['feat', 'fix', 'docs', 'test', 'wip']

const maxSubjectLength = 72
const llmMaxSubjectLength = maxSubjectLength - 12 // Conventional commit subject line max length

export const gitCommitSuggestionSchema = z.object({
  subject: z.string().min(1).max(maxSubjectLength), // larger than we told the LLM to generate
  body: z.string().optional(),
})

export type GitCommitSuggestion = z.infer<typeof gitCommitSuggestionSchema>

export function finalPrompt(diff: string, generate_number: number): string {
  // found similar prompt here with MIT license
  // https://github.com/tak-bro/aicommit2/blob/main/src/utils/prompt.ts

  const generate_number_plural = generate_number > 1 ? 's' : ''

  const first_part = [
    `You are a helpful assistant specializing in writing clear and informative Git commit messages using the conventional style.`,
    `Based on the given code changes or context, generate exactly ${generate_number} conventional Git commit message${generate_number_plural} based on the following guidelines.`,

    `1. Format: follow the conventional commits format following of one of the following. :`,
    '<type>: <commit message>',
    '<type>(<optional scope>): <commit message>',
    '',
    `2. Types: use one of the following types:`,
    `     ${commitTypes.join('-, ')}`,
    '3. Guidelines for writing commit messages:',
    '   - Be specific about what changes were made',
    '   - Use imperative mood ("add feature" not "added feature")',
    `   - Keep subject line under ${llmMaxSubjectLength} characters`,
    '   - make each entry more generic and not too specific to the code changes',
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
    `The LLM result will be valid json only if it is well-formed and follows the schema below.`,
    '',
    `<result>`,
    `[`,
    `  {`,
    `    "subject": "chore: update <file> to handle auth",`,
    `    "body": "- Update login function to handle edge cases\\n- Add additional error logging for debugging",`,
    `  }`,
    `  {`,
    `    "subject": "fix(auth): fix bug in user authentication process",`,
    `    "body": "- Update login function to handle edge cases\\n- Add additional error logging for debugging",`,
    `  }`,
    `]`,
    `</result>`,
    '',
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

/**
 * Git commit command implementation
 */
export async function gitCommitCommand(config: Config): Promise<void> {
  const s = spinner()
  s.start('Generating commit message based on diff...')

  s.message('getting git diff...')
  const diff = await getGitDiff(config.cwd)

  if (diff.trim().length === 0) {
    consola.error(`No staged changes found to commit. use '${colors.blue('git add <file>...')}' to stage changes before committing.`)
    process.exit(1)
  }

  s.message('generating prompt...')
  const prompt = finalPrompt(diff, /* config.generate_number || */ 6)

  // printDebug(prompt)
  const service = new ClaudeService()

  const input: SendMessageInput = {
    message: prompt,

  }

  s.message('sending prompt to claude and waiting answer...')

  const result = await service.sendMessageStream(input, () => {
    // consola.log(colors.yellow('Received chunk:'))
    // printJson(chunk)

  })

  if (result.isErr()) {
    consola.error(`Error sending message: ${result.error.message}`)
    process.exit(1)
  }
  s.stop(`Received commit messages from Claude!${colors.green('✓')}`)
  // printDebug('Received git commit messages:', result.value)

  const filteredResults = result.value.filter(msg => msg.type === 'result')
  if (filteredResults.length === 0) {
    consola.error('No valid commit messages received from Claude')
    process.exit(1)
  }

  if (filteredResults.length > 1) {
    consola.warn(`Received ${filteredResults.length} commit messages, using the first one`)
  }

  // consola.info('Claude says:', filteredResults[0].result)

  // Hack: TODO: i couldn't figure out how to claude-code to run `--output-format json` via the sdk
  // so we have to parse the result manually.  Extract JSON array from the result string (remove text before '[' and after ']')
  const startIndex = filteredResults[0].result!.indexOf('[')
  const endIndex = filteredResults[0].result!.lastIndexOf(']')

  if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
    consola.error('Could not find valid JSON array in Claude response')
    process.exit(1)
  }

  const cleanedResultRaw = filteredResults[0].result!.substring(startIndex, endIndex + 1)
  const cleanedResult = JSON.parse(cleanedResultRaw) // Validate JSON format

  const suggestions = validate(z.array(gitCommitSuggestionSchema), cleanedResult)
  consola.success('Claude suggestions validated for format!')
  if (!suggestions.isOk()) {
    consola.error('Invalid suggestions format:', suggestions.error)
    process.exit(1)
  }
  // consola.info('Suggestions:')
  // printJson(suggestions.value)

  const choosenSuggestion = await promptUserForCommitMessage(suggestions.value)

  const commandWithArgs = `git commit -m "${choosenSuggestion.subject}"`
  consola.info(`Running command: ${colors.bgCyan(commandWithArgs)}`)

  try {
    execCommand(commandWithArgs, config.cwd)
  }
  catch (error) {
    consola.error(`Failed to commit changes:`)
    printJson(error as unknown as object)
    process.exit(1)
  }
}

async function promptUserForCommitMessage(suggestions: GitCommitSuggestion[]): Promise<GitCommitSuggestion> {
  let profileChoices: Choice[] = suggestions
    .map(x => ({
      title: x.subject,
      value: x.subject,
      // description: limitText(`${x.getFriendlyAccountName()}`, 15),
    }))

  profileChoices = profileChoices.sort((a, b) => a.title.localeCompare(b.title))

  // fuzzy match the profile name
  const fzf = new Fzf(profileChoices, {
    selector: item => `${item.title}`,
    casing: 'case-insensitive',
  })

  try {
    const { fn } = await prompts({
      name: 'fn',
      message: 'Choose your git commit:',
      type: 'autocomplete',
      choices: profileChoices,
      async suggest(input: string, choices: Choice[]) {
        const results = fzf.find(input)
        return results.map(r => choices.find(x => x.value === r.item.title))
      },
    })

    if (!fn) {
      consola.log(colors.dim('Cancelled!'))
      process.exit(1)
    }
    const entry = suggestions.find(x => x.subject === fn)

    if (!entry) {
      consola.error('No matching commit message found')
      process.exit(1)
    }

    return entry
  }
  catch (ex) {
    consola.error('Failed to run : exit', ex)
    process.exit(1)
  }
}

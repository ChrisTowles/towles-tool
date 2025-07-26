import prompts from 'prompts'
import type {  Choice } from 'prompts'
import { colors } from 'consola/utils'
import { Fzf } from 'fzf'


import type { GitHubBranchArgs } from '../utils/parseArgs'
import { getIssues, isGithubCliInstalled } from '../utils/git/gh-cli-wrapper'
import type { Issue } from '../utils/git/gh-cli-wrapper'
import { createBranch } from '../utils/git/git-wrapper'
import { getTerminalColumns, limitText, printWithHexColor } from '../utils/render'
import type { Context } from '../config/context'
import consola from 'consola'

export interface BranchCommandOptions {
  cwd: string
  unassigned?: boolean
}

const checkPreqrequisites = async () => {
  // todo, cache this like nr does
  const cliInstalled = await isGithubCliInstalled()
  if (!cliInstalled) {
    consola.log('Github CLI not installed')
    process.exit(1)
  }
}

function customTrimEnd(str: string, charsToTrim: string[]) {
  let i = str.length - 1;
  while (i >= 0 && charsToTrim.includes(str[i])) {
    i--;
  }
  return str.substring(0, i + 1);
}

export const createBranchNameFromIssue = (selectedIssue: Issue): string => {
  let slug = selectedIssue.title.toLowerCase()
  slug = slug.trim()
  slug = slug.replaceAll(' ', '-')
  slug = slug.replace(/[^0-9a-zA-Z_]/g, '-')
  slug = slug.replaceAll('--', '-')
  slug = slug.replaceAll('--', '-') // in case there are multiple spaces
  slug = slug.replaceAll('--', '-') // in case there are multiple spaces
  slug = customTrimEnd(slug, ['-']) // take off any extra dashes at the end


  const branchName = `feature/${selectedIssue.number}-${slug}`
  return branchName
}

export async function githubBranchCommand(context: Context, args: GitHubBranchArgs): Promise<void> {
  await checkPreqrequisites()

  const assignedToMe = Boolean(args.assignedToMe)
  consola.log('Assigned to me:', assignedToMe)

  const currentIssues = await getIssues({ assignedToMe, cwd: context.cwd })
  if (currentIssues.length === 0) {
    consola.log(colors.yellow('No issues found, check assignments'))
    process.exit(1)
  }
  else {
    consola.log(colors.green(`${currentIssues.length} Issues found assigned to you`))
  }

  // Alot of work but the goal is to make the table look nice and the labels colored.
  let lineMaxLength = getTerminalColumns()
  const longestNumber = Math.max(...currentIssues.map(i => i.number.toString().length))
  const longestLabels = Math.max(...currentIssues.map(i => i.labels.map(x => x.name).join(', ').length))

  // limit how big the table can be
  lineMaxLength = lineMaxLength > 130 ? 130 : lineMaxLength
  const descriptionLength = lineMaxLength - longestNumber - longestLabels - 15 // 15 is for padding

  const choices: Choice[] = currentIssues.map((i) => {
    const labelText = i.labels.map(l => printWithHexColor({ msg: l.name, hex: l.color })).join(', ')
    const labelTextNoColor = i.labels.map(l => l.name).join(', ') // due to color adding length to the string
    const labelStartpad = longestLabels - labelTextNoColor.length
    return {
      title: i.number.toString(),
      value: i.number,
      description: `${limitText(i.title, descriptionLength).padEnd(descriptionLength)} ${''.padStart(labelStartpad)}${labelText}`, // pads to make sure the labels are aligned, no diea why padStart doesn't work on labelText
    } as Choice
  },
  )
  choices.push({ title: 'Cancel', value: 'cancel' })

  const fzf = new Fzf(choices, {
    selector: item => `${item.value} ${item.description}`,
    casing: 'case-insensitive',
  })

  try {

    // Note: I had to patch prompts so that escape exits the prompt
    const result = await prompts({
      name: 'issueNumber',
      message: 'Github issue to create branch for:',
      type: 'autocomplete',
      choices,
      async suggest(input: string, choices: Choice[]) {
        consola.log(input)
        const results = fzf.find(input)
        return results.map(r => choices.find(c => c.value === r.item.value))
      },
    }, {
       // when escape is used just cancel
       onCancel: () => {
        consola.info(colors.dim("Canceled"))
        process.exit(0)
       }

    })
    if (result.issueNumber === 'cancel') {
      consola.log(colors.dim('Canceled'))
      process.exit(0)
    }
    const selectedIssue = currentIssues.find(i => i.number === result.issueNumber)!
    consola.log(`Selected issue ${colors.green(selectedIssue.number)} - ${colors.green(selectedIssue.title)}`)

    const branchName = createBranchNameFromIssue(selectedIssue)

    createBranch({ branchName })
  }
  catch (e) {
    process.exit(1)
  }
}


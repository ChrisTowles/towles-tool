import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Clips } from '../types'
import { COPY_ALL_GAP_MS, type Ignored, clipLine, clipShown, offers, quiet } from './clip'

const clips = atom({ plugin: 'tt', key: 'clips' } as const, [] as Clips)

/** Reset by a copy; a reload starts it over. */
let ignored: Ignored = { offers: 0, lastMs: 0 }

type Surface = Parameters<EngineInterface['ui']['copy']>[0]['surface']

/** Several go one at a time, apart, so the clipboard manager keeps each in order. */
async function copyOffers($: EngineInterface, texts: string[], surface: Surface) {
  let copied = 0
  for (const [i, text] of texts.entries()) {
    if (i > 0) await new Promise<void>(done => $.clock.after(COPY_ALL_GAP_MS, done))
    if ((await $.ui.copy({ text, surface })).isCopied) copied++
  }
  if (!copied) {
    $.ui.toast('Nothing reached the clipboard.')
    return
  }
  ignored = { offers: 0, lastMs: 0 }
  $.ui.toast(texts.length === 1 ? `Copied ${clipShown(texts[0]!)}` : `Copied ${copied}, in order`)
}

export const register: Register = on => {
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, clips, () => [])
    return next(e)
  })

  // Only the `! <command>`s Claude hands the user to run; nothing for any other message.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return ran
    const found = offers(e.answer)
    const now = await $.clock.now()
    if (!found.length || quiet(ignored, now)) return ran
    ignored = { offers: ignored.offers + 1, lastMs: now }
    await update($, clips, () => found)
    return ran
  })

  // Below whatever else draws the band: one row per offer, a `copy` badge and the text.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || e.props.isWorking) return below
    const texts = (await read($, clips)).slice(0, e.props.maxRows - 1)
    if (!texts.length) return below

    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        {texts.map((text, i) => (
          <Box key={`row:${i}`} flexDirection="row" gap={1}>
            <Button
              key={`clip:${i}`}
              hotkey={String(i + 1)}
              plain
              onPress={press => void copyOffers($, [text], press.surface)}
            >
              <Text backgroundColor="magenta" color="black">
                {' copy '}
              </Text>
              <Text wrap="truncate-end"> {clipLine(text)}</Text>
            </Button>
            {i === 0 && texts.length > 1 && (
              <Button
                key="clip:all"
                hotkey="a"
                plain
                dimColor
                onPress={press => void copyOffers($, texts, press.surface)}
              >
                copy all
              </Button>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}

import * as React from "react"
import { Slider as SliderPrimitive } from "@cloudflare/kumo/primitives/slider"

import { cn } from "@/lib/utils"

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  const thumbs = Array.isArray(value)
    ? value.length
    : Array.isArray(defaultValue)
      ? defaultValue.length
      : 1

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn("w-full data-disabled:opacity-50", className)}
      {...props}
    >
      <SliderPrimitive.Control className="flex w-full touch-none items-center py-2 select-none">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative h-1 w-full grow rounded-full bg-kumo-fill"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="rounded-full bg-kumo-brand select-none"
          />
          {Array.from({ length: thumbs }, (_, index) => (
            <SliderPrimitive.Thumb
              data-slot="slider-thumb"
              key={index}
              index={thumbs > 1 ? index : undefined}
              className="block size-3 shrink-0 rounded-full border border-kumo-brand bg-white select-none after:absolute after:-inset-2 hover:ring-3 hover:ring-kumo-focus/50 focus-visible:ring-3 focus-visible:ring-kumo-focus/50 focus-visible:outline-hidden data-disabled:pointer-events-none"
            />
          ))}
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }

<template>
  <div class="min-h-screen bg-zinc-950 font-sans text-zinc-100 antialiased">
    <NuxtPage />
  </div>
</template>

<style>
:root {
  --font-display: "DM Sans", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
}

body {
  font-family: var(--font-display);
  background-color: #09090b;
}

.font-display {
  font-family: var(--font-display);
}

.font-mono {
  font-family: var(--font-mono);
}

/* Scrollbar styling */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: #27272a;
  border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
  background: #3f3f46;
}
</style>

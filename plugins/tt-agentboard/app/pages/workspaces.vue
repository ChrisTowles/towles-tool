<template>
  <div class="min-h-screen">
    <!-- Nav -->
    <nav class="border-b border-zinc-800 px-6 py-3">
      <div class="flex items-center gap-4">
        <NuxtLink
          to="/"
          class="text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
        >
          ← Board
        </NuxtLink>
        <span class="text-zinc-700">│</span>
        <span class="text-sm font-semibold text-zinc-200">Workspaces</span>
      </div>
    </nav>

    <div class="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <WorkspaceSlotRegistry />
    </div>
  </div>
</template>

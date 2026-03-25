<script setup lang="ts">
const router = useRouter();

async function onComplete() {
  router.push("/workspaces");
}
</script>

<template>
  <div class="min-h-screen">
    <nav class="border-b border-zinc-800 px-6 py-3">
      <div class="flex items-center gap-4">
        <NuxtLink
          to="/"
          class="text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
        >
          ← Board
        </NuxtLink>
        <span class="text-zinc-700">│</span>
        <NuxtLink
          to="/workspaces"
          class="text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
        >
          Workspaces
        </NuxtLink>
        <span class="text-zinc-700">│</span>
        <span class="text-sm font-semibold text-zinc-200">Setup</span>
      </div>
    </nav>

    <div class="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <WorkspaceOnboardingWizard @complete="onComplete" />
    </div>
  </div>
</template>

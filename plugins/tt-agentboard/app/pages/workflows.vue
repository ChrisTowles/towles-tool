<script setup lang="ts">
interface WorkflowStep {
  id: string;
  prompt_template: string;
  artifact: string;
  model?: string;
  max_iterations?: number;
  pass_condition?: string;
  on_fail?: string;
  max_retries?: number;
}

interface Workflow {
  name: string;
  description?: string;
  triggers?: {
    github_label?: string;
  };
  steps: WorkflowStep[];
  post_steps?: {
    create_pr?: boolean;
    pr_title_template?: string;
  };
  labels?: {
    in_progress?: string;
    success?: string;
    failure?: string;
  };
  branch_template?: string;
  artifact_dir?: string;
}

const { data: workflows, status } = useFetch<Workflow[]>("/api/workflows");
</script>

<template>
  <div class="min-h-screen">
    <!-- Nav -->
    <nav class="border-b border-zinc-800 px-4 py-3 sm:px-6">
      <div class="flex items-center gap-4">
        <NuxtLink
          to="/"
          class="text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
        >
          ← Board
        </NuxtLink>
        <span class="text-zinc-700">│</span>
        <span class="text-sm font-semibold text-zinc-200">Workflows</span>
      </div>
    </nav>

    <!-- Loading -->
    <div v-if="status === 'pending'" class="flex items-center justify-center py-20">
      <span
        class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-blue-400"
      />
    </div>

    <!-- Empty state -->
    <div
      v-else-if="!workflows?.length"
      class="flex flex-col items-center justify-center py-20 text-zinc-500"
    >
      <p class="mb-2 text-sm">No workflows loaded</p>
      <p class="text-xs text-zinc-600">
        Add workflow YAML files to .agentboard/workflows/ in your repos
      </p>
    </div>

    <!-- Workflow list -->
    <div v-else class="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <div
        v-for="wf in workflows"
        :key="wf.name"
        class="rounded-xl border border-zinc-800 bg-zinc-900/50"
      >
        <!-- Workflow header -->
        <div class="border-b border-zinc-800 px-5 py-4">
          <div class="flex items-start justify-between gap-4">
            <div>
              <h2 class="text-sm font-bold text-zinc-100">{{ wf.name }}</h2>
              <p v-if="wf.description" class="mt-1 text-xs text-zinc-400">
                {{ wf.description }}
              </p>
            </div>
            <div class="flex items-center gap-2">
              <span
                v-if="wf.triggers?.github_label"
                class="rounded-full bg-violet-500/10 px-2.5 py-0.5 text-[10px] font-medium text-violet-400"
              >
                label: {{ wf.triggers.github_label }}
              </span>
              <span
                v-if="wf.post_steps?.create_pr"
                class="rounded-full bg-blue-500/10 px-2.5 py-0.5 text-[10px] font-medium text-blue-400"
              >
                auto-PR
              </span>
            </div>
          </div>
        </div>

        <!-- Steps -->
        <div class="px-5 py-4">
          <h3 class="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
            Steps
          </h3>
          <div class="space-y-2">
            <div
              v-for="(step, i) in wf.steps"
              :key="step.id"
              class="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2"
            >
              <span
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-bold tabular-nums text-zinc-400"
              >
                {{ i + 1 }}
              </span>
              <div class="min-w-0 flex-1">
                <span class="text-xs font-semibold text-zinc-200">{{ step.id }}</span>
                <div class="flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
                  <span v-if="step.model" class="font-mono">{{ step.model }}</span>
                  <span v-if="step.max_iterations">max {{ step.max_iterations }} iterations</span>
                  <span v-if="step.max_retries">{{ step.max_retries }} retries</span>
                  <span v-if="step.pass_condition" class="font-mono text-emerald-500/60">
                    {{ step.pass_condition }}
                  </span>
                  <span v-if="step.on_fail" class="font-mono text-amber-500/60">
                    on_fail: {{ step.on_fail }}
                  </span>
                </div>
              </div>
              <span class="shrink-0 text-[10px] font-mono text-zinc-600">
                {{ step.artifact.split("/").pop() }}
              </span>
            </div>
          </div>
        </div>

        <!-- Labels / config footer -->
        <div
          v-if="wf.labels || wf.branch_template"
          class="border-t border-zinc-800 px-5 py-3 text-[10px] text-zinc-500"
        >
          <div class="flex flex-wrap gap-4">
            <span v-if="wf.branch_template" class="font-mono">
              branch: {{ wf.branch_template }}
            </span>
            <span v-if="wf.labels?.in_progress">
              in-progress label: {{ wf.labels.in_progress }}
            </span>
            <span v-if="wf.labels?.success">success label: {{ wf.labels.success }}</span>
            <span v-if="wf.labels?.failure">failure label: {{ wf.labels.failure }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

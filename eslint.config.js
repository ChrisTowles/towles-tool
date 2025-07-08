// @ts-check
import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'app',
    pnpm: true,
    rules: {
      'no-console': 'warn',
      // 'no-unused-vars': 'warn',
      // 'vue/no-unused-components': 'warn',
      // 'vue/no-v-html': 'off', // Allow v-html for specific use cases
    },
  },
)

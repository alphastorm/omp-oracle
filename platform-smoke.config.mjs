// Platform smoke configuration for omp-oracle.
// Crabbox is used as the local cross-platform release/readiness gate.

export default {
  packageName: "omp-oracle",
  artifactRoot: ".artifacts/platform-smoke",
  // The runner accepts only these targets. windows-native, carried from upstream (validated there
  // at pi-oracle 0.7.20 only), needs a Parallels template this fork does not own; add it here and
  // to smoke:platform:all to run it.
  requiredTargets: ["macos", "ubuntu"],
  requiredSuites: ["platform-build", "real-extension"],
  workflows: {
    everyday: {
      description: "Fast local validation for normal iteration.",
      commands: ["npm run verify:oracle"],
    },
    platformSensitive: {
      description: "Doctor plus focused platform target/suite runs for platform-sensitive changes.",
      commands: [
        "npm run smoke:platform:doctor",
        "node scripts/platform-smoke.mjs run --target <target> --suite <suite>",
      ],
    },
    platformMatrix: {
      description: "Doctor-first packed-install proof on every required target.",
      commands: ["npm run smoke:platform:all"],
    },
    release: {
      description: "Full release gate: local verification, offline capture proof, fresh ChatGPT preset proof, then the doctor-first platform matrix.",
      commands: ["npm run release:check"],
    },
  },
  requiredCrabbox: {
    source: "https://github.com/openclaw/crabbox",
    minVersion: "0.26.0",
  },
  ubuntuContainerImage: "omp-oracle-platform-smoke:node24",
  ubuntuContainerBaseImage: "cimg/node:24.22",
  windowsParallels: {
    sourceVm: "pi-extension-windows-template",
    snapshot: "crabbox-ready",
  },
  nodeValidationMajor: 24,
  realSmoke: {
    defaultProvider: "zai",
    defaultModel: "glm-5.2",
    // Env names pi reads a provider's credential from; any one of them is enough.
    authEnvByProvider: {
      zai: ["ZAI_API_KEY"],
      openai: ["OPENAI_API_KEY"],
      anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
      google: ["GEMINI_API_KEY"],
      xai: ["XAI_API_KEY"],
      groq: ["GROQ_API_KEY"],
      deepseek: ["DEEPSEEK_API_KEY"],
      cerebras: ["CEREBRAS_API_KEY"],
      fireworks: ["FIREWORKS_API_KEY"],
      together: ["TOGETHER_API_KEY"],
      openrouter: ["OPENROUTER_API_KEY"],
      ai_gateway: ["AI_GATEWAY_API_KEY"],
      mistral: ["MISTRAL_API_KEY"],
      minimax: ["MINIMAX_API_KEY"],
      "minimax-cn": ["MINIMAX_CN_API_KEY"],
      "ant-ling": ["ANT_LING_API_KEY"],
      nvidia: ["NVIDIA_API_KEY"],
      moonshot: ["MOONSHOT_API_KEY"],
      opencode: ["OPENCODE_API_KEY"],
      xiaomi: ["XIAOMI_API_KEY"],
      kimi: ["KIMI_API_KEY"],
    },
  },
};

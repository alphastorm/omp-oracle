declare const config: {
  packageName: string;
  artifactRoot: string;
  requiredTargets: string[];
  requiredSuites: string[];
  nodeValidationMajor?: number;
  ubuntuContainerImage?: string;
  [key: string]: unknown;
};

export default config;

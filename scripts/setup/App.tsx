import React, { useState, useCallback } from 'react';
import { Box, Text, useApp } from 'ink';
import { WelcomeScreen } from './components/WelcomeScreen.js';
import { StepContainer } from './components/StepContainer.js';
import { TargetRepoStep } from './steps/TargetRepoStep.js';
import { WorkspaceSlugStep } from './steps/WorkspaceSlugStep.js';
import { NgrokStep } from './steps/NgrokStep.js';
import { LinearOAuthStep } from './steps/LinearOAuthStep.js';
import { LinearCredentialsStep } from './steps/LinearCredentialsStep.js';
import { LinearAuthStep } from './steps/LinearAuthStep.js';
import { LinearTeamStep } from './steps/LinearTeamStep.js';
import { AnthropicStep } from './steps/AnthropicStep.js';
import { GitHubStep } from './steps/GitHubStep.js';
import { ConcurrencyStep } from './steps/ConcurrencyStep.js';
import { LabelsStep } from './steps/LabelsStep.js';
import { CompleteStep } from './steps/CompleteStep.js';
import { loadEnvFile } from './utils/env.js';

export interface SetupState {
  // Repository
  workDir: string;

  // Linear
  workspaceSlug: string;
  linearClientId: string;
  linearClientSecret: string;
  linearWebhookSecret: string;
  linearTeamId: string;

  // ngrok
  ngrokUrl: string | null;
  ngrokApiKey: string;
  ngrokCustomDomain: string;

  // Anthropic
  anthropicApiKey: string;
  anthropicModel: string;

  // GitHub
  githubRepo: string;

  // Agent config
  maxConcurrent: number;
  maxCodeExecutors: number;
}

// Load existing .env values for idempotency
function loadInitialState(): SetupState {
  const env = loadEnvFile();
  const customDomain = env.get('NGROK_CUSTOM_DOMAIN') || '';
  return {
    workDir: env.get('AGENTS_WORK_DIR') || '',
    workspaceSlug: env.get('LINEAR_WORKSPACE_SLUG') || '',
    linearClientId: env.get('LINEAR_CLIENT_ID') || '',
    linearClientSecret: env.get('LINEAR_CLIENT_SECRET') || '',
    linearWebhookSecret: env.get('LINEAR_WEBHOOK_SECRET') || '',
    linearTeamId: env.get('LINEAR_TEAM_ID') || '',
    ngrokUrl: customDomain ? `https://${customDomain}` : null,
    ngrokApiKey: env.get('NGROK_API_KEY') || '',
    ngrokCustomDomain: customDomain,
    anthropicApiKey: env.get('ANTHROPIC_API_KEY') || '',
    anthropicModel: env.get('ANTHROPIC_MODEL') || 'claude-sonnet-4-5',
    githubRepo: env.get('GITHUB_REPO') || '',
    maxConcurrent: parseInt(env.get('AGENTS_MAX_CONCURRENT') || '5', 10),
    maxCodeExecutors: parseInt(env.get('AGENTS_MAX_CODE_EXECUTORS') || '1', 10),
  };
}

const TOTAL_STEPS = 12;

type Step =
  | 'welcome'
  | 'target-repo'
  | 'workspace-slug'
  | 'ngrok'
  | 'linear-oauth'
  | 'linear-credentials'
  | 'linear-auth'
  | 'linear-team'
  | 'anthropic'
  | 'github'
  | 'concurrency'
  | 'labels'
  | 'complete';

const STEP_ORDER: Step[] = [
  'welcome',
  'target-repo',
  'workspace-slug',
  'ngrok',
  'linear-oauth',
  'linear-credentials',
  'linear-auth',
  'linear-team',
  'anthropic',
  'github',
  'concurrency',
  'labels',
  'complete',
];

export const App: React.FC = () => {
  const { exit } = useApp();
  const [currentStep, setCurrentStep] = useState<Step>('welcome');
  const [state, setState] = useState<SetupState>(loadInitialState);

  const stepIndex = STEP_ORDER.indexOf(currentStep);

  const goToNextStep = useCallback(() => {
    const nextIndex = stepIndex + 1;
    if (nextIndex < STEP_ORDER.length) {
      setCurrentStep(STEP_ORDER[nextIndex]);
    }
  }, [stepIndex]);

  const updateState = useCallback((updates: Partial<SetupState>) => {
    setState((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleComplete = useCallback(() => {
    exit();
  }, [exit]);

  // Render current step
  switch (currentStep) {
    case 'welcome':
      return <WelcomeScreen onContinue={goToNextStep} />;

    case 'target-repo':
      return (
        <StepContainer step={1} totalSteps={TOTAL_STEPS} title="Target Repository">
          <TargetRepoStep
            currentValue={state.workDir}
            onComplete={(workDir) => {
              updateState({ workDir });
              goToNextStep();
            }}
          />
        </StepContainer>
      );

    case 'workspace-slug':
      return (
        <StepContainer
          step={2}
          totalSteps={TOTAL_STEPS}
          title="Linear Workspace"
          description="Your workspace slug is the part after 'linear.app/' in your Linear URL"
        >
          <WorkspaceSlugStep
            currentValue={state.workspaceSlug}
            onComplete={(workspaceSlug) => {
              updateState({ workspaceSlug });
              goToNextStep();
            }}
          />
        </StepContainer>
      );

    case 'ngrok':
      return (
        <StepContainer
          step={3}
          totalSteps={TOTAL_STEPS}
          title="Webhook Configuration"
          description="Select your ngrok domain for Linear webhooks"
        >
          <NgrokStep
            currentApiKey={state.ngrokApiKey}
            currentCustomDomain={state.ngrokCustomDomain}
            onComplete={({ ngrokUrl, customDomain, apiKey }) => {
              updateState({
                ngrokUrl,
                ngrokCustomDomain: customDomain || '',
                ngrokApiKey: apiKey,
              });
              goToNextStep();
            }}
          />
        </StepContainer>
      );

    case 'linear-oauth':
      return (
        <StepContainer
          step={4}
          totalSteps={TOTAL_STEPS}
          title="Linear OAuth Application"
        >
          <LinearOAuthStep
            workspaceSlug={state.workspaceSlug}
            ngrokUrl={state.ngrokUrl}
            currentWebhookSecret={state.linearWebhookSecret}
            onComplete={(webhookSecret) => {
              updateState({ linearWebhookSecret: webhookSecret });
              goToNextStep();
            }}
          />
        </StepContainer>
      );

    case 'linear-credentials':
      return (
        <StepContainer
          step={5}
          totalSteps={TOTAL_STEPS}
          title="Linear Client Credentials"
        >
          <LinearCredentialsStep
            currentClientId={state.linearClientId}
            currentClientSecret={state.linearClientSecret}
            onComplete={(clientId, clientSecret) => {
              updateState({
                linearClientId: clientId,
                linearClientSecret: clientSecret,
              });
              goToNextStep();
            }}
          />
        </StepContainer>
      );

    case 'linear-auth':
      return (
        <StepContainer
          step={6}
          totalSteps={TOTAL_STEPS}
          title="Linear Authorization"
        >
          <LinearAuthStep
            clientId={state.linearClientId}
            clientSecret={state.linearClientSecret}
            ngrokUrl={state.ngrokUrl}
            ngrokCustomDomain={state.ngrokCustomDomain}
            onComplete={goToNextStep}
          />
        </StepContainer>
      );

    case 'linear-team':
      return (
        <StepContainer
          step={7}
          totalSteps={TOTAL_STEPS}
          title="Linear Team"
          description="Select the team TaskAgent will work with"
        >
          <LinearTeamStep
            clientId={state.linearClientId}
            clientSecret={state.linearClientSecret}
            onComplete={(teamId) => {
              updateState({ linearTeamId: teamId });
              goToNextStep();
            }}
          />
        </StepContainer>
      );

    case 'anthropic':
      return (
        <StepContainer
          step={8}
          totalSteps={TOTAL_STEPS}
          title="Anthropic API"
        >
          <AnthropicStep
            currentApiKey={state.anthropicApiKey}
            currentModel={state.anthropicModel}
            onComplete={(apiKey, model) => {
              updateState({ anthropicApiKey: apiKey, anthropicModel: model });
              goToNextStep();
            }}
          />
        </StepContainer>
      );

    case 'github':
      return (
        <StepContainer
          step={9}
          totalSteps={TOTAL_STEPS}
          title="GitHub Repository"
          description="The repository where agents will create branches and PRs"
        >
          <GitHubStep
            workDir={state.workDir}
            currentValue={state.githubRepo}
            onComplete={(repo) => {
              updateState({ githubRepo: repo });
              goToNextStep();
            }}
          />
        </StepContainer>
      );

    case 'concurrency':
      return (
        <StepContainer
          step={10}
          totalSteps={TOTAL_STEPS}
          title="Agent Configuration"
        >
          <ConcurrencyStep
            currentMaxConcurrent={state.maxConcurrent}
            currentMaxCodeExecutors={state.maxCodeExecutors}
            onComplete={(maxConcurrent, maxCodeExecutors) => {
              updateState({ maxConcurrent, maxCodeExecutors });
              goToNextStep();
            }}
          />
        </StepContainer>
      );

    case 'labels':
      return (
        <StepContainer
          step={11}
          totalSteps={TOTAL_STEPS}
          title="Linear Labels"
          description="Creating TaskAgent trigger labels in your Linear team"
        >
          <LabelsStep
            clientId={state.linearClientId}
            clientSecret={state.linearClientSecret}
            teamId={state.linearTeamId}
            onComplete={goToNextStep}
          />
        </StepContainer>
      );

    case 'complete':
      return (
        <StepContainer
          step={12}
          totalSteps={TOTAL_STEPS}
          title="Setup Complete"
        >
          <CompleteStep state={state} onComplete={handleComplete} />
        </StepContainer>
      );

    default:
      return (
        <Box>
          <Text color="red">Unknown step: {currentStep}</Text>
        </Box>
      );
  }
};

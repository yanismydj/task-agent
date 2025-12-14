import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner, TextInput, Select, StatusMessage } from '@inkjs/ui';

interface NgrokStepProps {
  currentApiKey: string;
  currentCustomDomain: string;
  onComplete: (result: { ngrokUrl: string | null; customDomain: string | null; apiKey: string }) => void;
}

interface NgrokDomain {
  id: string;
  domain: string;
  description?: string;
}

type NgrokState =
  | 'api-key-input'
  | 'fetching-domains'
  | 'select-domain'
  | 'no-domains'
  | 'ready'
  | 'error';

export const NgrokStep: React.FC<NgrokStepProps> = ({
  currentApiKey,
  currentCustomDomain,
  onComplete,
}) => {
  const [state, setState] = useState<NgrokState>(currentApiKey ? 'fetching-domains' : 'api-key-input');
  const [apiKey, setApiKey] = useState(currentApiKey);
  const [domains, setDomains] = useState<NgrokDomain[]>([]);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(currentCustomDomain || null);
  const [error, setError] = useState<string | null>(null);

  // Auto-fetch domains if we have an API key
  useEffect(() => {
    if (state === 'fetching-domains' && apiKey) {
      fetchDomains(apiKey);
    }
  }, [state, apiKey]);

  const fetchDomains = async (key: string) => {
    try {
      const response = await fetch('https://api.ngrok.com/reserved_domains', {
        headers: {
          'Authorization': `Bearer ${key}`,
          'Ngrok-Version': '2',
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          setError('Invalid API key. Please check your ngrok API key.');
          setState('api-key-input');
          return;
        }
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      const reservedDomains: NgrokDomain[] = (data.reserved_domains || []).map((d: any) => ({
        id: d.id,
        domain: d.domain,
        description: d.description || undefined,
      }));

      if (reservedDomains.length === 0) {
        setState('no-domains');
      } else {
        setDomains(reservedDomains);
        // Pre-select current domain if it exists in the list
        if (currentCustomDomain && reservedDomains.some(d => d.domain === currentCustomDomain)) {
          setSelectedDomain(currentCustomDomain);
        }
        setState('select-domain');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch domains');
      setState('error');
    }
  };

  const handleApiKeySubmit = (value: string) => {
    const key = value.trim() || currentApiKey;
    if (!key) {
      setError('API key is required');
      return;
    }
    setApiKey(key);
    setError(null);
    setState('fetching-domains');
  };

  const handleDomainSelect = (domain: string) => {
    setSelectedDomain(domain);
    setState('ready');
  };

  useInput((input, key) => {
    if (key.return && state === 'ready') {
      onComplete({
        ngrokUrl: selectedDomain ? `https://${selectedDomain}` : null,
        customDomain: selectedDomain,
        apiKey,
      });
    }
    if (key.return && state === 'no-domains') {
      onComplete({
        ngrokUrl: null,
        customDomain: null,
        apiKey,
      });
    }
    if (key.return && state === 'error') {
      setState('api-key-input');
      setError(null);
    }
  });

  switch (state) {
    case 'api-key-input':
      return (
        <Box flexDirection="column">
          <Text bold>ngrok API Key</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>To list your available domains, we need your ngrok API key.</Text>
            <Text dimColor>Get it from: <Text color="cyan">https://dashboard.ngrok.com/api</Text></Text>
          </Box>
          {currentApiKey && (
            <Box marginTop={1}>
              <Text dimColor>(Press Enter to use existing key)</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <TextInput
              defaultValue={currentApiKey}
              placeholder="your-ngrok-api-key"
              onSubmit={handleApiKeySubmit}
            />
          </Box>
          {error && (
            <Box marginTop={1}>
              <Text color="red">✗ {error}</Text>
            </Box>
          )}
        </Box>
      );

    case 'fetching-domains':
      return (
        <Box>
          <Spinner label="Fetching your ngrok domains..." />
        </Box>
      );

    case 'select-domain':
      const options = domains.map((d) => ({
        label: d.description ? `${d.domain} (${d.description})` : d.domain,
        value: d.domain,
      }));

      return (
        <Box flexDirection="column">
          <Text>Select your ngrok domain:</Text>
          <Box marginTop={1}>
            <Select
              options={options}
              defaultValue={currentCustomDomain || undefined}
              onChange={handleDomainSelect}
              visibleOptionCount={10}
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              Run ngrok with: <Text color="cyan">ngrok http --url=YOUR_DOMAIN 4847</Text>
            </Text>
          </Box>
        </Box>
      );

    case 'no-domains':
      return (
        <Box flexDirection="column">
          <StatusMessage variant="warning">No domains found</StatusMessage>
          <Box marginTop={1} flexDirection="column">
            <Text>You don't have any reserved domains in your ngrok account.</Text>
            <Text dimColor>Create one at: <Text color="cyan">https://dashboard.ngrok.com/domains</Text></Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to continue without webhooks</Text>
          </Box>
        </Box>
      );

    case 'ready':
      return (
        <Box flexDirection="column">
          <StatusMessage variant="success">Domain selected</StatusMessage>
          <Box marginTop={1}>
            <Text>Domain: <Text color="cyan">{selectedDomain}</Text></Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Before starting TaskAgent, run:</Text>
            <Text color="cyan">  ngrok http --url={selectedDomain} 4847</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="cyan">Press Enter to continue</Text>
          </Box>
        </Box>
      );

    case 'error':
      return (
        <Box flexDirection="column">
          <StatusMessage variant="error">{error || 'An error occurred'}</StatusMessage>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to try again</Text>
          </Box>
        </Box>
      );

    default:
      return null;
  }
};

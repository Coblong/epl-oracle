const HTTP_FAILURE = /^http_([1-5]\d\d)$/;

export function classifyProviderFailure(error) {
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) return `http_${error.status}`;
  if (error?.failureCode === 'provider_refusal') return 'provider_refusal';
  if (error?.failureCode === 'invalid_response' || error instanceof SyntaxError) return 'invalid_response';
  if (error?.failureCode === 'missing_credentials' || /(?:[A-Z0-9_]+_API_KEY) is not configured/.test(error?.message ?? '')) return 'missing_credentials';
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  if (error?.name === 'TypeError' || ['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ETIMEDOUT'].includes(error?.cause?.code)) return 'network_error';
  return 'provider_error';
}

export function providerFailureMessage(code) {
  const http = HTTP_FAILURE.exec(code ?? '');
  if (http) return `Provider returned HTTP ${http[1]}.`;
  return ({
    invalid_response:'Provider returned an invalid or incomplete response.',
    missing_credentials:'Provider credentials are missing.',
    network_error:'Could not connect to the provider.',
    provider_error:'Provider request failed.',
    provider_refusal:'Provider refused the forecast.',
    timeout:'Provider request timed out.',
  })[code] ?? '';
}

// Is this AWS error about the credentials themselves (expired workshop keys, wrong keys, no keys)?
// That needs a different response from a model hiccup: callers cannot be helped until a human
// refreshes the credentials and restarts the server, so the coordinator is told exactly that.
const CREDENTIAL_ERRORS =
  /Expired|UnrecognizedClient|InvalidClientTokenId|InvalidSignature|SignatureDoesNotMatch|CredentialsProviderError|Could not load credentials|security token included in the request is (expired|invalid)/i;

export function isCredentialError(err) {
  return CREDENTIAL_ERRORS.test(`${err?.name ?? ''} ${err?.Code ?? ''} ${err?.message ?? ''}`);
}

export const CREDENTIAL_ALERT_TITLE = 'AWS credentials expired or invalid';
export const CREDENTIAL_ALERT_DETAIL =
  'Callers are being told "I am having trouble". Refresh the AWS credentials (aws configure --profile event, then aws configure set aws_session_token ...) and restart the server. 911 guidance still works without AWS.';

/**
 * Extension point for authentication (challenge §2). A real implementation would validate an
 * OIDC access token issued by an external IdP (e.g. Keycloak, client-credentials flow, one
 * client per provider) and return the provider it represents.
 */
export type ProviderAuthentication =
  | { kind: 'authenticated'; providerId: string }
  /** Authentication is not configured: requests are accepted as-is. */
  | { kind: 'anonymous' }
  | { kind: 'denied'; reason: string };

export interface ProviderIdentityPort {
  authenticate(
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<ProviderAuthentication>;
}

export const PROVIDER_IDENTITY = Symbol('ProviderIdentity');

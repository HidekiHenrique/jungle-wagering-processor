import { Injectable } from '@nestjs/common';
import type { ProviderAuthentication, ProviderIdentityPort } from '../../application/provider-identity.port';

/** No-op identity: authentication deliberately not implemented (see ARCHITECTURE.md). */
@Injectable()
export class AnonymousProviderIdentity implements ProviderIdentityPort {
  async authenticate(): Promise<ProviderAuthentication> {
    return { kind: 'anonymous' };
  }
}

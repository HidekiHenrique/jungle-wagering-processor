import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PROVIDER_IDENTITY, type ProviderIdentityPort } from '../../../application/provider-identity.port';

export const AUTHENTICATED_PROVIDER = Symbol('authenticatedProvider');

/**
 * Applied to every provider-facing endpoint. With the no-op identity it lets everything through;
 * plugging a real ProviderIdentityPort makes it reject unauthenticated calls, and controllers can
 * then require `body.providerId` to match the authenticated provider.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { [AUTHENTICATED_PROVIDER]?: string }>();
    const result = await this.identity.authenticate(request.headers);
    if (result.kind === 'denied') throw new UnauthorizedException(result.reason);
    if (result.kind === 'authenticated') request[AUTHENTICATED_PROVIDER] = result.providerId;
    return true;
  }
}

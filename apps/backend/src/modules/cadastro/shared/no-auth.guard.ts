// [LACUNA: RBAC DOC-12] Placeholder guard — no real authentication/authorization
// exists yet (DOC-12 is a later session). Always allows the request through.
// Kept as an explicit guard (not just a comment) so every cadastro controller
// has a concrete, greppable point to swap in the real DOC-12 guard later.
import { Injectable, CanActivate } from '@nestjs/common';

@Injectable()
export class NoAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

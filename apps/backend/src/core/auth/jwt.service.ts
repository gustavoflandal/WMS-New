// DOC-12 RF-SEG-003 — JWT access (15 min) + refresh token opaco rotativo
// (8h interno / 24h portal). Refresh tokens NÃO são JWT: são segredos
// aleatórios opacos, guardados como hash em wms.auth_session — permite
// revogação real (um JWT auto-contido não pode ser revogado sem blocklist;
// um valor opaco com lookup em banco pode, e RF-SEG-003 exige "revogável").
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import { randomBytes, createHash } from 'crypto';

export type Area = 'INTERNAL' | 'CLIENT_PORTAL';

export interface AccessTokenClaims {
  sub: string; // user_id
  assignments_hash: string;
  area: Area;
}

export interface VerifiedAccessToken extends AccessTokenClaims {
  iat: number;
  exp: number;
}

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // RF-SEG-003: 15 min
const REFRESH_TTL_SECONDS_INTERNAL = 8 * 60 * 60; // 8h
const REFRESH_TTL_SECONDS_PORTAL = 24 * 60 * 60; // 24h

@Injectable()
export class JwtService {
  private readonly secret: string;

  constructor(private readonly configService?: ConfigService) {
    const secret = this.configService ? this.configService.get<string>('JWT_SECRET') : process.env.JWT_SECRET;
    if (!secret) {
      // RNF-ARQ-011 style fail-fast: nunca assina token com segredo default.
      throw new Error('JWT_SECRET environment variable not configured');
    }
    this.secret = secret;
  }

  signAccessToken(claims: AccessTokenClaims): string {
    return jwt.sign(claims, this.secret, { expiresIn: ACCESS_TOKEN_TTL_SECONDS, algorithm: 'HS256' });
  }

  /** @throws jwt.JsonWebTokenError | jwt.TokenExpiredError */
  verifyAccessToken(token: string): VerifiedAccessToken {
    return jwt.verify(token, this.secret, { algorithms: ['HS256'] }) as VerifiedAccessToken;
  }

  generateRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('hex');
    return { token, hash: this.hashRefreshToken(token) };
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  refreshTtlSeconds(area: Area): number {
    return area === 'INTERNAL' ? REFRESH_TTL_SECONDS_INTERNAL : REFRESH_TTL_SECONDS_PORTAL;
  }
}

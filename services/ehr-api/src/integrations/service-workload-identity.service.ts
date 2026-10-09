import { readFile, stat } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';

export type ClinicalService = 'lab' | 'pharmacy';

@Injectable()
export class ServiceWorkloadIdentityService {
  async authorization(service: ClinicalService): Promise<string> {
    const environment = getEnvironment();
    const mode = service === 'lab'
      ? environment.LAB_SERVICE_IDENTITY_MODE
      : environment.PHARMACY_SERVICE_IDENTITY_MODE;
    if (mode !== 'jwt') {
      throw new DomainProblem(
        503,
        'SERVICE_WORKLOAD_IDENTITY_UNAVAILABLE',
        'JWT workload identity is not enabled for the target service',
      );
    }
    const path = service === 'lab'
      ? environment.LAB_EHR_WORKLOAD_TOKEN_FILE
      : environment.PHARMACY_EHR_WORKLOAD_TOKEN_FILE;
    if (!path) {
      throw new DomainProblem(
        503,
        'SERVICE_WORKLOAD_IDENTITY_UNAVAILABLE',
        'Workload token source is not configured',
      );
    }
    return `Bearer ${await this.readToken(path)}`;
  }

  async identityHeaders(): Promise<Readonly<Record<string, string>>> {
    const environment = getEnvironment();
    if (environment.IDENTITY_SERVICE_IDENTITY_MODE === 'local-secret') {
      if (environment.NODE_ENV === 'production') {
        throw new DomainProblem(
          503,
          'IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE',
          'Local Identity workload authentication is disabled in production',
        );
      }
      if (!environment.IDENTITY_EHR_INTERNAL_SERVICE_TOKEN) {
        throw new DomainProblem(
          503,
          'IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE',
          'Identity workload identity is not configured',
        );
      }
      return { 'x-hid-service-token': environment.IDENTITY_EHR_INTERNAL_SERVICE_TOKEN };
    }
    if (!environment.IDENTITY_EHR_WORKLOAD_TOKEN_FILE) {
      throw new DomainProblem(
        503,
        'IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE',
        'Identity workload token source is not configured',
      );
    }
    return {
      'x-hid-service-authorization': `Bearer ${await this.readToken(environment.IDENTITY_EHR_WORKLOAD_TOKEN_FILE)}`,
    };
  }

  private async readToken(path: string): Promise<string> {
    const metadata = await stat(path).catch(() => {
      throw new DomainProblem(
        503,
        'SERVICE_WORKLOAD_IDENTITY_UNAVAILABLE',
        'Workload token source is unavailable',
      );
    });
    if (!metadata.isFile() || metadata.size > 16_384) {
      throw new DomainProblem(
        503,
        'SERVICE_WORKLOAD_IDENTITY_INVALID',
        'Workload token source is invalid',
      );
    }
    const token = await readFile(path, { encoding: 'utf8' }).catch(() => {
      throw new DomainProblem(
        503,
        'SERVICE_WORKLOAD_IDENTITY_UNAVAILABLE',
        'Workload token source is unavailable',
      );
    });
    const normalized = token.trim();
    if (normalized.length < 20 || normalized.length > 16_384 || /\s/.test(normalized)) {
      throw new DomainProblem(
        503,
        'SERVICE_WORKLOAD_IDENTITY_INVALID',
        'Workload token source is invalid',
      );
    }
    return normalized;
  }
}

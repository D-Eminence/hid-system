import { readFile, stat } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';

const MAX_WORKLOAD_TOKEN_LENGTH = 16_384;

@Injectable()
export class WorkloadCredentialsService {
  async headers(): Promise<Record<string, string>> {
    const environment = getEnvironment();
    if (environment.OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE === 'local-secret') {
      const token = environment.OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN;
      if (!token) throw new DomainProblem(503, 'WORKLOAD_IDENTITY_UNAVAILABLE',
        'Outreach workload identity is unavailable');
      return { 'x-hid-service-token': token };
    }
    const path = environment.OUTREACH_IDENTITY_WORKLOAD_TOKEN_FILE;
    if (!path) throw new DomainProblem(503, 'WORKLOAD_IDENTITY_UNAVAILABLE',
      'Outreach workload identity is unavailable');
    const metadata = await stat(path).catch(() => {
      throw new DomainProblem(503, 'WORKLOAD_IDENTITY_UNAVAILABLE',
        'Outreach workload identity is unavailable');
    });
    if (!metadata.isFile() || metadata.size > MAX_WORKLOAD_TOKEN_LENGTH) {
      throw new DomainProblem(503, 'WORKLOAD_IDENTITY_UNAVAILABLE',
        'Outreach workload identity is unavailable');
    }
    const token = await readFile(path, { encoding: 'utf8' }).catch(() => {
      throw new DomainProblem(503, 'WORKLOAD_IDENTITY_UNAVAILABLE',
        'Outreach workload identity is unavailable');
    });
    const value = token.trim().replace(/^Bearer\s+/, '');
    if (value.length < 20 || value.length > MAX_WORKLOAD_TOKEN_LENGTH || /\s/.test(value)) {
      throw new DomainProblem(503, 'WORKLOAD_IDENTITY_UNAVAILABLE',
        'Outreach workload identity is unavailable');
    }
    return { 'x-hid-service-authorization': `Bearer ${value}` };
  }
}

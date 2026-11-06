import { HealthIdField } from './health-id';

export class LinkPreviewDto {
  @HealthIdField()
  healthId!: string;
}

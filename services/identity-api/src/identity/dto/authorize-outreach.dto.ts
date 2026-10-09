import { IsIn } from 'class-validator';

export class AuthorizeOutreachDto {
  @IsIn(['outreach.registration.read', 'outreach.registration.write'])
  permission!: 'outreach.registration.read' | 'outreach.registration.write';
}

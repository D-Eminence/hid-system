import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import type { Request } from 'express';
import { resetEnvironmentForTests } from '../config/environment';
import type { WorkloadAuthService } from '../auth/workload-auth.service';
import { BrevoFallbackProvider } from '../providers/brevo.provider';
import { cardCodeContent, cardCreatedContent, cardLinkContent, cardOpenedContent, patientSiteOrigin }
  from '../providers/card-link-emails';
import type { OtpProvider, ProviderResult } from '../providers/provider.types';
import { DeliverCardCodeDto, DeliverCardCreatedDto, DeliverCardLinkDto, DeliverCardOpenedDto }
  from './dto/deliver-card-link-emails.dto';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

jest.mock('../auth/workload-auth.service', () => ({ WorkloadAuthService: class WorkloadAuthService {} }));

// Synthetic values only.
const token = 'Q2FyZExpbmtUb2tlbjAxMjM0NTY3ODlBQkNERUZHSEk';
const stopToken = '5e1a0000-0000-4000-8000-000000000001.c3RvcFRhZzAxMjM0NTY3ODlBQkNERUZHSElKS0xNTk9';
const link = { channel: 'email' as const, recipient: 'kemi.doctor@example.test', token, reference: 'K7P2-QX9M',
  expiresAt: '2026-11-05T09:04:00.000Z', stopToken };
const code = { channel: 'email' as const, recipient: 'kemi.doctor@example.test', code: '482913', reference: 'K7P2-QX9M',
  stopToken };
const opened = { channel: 'email' as const, recipient: 'ada@example.test', reference: 'K7P2-QX9M',
  openedAt: '2026-11-04T09:42:00.000Z' };
const created = { channel: 'email' as const, recipient: 'ada@example.test', reference: 'K7P2-QX9M',
  recipientHint: 'k•••@example.test', expiresAt: '2026-11-05T09:04:00.000Z', linkEmailed: true };

describe('Card link emails (0118, E5-E8)', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: 'test', NOTIFICATION_PROVIDER_MODE: 'test', HID_DEPLOYMENT_ENV: 'production',
      CARD_LINKS_ENABLED: 'true' });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  function provider(name: ProviderResult['provider']): OtpProvider {
    return { name, send: jest.fn().mockResolvedValue({ provider: name, outcome: 'accepted' } satisfies ProviderResult) };
  }
  function controller(email: OtpProvider) {
    const others = provider('termii');
    const service = new NotificationService({ primary: { email, sms: others, whatsapp: others }, fallback: others });
    return new NotificationController({ authenticate: jest.fn().mockResolvedValue(undefined) } as unknown as WorkloadAuthService,
      service);
  }
  const request = { header: () => 'identity-api' } as unknown as Request;
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const origin = 'https://app.healthidentitydirectory.com';

  it('fixes the patient site by deployment: app. in production, the staging patient portal in staging', () => {
    expect(patientSiteOrigin('production')).toBe('https://app.healthidentitydirectory.com');
    expect(patientSiteOrigin('staging')).toBe('https://staging.healthidentitydirectory.com');
    expect(patientSiteOrigin('development')).toBe('http://localhost:5173');
  });

  it('E5 holds the link and the reference only: the link is exactly <patient site>/card#<token>, no code, no person', () => {
    const content = cardLinkContent({ token, reference: 'K7P2-QX9M', expiresAt: new Date(link.expiresAt), stopToken, origin });
    expect(content.subject).toBe('A Health ID card has been shared with you');
    expect(content.html).toBeUndefined();
    expect(content.text).toBe('Hello,\n\n'
      + 'Someone has shared their Health ID card with you. You can look at it, but you can\'t change anything.\n\n'
      + `To open it, go to:\n${origin}/card#${token}\n\n`
      + 'When you open it, we\'ll email a 6-digit code to this address. You\'ll need it to see the card. '
      + 'Anyone who opens this link can ask for a code, but the code only ever comes to this inbox.\n\n'
      + 'Reference: K7P2-QX9M. The person who shared it can see this reference, so you can check with them that '
      + 'it\'s really from them.\n\n'
      + 'The link works until 5 Nov 2026, 10:04 (Lagos time), or until they end it. Please don\'t forward this email.\n\n'
      + 'If you weren\'t expecting this, you can ignore it. To stop getting these emails, go to:\n'
      + `${origin}/card/stop#${stopToken}\n\n`
      + `How we use your email address: ${origin}/card/privacy`);
    const links = content.text.match(/https:\/\/\S+/g) ?? [];
    expect(links).toEqual([`${origin}/card#${token}`, `${origin}/card/stop#${stopToken}`, `${origin}/card/privacy`]);
    expect(content.text.replace(/https:\/\/\S+/g, '')).not.toMatch(/[0-9]{6}|HID-|Ada|blood|genotype|allerg/i);
  });

  it('E6 holds the code and the reference only: never the card link, never a person', () => {
    const content = cardCodeContent({ code: '482913', reference: 'K7P2-QX9M', stopToken, origin });
    expect(content.subject).toBe('Your Health ID code');
    expect(content.html).toBeUndefined();
    expect(content.text).toBe('Hello,\n\n'
      + 'Someone asked to open the Health ID card shared with you (reference K7P2-QX9M).\n\n'
      + 'Your code is 482913. It works once, for 10 minutes.\n\n'
      + 'Only type this code on app.healthidentitydirectory.com. If someone asks you for it, don\'t give it to them, '
      + 'even if they say they\'re from Health ID or are a doctor.\n\n'
      + 'If you didn\'t ask for this code, someone else may have the link. Tell the person who shared it. '
      + `To stop getting these emails, go to:\n${origin}/card/stop#${stopToken}\n\n`
      + `How we use your email address: ${origin}/card/privacy`);
    expect(content.text).not.toContain('/card#');
    expect(content.text).not.toContain(token);
  });

  it('E7 and E8 go to the patient with no health data: the reference, the time, the masked address', () => {
    const openedContent = cardOpenedContent({ reference: 'K7P2-QX9M', openedAt: new Date(opened.openedAt) });
    expect(openedContent.subject).toBe('Your Health ID card was opened');
    expect(openedContent.text).toContain('Someone opened your Health ID card (reference K7P2-QX9M) using the link you '
      + 'sent, on 4 Nov 2026, 10:42 (Lagos time).');
    expect(openedContent.text).toContain('If you didn\'t expect this, sign in to Health ID and end the link in Access '
      + 'and sharing.');
    const createdContent = cardCreatedContent({ reference: 'K7P2-QX9M', recipientHint: 'k•••@example.test',
      expiresAt: new Date(created.expiresAt), linkEmailed: true });
    expect(createdContent.subject).toBe('You sent your Health ID card');
    expect(createdContent.text).toContain('You sent your Health ID card to k•••@example.test (reference K7P2-QX9M). '
      + 'The link works until 5 Nov 2026, 10:04 (Lagos time), or until you end it.');
    expect(createdContent.text).toContain('If this wasn\'t you, sign in to Health ID, end the link in Access and '
      + 'sharing, and change your password.');
    // A link that was not emailed (a blocked or capped address, or a failed send) is still a security notice,
    // worded as what happened (F6).
    const notSent = cardCreatedContent({ reference: 'K7P2-QX9M', recipientHint: 'k•••@example.test',
      expiresAt: new Date(created.expiresAt), linkEmailed: false });
    expect(notSent.subject).toBe('Someone tried to send your Health ID card');
    expect(notSent.text).toContain('Someone signed in to your Health ID tried to send your card to k•••@example.test '
      + '(reference K7P2-QX9M). We couldn\'t email it, so nobody can open it.');
    expect(notSent.text).toContain('If this wasn\'t you, sign in to Health ID and change your password.');
    expect(notSent.text).not.toMatch(/You sent your Health ID card|The link works until/);
    for (const content of [openedContent, createdContent, notSent]) {
      expect(`${content.text}${content.html ?? ''}`).not.toMatch(/https?:\/\/|\/card#|HID-|blood|genotype|allerg/i);
    }
  });

  it('the four routes send by email with their idempotency keys; E5 builds the link here, on this deployment', async () => {
    const email = provider('ses');
    const routes = controller(email);
    await routes.cardShareLink(link, request, 'card-share:5e1a0000-0000-4000-8000-000000000001');
    await routes.cardShareCode(code, request, 'card-share-code:6c0d0000-0000-4000-8000-000000000001');
    await routes.cardShareOpened(opened, request, 'card-share-email:7e0e0000-0000-4000-8000-000000000001');
    await routes.cardShareCreated(created, request, 'card-share-email:7e0e0000-0000-4000-8000-000000000002');
    const sent = (email.send as jest.Mock).mock.calls.map(([message]) => message as { purpose: string; channel: string;
      recipient: string; idempotencyKey: string; code: string; content: { subject: string; text: string; html?: string } });
    expect(sent.map((message) => [message.purpose, message.channel, message.idempotencyKey])).toEqual([
      ['CARD_SHARE_LINK', 'email', 'card-share:5e1a0000-0000-4000-8000-000000000001'],
      ['CARD_SHARE_CODE', 'email', 'card-share-code:6c0d0000-0000-4000-8000-000000000001'],
      ['CARD_SHARE_OPENED', 'email', 'card-share-email:7e0e0000-0000-4000-8000-000000000001'],
      ['CARD_SHARE_CREATED', 'email', 'card-share-email:7e0e0000-0000-4000-8000-000000000002'],
    ]);
    expect(sent[0]?.content.text).toContain(`${origin}/card#${token}\n`);
    expect(sent[3]?.content.subject).toBe('You sent your Health ID card');
    await routes.cardShareCreated({ ...created, linkEmailed: false }, request,
      'card-share-email:7e0e0000-0000-4000-8000-000000000003');
    expect((email.send as jest.Mock).mock.calls[4][0].content.subject).toBe('Someone tried to send your Health ID card');
    // The OTP slot stays empty: nothing but the rendered content is sent.
    expect(sent.every((message) => message.code === '')).toBe(true);
    process.env.HID_DEPLOYMENT_ENV = 'staging';
    resetEnvironmentForTests();
    const staging = provider('ses');
    await controller(staging).cardShareLink(link, request, 'card-share:5e1a0000-0000-4000-8000-000000000001');
    expect(String((staging.send as jest.Mock).mock.calls[0][0].content.text))
      .toContain(`https://staging.healthidentitydirectory.com/card#${token}`);
  });

  it('answers 404 on all four routes while CARD_LINKS_ENABLED is false, and sends nothing', async () => {
    process.env.CARD_LINKS_ENABLED = 'false';
    resetEnvironmentForTests();
    const email = provider('ses');
    const routes = controller(email);
    await expect(routes.cardShareLink(link, request, 'card-share:5e1a0000-0000-4000-8000-000000000001'))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(routes.cardShareCode(code, request, 'card-share-code:6c0d0000-0000-4000-8000-000000000001'))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(routes.cardShareOpened(opened, request, 'card-share-email:7e0e0000-0000-4000-8000-000000000001'))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(routes.cardShareCreated(created, request, 'card-share-email:7e0e0000-0000-4000-8000-000000000002'))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('sends while CARD_LINKS_ENABLED is unset (on by default since the owner\'s decision of 4 Nov 2026)', async () => {
    delete process.env.CARD_LINKS_ENABLED;
    resetEnvironmentForTests();
    const email = provider('ses');
    await controller(email).cardShareLink(link, request, 'card-share:5e1a0000-0000-4000-8000-000000000001');
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it('the DTOs take fixed fields only: unknown fields, a name, a malformed token, code or reference are refused', async () => {
    const check = (value: object, metatype: new () => object) => pipe.transform(value, { type: 'body', metatype });
    await expect(check(link, DeliverCardLinkDto)).resolves.toBeDefined();
    await expect(check(code, DeliverCardCodeDto)).resolves.toBeDefined();
    await expect(check(opened, DeliverCardOpenedDto)).resolves.toBeDefined();
    await expect(check(created, DeliverCardCreatedDto)).resolves.toBeDefined();
    for (const [value, metatype] of [
      [{ ...link, patientName: 'Ada' }, DeliverCardLinkDto],
      [{ ...link, label: 'My doctor' }, DeliverCardLinkDto],
      [{ ...link, code: '482913' }, DeliverCardLinkDto],
      [{ ...link, token: `${token}=` }, DeliverCardLinkDto],
      [{ ...link, token: 'short' }, DeliverCardLinkDto],
      [{ ...link, reference: 'K7P2QX9M' }, DeliverCardLinkDto],
      [{ ...link, reference: 'K7P2-QX9O' }, DeliverCardLinkDto],
      [{ ...link, stopToken: 'not-a-stop-token' }, DeliverCardLinkDto],
      [{ ...code, token }, DeliverCardCodeDto],
      [{ ...code, code: '48291' }, DeliverCardCodeDto],
      [{ ...code, code: '48291a' }, DeliverCardCodeDto],
      [{ ...opened, healthId: 'HID-ABC234' }, DeliverCardOpenedDto],
      [{ ...opened, openedAt: 'today' }, DeliverCardOpenedDto],
      [{ ...created, recipientHint: 'kemi.doctor@example.test' }, DeliverCardCreatedDto],
      [{ ...created, recipient: 42 }, DeliverCardCreatedDto],
      [{ ...created, linkEmailed: undefined }, DeliverCardCreatedDto],
      [{ ...created, linkEmailed: 'yes' }, DeliverCardCreatedDto],
    ] as Array<[object, new () => object]>) {
      await expect(check(value, metatype)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('refuses a phone recipient and a missing key', async () => {
    const email = provider('ses');
    await expect(controller(email).cardShareCode({ ...code, recipient: '+2348012345678' }, request,
      'card-share-code:6c0d0000-0000-4000-8000-000000000001')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller(email).cardShareCode(code, request, undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('E5 and E6 go out as plain text, so no provider can rewrite the link for click tracking (Brevo request body)', async () => {
    const transport = jest.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: '1' }), { status: 201 }));
    const brevo = new BrevoFallbackProvider({ BREVO_API_KEY: 'synthetic', BREVO_EMAIL_FROM: 'no-reply@example.test',
      NOTIFICATION_PROVIDER_TIMEOUT_MS: 5000 } as never, transport as unknown as typeof fetch);
    await brevo.send({ channel: 'email', recipient: link.recipient, code: '', purpose: 'CARD_SHARE_LINK',
      idempotencyKey: 'card-share:5e1a0000-0000-4000-8000-000000000001',
      content: cardLinkContent({ token, reference: 'K7P2-QX9M', expiresAt: new Date(link.expiresAt), stopToken, origin }) });
    const body = JSON.parse(String(transport.mock.calls[0][1].body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('htmlContent');
    expect(body.textContent).toContain(`${origin}/card#${token}`);
  });
});

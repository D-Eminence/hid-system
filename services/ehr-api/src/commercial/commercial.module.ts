import { Module } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { CommercialController } from './commercial.controller';
import { COMMERCIAL_SWITCHES, CommercialService } from './commercial.service';
import { noPaystackSecrets, OnlinePaymentService, PAYSTACK_FETCH, PAYSTACK_SECRETS } from './online-payment.service';

/**
 * BILL-1 (0162-0167): patient billing release 1. Every route answers 404
 * BILLING_NOT_AVAILABLE at a real facility while COMMERCIAL_BILLING_ENABLED is
 * false (the production default until go-live); the sealed QA and demo
 * facilities have it on (owner sprint approval, 25 November 2026).
 */
@Module({
  controllers: [CommercialController],
  providers: [
    CommercialService,
    OnlinePaymentService,
    {
      provide: COMMERCIAL_SWITCHES,
      useFactory: () => {
        const environment = getEnvironment();
        return {
          billingEnabled: environment.COMMERCIAL_BILLING_ENABLED,
          payBeforeAvailable: environment.COMMERCIAL_PAY_BEFORE_ENABLED,
          onlineAvailable: environment.COMMERCIAL_ONLINE_PAYMENT_ENABLED,
        };
      },
    },
    { provide: PAYSTACK_SECRETS, useValue: noPaystackSecrets },
    { provide: PAYSTACK_FETCH, useValue: (url: string, init: RequestInit) => fetch(url, init) },
  ],
})
export class CommercialModule {}

import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsUUID, Max, Min, ValidateNested,
} from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

/** ORD-11: at most this many notices on a page (20 when not given). */
export const ORDER_NOTICES_PAGE_MAX = 50;
/** ORD-11: at most this many notices marked read in one call. */
export const ORDER_NOTICES_READ_MAX = 100;

/**
 * ORD-11: GET /ehr/me/order-notices's query. `state` is required: `unread`
 * (unread notices and critical ones not Seen) or `all`. `cursor` is the last
 * notice id of the page before.
 */
export class ListOrderNoticesQueryDto {
  @IsIn(['unread', 'all'])
  state!: 'unread' | 'all';

  @IsOptionalButNotNull()
  @IsUUID()
  cursor?: string;

  @IsOptionalButNotNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ORDER_NOTICES_PAGE_MAX)
  limit = 20;
}

/** A pair's notice id in lower case, for the each-notice-once check; anything else as it is. */
function noticeKey(pair: unknown): unknown {
  const noticeId = typeof pair === 'object' && pair !== null ? (pair as { noticeId?: unknown }).noticeId : undefined;
  return typeof noticeId === 'string' ? noticeId.toLowerCase() : pair;
}

/** One notice to mark read, at the version the screen showed. */
export class OrderNoticeVersionDto {
  @IsUUID()
  noticeId!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  version!: number;
}

/**
 * ORD-11: POST /ehr/me/order-notices/read's body, `{ notices: [{ noticeId,
 * version }] }`: 1-100 pairs, each notice once. Exactly these fields; a
 * number must be sent as a number.
 */
export class MarkOrderNoticesReadDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ORDER_NOTICES_READ_MAX)
  @ArrayUnique((pair: unknown) => noticeKey(pair), { message: 'notices must name each notice once' })
  @ValidateNested({ each: true })
  @Type(() => OrderNoticeVersionDto)
  notices!: OrderNoticeVersionDto[];
}

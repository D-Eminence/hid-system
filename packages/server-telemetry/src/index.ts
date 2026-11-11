export { scrubEvent, relativeFilename, ALLOWED_TAGS } from './scrub';
export {
  initErrorReporting,
  captureServerError,
  flushErrorReporting,
  isErrorReportingEnabled,
  buildSentryOptions,
  releaseIdFromImage,
  resolveImageReleaseId,
  resetErrorReportingForTests,
  handleUnhandledRejection,
} from './reporting';
export type { ErrorReportingOptions } from './reporting';
export { ErrorReportingInterceptor, isClientError, routeTemplateOf } from './interceptor';
export type { ExecutionContextLike, ObservableLike } from './interceptor';

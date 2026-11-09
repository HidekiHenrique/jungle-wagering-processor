/**
 * Tells transient infrastructure failures (retry later) from everything else. The rules depend on
 * the database driver, so the implementation lives in infrastructure.
 */
export interface TransientErrorClassifier {
  isTransient(error: unknown): boolean;
}

export const TRANSIENT_ERROR_CLASSIFIER = Symbol('TransientErrorClassifier');
